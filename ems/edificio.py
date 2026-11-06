"""Gemelo digital del edificio: modelo térmico RC por zona, cargas, sensores, actuadores y medidor.

Cada zona se modela como un nodo térmico (1R1C) con los parámetros del modelo E+ (config.zonas):

    C·dT/dt = UA·(Text − T) + UA_suelo·(Tsuelo − T) + G_vent·(Text − T)
              + Q_personas + Q_luces + Q_equipos + Q_solar,ventanas + Q_solar,opaco + Q_ventilador − Q_hvac

con Q en kW, C en kWh/K y t en horas. La ganancia solar usa la irradiancia sobre cada fachada.

HVAC: terminal VRF modulante. Con el termostato local, la capacidad sigue el error de temperatura
dentro de la banda (sp ± banda) y el terminal hace on/off con histéresis: enciende sobre sp + banda y
apaga bajo sp − banda (a carga baja cicla). El EMS puede fijar la modulación (`hvac_mod`, MPC y
limitador de demanda). La potencia eléctrica es capacidad × modulación / COP estacional del sistema
VRF (calibrado con la simulación de E+), más el ventilador del terminal: continuo (línea base, como
en E+) o sólo cuando hay ocupación o compresor (EMS).
Los sensores agregan ruido y pueden fallar (congelado, ruidoso, fuera de rango, deriva).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import eventos as m_ev
from .config import RHO_CP, Zona, horario, zonas
from .eventos import Evento

Q_PERSONA_KW = 0.075        # calor sensible por persona (actividad 120 W, schedule "Cargas" de E+)
Q_PERSONA_LAT_KW = 0.045    # calor latente por persona
W_INTERIOR = 0.0105         # humedad absoluta interior de diseño (≈ 24 °C, 55 %) kg/kg
H_FG = 2501.0               # kJ/kg
LUX_ARTIFICIAL = 500.0      # lux con luces al 100 %
EFICACIA_LUZ_DIA = 110.0    # lm/W de la radiación solar
PLR_MIN = 0.15              # carga parcial mínima del terminal VRF antes de ciclar
BANDA_PROPORCIONAL_C = 2.0  # el terminal pasa de PLR_MIN a capacidad plena entre sp − banda y sp − banda + 2 K
FP = {"hvac": 0.90, "luces": 0.95, "equipos": 0.92, "it": 0.97}

ACTUADORES = ("setpoint_c", "hvac_enable", "luces_nivel", "equipos_nivel", "hvac_mod", "ventilacion")


@dataclass
class EstadoZona:
    t: float                          # temperatura real (°C)
    setpoint_c: float = 24.0
    hvac_enable: bool = True
    luces_nivel: float = 1.0
    equipos_nivel: float = 1.0
    hvac_mod: float | None = None     # None = termostato local
    ventilacion: str = "dcv"          # "fija" (ventilador continuo + aire exterior de diseño) | "dcv"
    hvac_on: bool = False
    t_medida: float = 0.0
    historial_medida: list = field(default_factory=list)


def humedad_absoluta(t_c: float, hr_pct: float, p_kpa: float = 101.325) -> float:
    psat = 0.61094 * math.exp(17.625 * t_c / (t_c + 243.04))
    pv = max(min(hr_pct, 100.0), 0.0) / 100.0 * psat
    return 0.622 * pv / (p_kpa - pv)


def fraccion_carga(t_medida: float, sp: float, banda: float) -> float:
    """Capacidad pedida por el terminal VRF (ley proporcional), acotada a [PLR_MIN, 1]."""
    return float(min(1.0, max(PLR_MIN, (t_medida - sp + banda) / BANDA_PROPORCIONAL_C)))


def modulacion_termostato(t_medida: float, sp: float, banda: float, encendido: bool) -> tuple[float, bool]:
    """Terminal VRF: on/off con histéresis (enciende sobre sp + banda, apaga bajo sp − banda) y
    capacidad proporcional al error mientras está encendido."""
    if t_medida > sp + banda:
        encendido = True
    elif t_medida < sp - banda:
        encendido = False
    if not encendido:
        return 0.0, False
    return fraccion_carga(t_medida, sp, banda), True


class Edificio:
    def __init__(self, cfg: dict, rng_semilla: int = 3):
        self.cfg = cfg
        self.e = cfg["edificio"]
        self.zonas: list[Zona] = zonas(cfg)
        self.zmap = {z.id: z for z in self.zonas}
        self.banda = cfg["ems"]["banda_histeresis_c"]
        self.paso_h = self.e["paso_min"] / 60.0
        self.rng = np.random.default_rng(rng_semilla)
        self.carga_extra_kw: dict[str, float] = {}
        self.falla_hvac: set[str] = set()
        self.falla_sensor: dict[str, dict] = {}
        self.eventos: dict[str, Evento] = {}
        self._fin_eventos: list[Evento] = []
        self.unidades = {u["id"]: list(u["zonas"]) for u in cfg.get("sistemas_vrf", [])}
        self.e_kwh = 0.0
        self._hist_p: list[float] = []
        self._vt = 0.252  # transmitancia visible del vidrio del modelo
        self.reset()

    # ------------------------------------------------------------------ estado
    def reset(self, t0: float = 25.0):
        self.estado: dict[str, EstadoZona] = {}
        for z in self.zonas:
            t = z.setpoint_fijo if z.setpoint_fijo else t0
            self.estado[z.id] = EstadoZona(t=t, setpoint_c=z.setpoint_fijo or 24.0, t_medida=t)
        self.e_kwh = 0.0
        self._hist_p = []

    def aplicar(self, comandos: dict[str, dict]):
        """Aplica comandos de actuadores. Las zonas críticas no aceptan deslastre."""
        for zid, cmd in (comandos or {}).items():
            if zid not in self.estado:
                continue
            z, s = self.zmap[zid], self.estado[zid]
            for k, v in cmd.items():
                if k not in ACTUADORES or (v is None and k != "hvac_mod"):
                    continue
                if k == "setpoint_c":
                    s.setpoint_c = z.setpoint_fijo if z.setpoint_fijo else float(np.clip(v, 18, 30))
                elif k == "hvac_enable":
                    s.hvac_enable = True if z.critica else bool(v)
                elif k == "luces_nivel":
                    s.luces_nivel = float(np.clip(v, 0, 1))
                elif k == "equipos_nivel":
                    s.equipos_nivel = 1.0 if z.critica else float(np.clip(v, 0, 1))
                elif k == "hvac_mod":
                    s.hvac_mod = None if v is None else float(np.clip(v, 0, 1))
                elif k == "ventilacion":
                    s.ventilacion = "fija" if v == "fija" else "dcv"

    # ---------------------------------------------------------------- sensores
    def _medir(self, zid: str, t_real: float) -> float:
        s = self.estado[zid]
        m = t_real + self.rng.normal(0, 0.08)
        falla = self.falla_sensor.get(zid)
        if falla:
            tipo = falla["tipo"]
            if tipo == "congelado":
                m = falla.setdefault("valor", s.t_medida)
            elif tipo == "ruidoso":
                m = t_real + self.rng.normal(0, falla.get("sigma", 2.0))
            elif tipo == "fuera_rango":
                m = falla.get("valor", 85.0)
            elif tipo == "deriva":
                falla["acum"] = falla.get("acum", 0.0) + falla.get("tasa_c_h", 1.0) * self.paso_h
                m = t_real + falla["acum"]
        return round(float(m), 2)

    # -------------------------------------------------------------------- paso
    # ----------------------------------------------------------------- eventos
    def iniciar_evento(self, d: dict) -> tuple[Evento | None, list[dict], str | None]:
        """Inicia un evento simulado. Devuelve (evento, alarmas de inicio, error)."""
        err = m_ev.validar(d, set(self.estado), set(self.unidades))
        if err:
            return None, [], err
        ev = m_ev.crear(d)
        self.eventos[ev.id] = ev
        if ev.tipo == "sensor":
            self.falla_sensor[ev.zona] = {"tipo": "congelado", "evento": ev.id}
        return ev, m_ev.alarmas_inicio(ev, self.unidades.get(ev.unidad or "")), None

    def terminar_evento(self, ev_id: str):
        ids = list(self.eventos) if ev_id == "*" else [ev_id]
        for i in ids:
            ev = self.eventos.pop(i, None)
            if ev and ev.tipo == "sensor" and self.falla_sensor.get(ev.zona, {}).get("evento") == ev.id:
                self.falla_sensor.pop(ev.zona, None)

    def _efectos(self) -> dict:
        """Efectos agregados de los eventos activos."""
        ef = {"sin_frio": set(), "fuego": {}, "evac": None, "corte": None, "puerta": {}, "dt_ext": 0.0,
              "sobre": {}, "extra_kw": {}}
        for ev in self.eventos.values():
            if ev.tipo == "incendio":
                ef["sin_frio"].update(self.estado)
                ef["fuego"][ev.zona] = ev
                ef["evac"] = max(ef["evac"] or 0.0, ev.transcurrido)
            elif ev.tipo == "corte_energia":
                ef["corte"] = ev
                ef["sin_frio"].update(self.estado)
            elif ev.tipo == "falla_vrf":
                ef["sin_frio"].update(self.unidades.get(ev.unidad, []))
            elif ev.tipo == "falla_terminal":
                ef["sin_frio"].add(ev.zona)
            elif ev.tipo == "puerta_abierta":
                ef["puerta"][ev.zona] = ef["puerta"].get(ev.zona, 0.0) + m_ev.CAUDAL_PUERTA_M3S * (ev.intensidad or 50) / 100
            elif ev.tipo == "ola_calor":
                ef["dt_ext"] += ev.intensidad or 4.0
            elif ev.tipo == "sobreocupacion":
                ef["sobre"][ev.zona] = ef["sobre"].get(ev.zona, 0.0) + (ev.intensidad or 50) / 100
            elif ev.tipo == "pico_carga":
                ef["extra_kw"][ev.zona] = ef["extra_kw"].get(ev.zona, 0.0) + (ev.intensidad or 10)
        return ef

    def _avanzar_eventos(self) -> list[Evento]:
        """Avanza el reloj de los eventos y quita los terminados (los devuelve)."""
        fin = []
        for ev in list(self.eventos.values()):
            ev.transcurrido += self.e["paso_min"]
            if not ev.activo:
                self.terminar_evento(ev.id)
                fin.append(ev)
        return fin

    def paso(self, clima: dict, ocupantes: dict[str, int], minuto_del_dia: int = 0,
             dia_semana: int = 0) -> tuple[list[dict], dict]:
        ef = self._efectos()
        t_ext = clima["t_ext_c"] + ef["dt_ext"]
        ghi = clima["irr_wm2"]
        corte = ef["corte"]
        ups_ok = corte is not None and corte.transcurrido < (corte.intensidad or 30)
        irr = {o: clima.get(f"irr_{o}", ghi * 0.4) for o in ("N", "E", "S", "W")}
        irr["H"] = clima.get("irr_H", ghi)
        hora = minuto_del_dia / 60.0
        w_ext = humedad_absoluta(t_ext, clima.get("hr_pct", 80.0))
        dw = max(w_ext - W_INTERIOR, 0.0)
        t_suelo = self.e["t_suelo_c"]
        f_sol = self.e.get("factor_solar", 1.0)
        v_pers = self.e["ventilacion_m3s_persona"]
        no_crit = [z for z in self.zonas if not z.critica]
        # radiación hacia el cielo: temperatura exterior equivalente para la conducción de la envolvente
        t_eq = t_ext - self.e.get("delta_t_cielo_c", 0.0)
        # temperatura media (por área) de cada planta en el paso anterior, para el acople por el entrepiso
        t_planta = {}
        for pl in (0, 1):
            zs = [z for z in self.zonas if z.planta == pl]
            if zs:
                t_planta[pl] = sum(self.estado[z.id].t * z.area for z in zs) / sum(z.area for z in zs)
        edificio_ocupado = any(ocupantes.get(z.id, 0) > 0 for z in no_crit)

        tel = []
        tot = {"hvac": 0.0, "luces": 0.0, "equipos": 0.0, "it": 0.0}
        q_kvar = 0.0
        p_crit = 0.0
        for z in self.zonas:
            s = self.estado[z.id]
            n = int(ocupantes.get(z.id, 0))
            if z.id in ef["sobre"] and z.ocupantes > 0:
                n = int(round(z.ocupantes * (1 + ef["sobre"][z.id])))
            if ef["evac"] is not None:
                n = int(round(n * max(0.0, 1 - ef["evac"] / m_ev.MIN_EVACUACION)))
            ocupado = n > 0 or (z.tipo == "pasillo" and edificio_ocupado)
            cap = 0.0 if (z.id in self.falla_hvac or z.id in ef["sin_frio"]) else z.hvac_kw
            # la central de incendio / el corte desenergizan el terminal (ventilador incluido)
            sin_energia_hvac = bool(ef["fuego"]) or corte is not None
            cop = z.cop * (1 - 0.012 * (t_ext - 30.0))

            # --- capacidad del terminal VRF
            sp = z.setpoint_fijo or s.setpoint_c
            if not s.hvac_enable:
                mod, s.hvac_on = 0.0, False
            elif s.hvac_mod is not None:
                mod = s.hvac_mod
                s.hvac_on = mod > 0
            else:
                mod, s.hvac_on = modulacion_termostato(s.t_medida, sp, self.banda, s.hvac_on)
            if cap == 0.0:
                mod = 0.0
                if z.id in ef["sin_frio"]:
                    s.hvac_on = False

            # --- ventilador y aire exterior
            if sin_energia_hvac:
                fan_on, g_vent = False, 0.0
            elif not s.hvac_enable:
                fan_on, g_vent = False, 0.0
            elif s.ventilacion == "fija":
                fan_on = True
                g_vent = max(z.ocupantes, 0) * v_pers * RHO_CP
            else:
                fan_on = ocupado or mod > 0
                g_vent = n * v_pers * RHO_CP
            p_fan = z.fan_kw if fan_on else 0.0

            # --- cargas internas (horarios del modelo E+)
            nivel_luces = 1.0 if (ef["fuego"] and corte is None) else s.luces_nivel  # evacuación
            p_luces = z.p_luces_max_kw * nivel_luces
            f_eq = horario(self.cfg, z.horario_equipos, dia_semana, hora)
            p_eq = (z.p_equipos_max_kw * f_eq * max(s.equipos_nivel, z.min_equipos) + self.carga_extra_kw.get(z.id, 0.0)
                    + ef["extra_kw"].get(z.id, 0.0))
            p_it = z.it_kw * (1 + 0.02 * math.sin(minuto_del_dia / 1440 * 2 * math.pi)) if z.it_kw else 0.0
            if corte is not None:
                # sin red: sólo las cargas críticas (UPS) mientras dure su autonomía
                if z.critica and ups_ok:
                    p_luces *= 0.3
                else:
                    p_luces = p_eq = p_it = 0.0
            q_sol = f_sol * z.shgc * sum(a * irr[o] for o, a in z.ventanas.items()) / 1000.0
            q_opaco = sum(k * irr[o] for o, k in z.sol_opaco.items())
            q_int = n * Q_PERSONA_KW + p_luces + p_eq + p_it + p_fan + q_sol + q_opaco
            if z.id in ef["fuego"]:
                q_int += m_ev.CALOR_INCENDIO_KW
            g_puerta = ef["puerta"].get(z.id, 0.0) * RHO_CP
            # latente: personas + humedad del aire exterior (ventilación + infiltración)
            caudal_ext = (g_vent + g_puerta) / RHO_CP + self.e["infiltracion_m3s_m2"] * (sum(z.muros.values()) + z.techo)
            q_lat = n * Q_PERSONA_LAT_KW + 1.2 * caudal_ext * H_FG * dw

            # --- integración térmica (subpasos de 1 min, Euler explícito)
            t_otra = t_planta.get(1 - z.planta, s.t)
            q_hvac_sens = mod * cap
            sub = max(int(self.e["paso_min"]), 1)
            dt = self.paso_h / sub
            t = s.t
            for _ in range(sub):
                dTdt = (z.ua * (t_eq - t) + (z.g_inf + g_vent + g_puerta) * (t_ext - t) + z.ua_suelo * (t_suelo - t)
                        + z.ua_entrepiso * (t_otra - t) + q_int - q_hvac_sens) / z.c
                t += dTdt * dt
            s.t = t
            # el VRF no controla humedad (en E+ la HR interior llega a 90 %+): sólo retira el latente que
            # condensa su serpentín, ≈ fracción del sensible, limitado por la humedad disponible
            q_lat_ret = min(q_lat, self.e.get("fraccion_latente_serpentin", 0.25) * q_hvac_sens) if mod > 0 else 0.0
            p_comp = (q_hvac_sens + q_lat_ret) / max(cop, 1.0)
            p_hvac = p_comp + p_fan

            s.t_medida = self._medir(z.id, s.t)
            lux_dia = EFICACIA_LUZ_DIA * self._vt * 0.25 * sum(a * irr[o] for o, a in z.ventanas.items()) / max(z.area, 1)
            lux = lux_dia + LUX_ARTIFICIAL * s.luces_nivel

            p_zona = p_hvac + p_luces + p_eq + p_it
            tot["hvac"] += p_hvac
            tot["luces"] += p_luces
            tot["equipos"] += p_eq
            tot["it"] += p_it
            q_kvar += sum(p * math.tan(math.acos(FP[k])) for k, p in
                          (("hvac", p_hvac), ("luces", p_luces), ("equipos", p_eq), ("it", p_it)))
            if z.critica:
                p_crit += p_zona
            tel.append({
                "zona": z.id, "nombre": z.nombre, "tipo": z.tipo, "critica": z.critica,
                "temp_c": s.t_medida, "temp_real_c": round(s.t, 3), "setpoint_c": sp,
                "ocupantes": n, "ocupado": bool(ocupado), "lux": round(lux, 0),
                "luces_nivel": round(s.luces_nivel, 3), "equipos_nivel": round(s.equipos_nivel, 3),
                "hvac_on": bool(s.hvac_on), "hvac_enable": bool(s.hvac_enable),
                "hvac_mod": round(mod, 3), "q_frio_kw": round(q_hvac_sens + q_lat_ret, 3),
                "p_luces_kw": round(p_luces, 3), "p_equipos_kw": round(p_eq + p_it, 3),
                "p_hvac_kw": round(p_hvac, 3), "p_ventilador_kw": round(p_fan, 3), "p_total_kw": round(p_zona, 3),
            })

        p_fija = 0.0
        for cf in self.cfg.get("cargas_fijas") or []:
            f_edif = sum(ocupantes.get(z.id, 0) for z in no_crit) / max(sum(z.ocupantes for z in no_crit), 1)
            if "kw_noche" in cf:
                p = cf["kw_noche"] if ghi < 5 else 0.0
            else:
                p = cf["kw_desocupado"] + (cf["kw_ocupado"] - cf["kw_desocupado"]) * min(f_edif * 1.5, 1.0)
            p_fija += p
            q_kvar += p * math.tan(math.acos(cf.get("fp", 0.9)))
            if cf.get("critica"):
                p_crit += p

        p_edificio = sum(tot.values()) + p_fija
        # durante un corte el medidor de la acometida lee cero; el UPS alimenta las cargas críticas
        p_total = 0.0 if corte is not None else p_edificio
        if corte is not None:
            q_kvar = 0.0
        s_kva = math.hypot(p_total, q_kvar)
        self.e_kwh += p_total * self.paso_h
        self._hist_p.append(p_total)
        n15 = max(int(round(15 / self.e["paso_min"])), 1)
        dem15 = float(np.mean(self._hist_p[-n15:]))
        if len(self._hist_p) > 50:
            self._hist_p = self._hist_p[-n15:]
        medidor = {
            "p_total_kw": round(p_total, 3), "p_critica_kw": round(p_crit, 3),
            "p_no_critica_kw": round(p_total - p_crit, 3),
            "p_hvac_kw": round(tot["hvac"], 3), "p_luces_kw": round(tot["luces"], 3),
            "p_equipos_kw": round(tot["equipos"] + tot["it"], 3), "p_fija_kw": round(p_fija, 3),
            "q_kvar": round(q_kvar, 3), "s_kva": round(s_kva, 3), "fp": round(p_total / s_kva, 4) if s_kva else 1.0,
            "v_ll": 0.0 if corte is not None else self.e["v_ll"],
            "i_a": round(s_kva * 1000 / (math.sqrt(3) * self.e["v_ll"]), 2),
            "e_kwh": round(self.e_kwh, 3), "demanda_15min_kw": round(dem15, 3),
            "t_ext_c": round(t_ext, 2), "hr_pct": round(clima.get("hr_pct", 0), 1), "irr_wm2": round(ghi, 1),
            **{f"irr_{o}": round(v, 1) for o, v in irr.items() if o != "H"},
            "red_ok": corte is None,
        }
        if corte is not None:
            medidor["ups_kw"] = round(p_edificio, 3)
            medidor["ups_min"] = round(max(0.0, (corte.intensidad or 30) - corte.transcurrido), 1)
        if self.eventos:
            medidor["eventos"] = sorted({ev.tipo for ev in self.eventos.values()})
        self._fin_eventos = self._avanzar_eventos()
        return tel, medidor
