"""Gemelo digital del edificio: modelo térmico 2R2C por zona, cargas, sensores, actuadores y medidor.

Cada zona tiene dos nodos térmicos (ISO 13790 simplificado) con los parámetros del modelo E+ (config.zonas):

    C_aire·dTa/dt = (UA_vidrio + G_vent + G_inf)·(Text − Ta) + H_am·(Tm − Ta) + Q_convectivo − Q_hvac
    C_masa·dTm/dt = UA_muro·(Text − ΔT_cielo/2 − Tm) + UA_techo·(Text − ΔT_cielo − Tm) + UA_suelo·(Tsuelo − Tm)
                    + UA_losas·(T_planta_vecina − Tm) + H_am·(Ta − Tm) + Q_radiante + Q_solar,opaco

con Q en kW, C en kWh/K y t en horas. El aire (rápido) recibe el HVAC, la ventilación y la parte convectiva de
las ganancias; la masa (lenta: losas y muros) recibe la conducción de los opacos y la parte radiante del sol y
de las ganancias. Con el aire apagado la zona sigue al clima exterior con el retraso de la masa (sube de día,
baja de noche), y al arrancar el aire la temperatura baja de forma gradual.

HVAC: terminal VRF modulante. Con el termostato local, la capacidad sigue el error de temperatura
dentro de la banda (sp ± banda) y el terminal hace on/off con histéresis: enciende sobre sp + banda y
apaga bajo sp − banda (a carga baja cicla). El EMS puede fijar la modulación (`hvac_mod`, MPC y
limitador de demanda). El compresor (inverter) sigue la modulación pedida con una rampa de subida (`rampa_compresor_por_min`): la
potencia nunca sube de golpe. La potencia eléctrica es capacidad × modulación / COP estacional del sistema
VRF (calibrado con la simulación de E+), más el ventilador del terminal: continuo (línea base, como
en E+) o sólo cuando hay ocupación o compresor (EMS).
Los sensores agregan ruido y pueden fallar (congelado, ruidoso, fuera de rango, deriva).

Controladores (ems/controladores.py): el operador puede ajustar cada unidad VRF/PTAC (encendido, modo,
límite de capacidad, setpoint local, factor de COP) y forzar los datos del sensor de una zona (temperatura,
HR, presencia, congelado). El forzado de sensor sólo cambia lo que lee el controlador (termostato local y
EMS); la física sigue con el estado real. La humedad de cada zona se integra con un balance de vapor
(ventilación + infiltración, latente de las personas, condensado del serpentín) sólo para informar la HR.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from . import controladores as m_ctl
from . import eventos as m_ev
from .config import RHO_CP, Zona, fv_habilitada, horario, potencia_fv_kw, zonas
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
    t: float                          # temperatura real del aire (°C)
    tm: float | None = None           # temperatura del nodo de masa (losas/muros) (°C)
    mod_real: float = 0.0             # capacidad que entrega el compresor (sigue al pedido con rampa)
    setpoint_c: float = 24.0
    hvac_enable: bool = True
    luces_nivel: float = 1.0
    equipos_nivel: float = 1.0
    hvac_mod: float | None = None     # None = termostato local
    ventilacion: str = "dcv"          # "fija" (ventilador continuo + aire exterior de diseño) | "dcv"
    hvac_on: bool = False
    t_medida: float = 0.0
    historial_medida: list = field(default_factory=list)
    w: float = W_INTERIOR             # humedad absoluta real del aire de la zona (kg/kg)
    hr_medida: float = 55.0
    ocupado_medido: bool = False


def humedad_absoluta(t_c: float, hr_pct: float, p_kpa: float = 101.325) -> float:
    psat = 0.61094 * math.exp(17.625 * t_c / (t_c + 243.04))
    pv = max(min(hr_pct, 100.0), 0.0) / 100.0 * psat
    return 0.622 * pv / (p_kpa - pv)


def humedad_relativa(t_c: float, w: float, p_kpa: float = 101.325) -> float:
    psat = 0.61094 * math.exp(17.625 * t_c / (t_c + 243.04))
    pv = w * p_kpa / (0.622 + w)
    return float(min(max(100.0 * pv / psat, 0.0), 100.0))


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
        # personas forzadas por el operador: {zona | "*": {"personas" | "porcentaje", "restante_min"}}
        self.ocupacion_forzada: dict[str, dict] = {}
        self._fin_eventos: list[Evento] = []
        self.unidades = {u["id"]: list(u["zonas"]) for u in cfg.get("sistemas_vrf", [])}
        self.sistemas = {u["id"]: u for u in cfg.get("sistemas_vrf", [])}
        self.unidad_de = {z: uid for uid, zs in self.unidades.items() for z in zs}
        self.criticas = {z.id for z in self.zonas if z.critica}
        # ajustes del operador (ems/controladores.py): {unidad: ajuste} y {zona: forzado del sensor}
        self.ajustes_unidad: dict[str, dict] = {}
        self.sensor_forzado: dict[str, dict] = {}
        self._estado_unidades: list[dict] = []
        self._lecturas: dict[str, dict] = {}
        self.fin_ajustes: list[str] = []
        # ruido de HR y de los valores forzados: generador aparte para no alterar la secuencia del gemelo
        self.rng_sensor = np.random.default_rng(rng_semilla + 1000)
        self.fv = fv_habilitada(cfg)
        self.e_kwh = 0.0
        self.e_fv_kwh = 0.0
        self._hist_p: list[float] = []
        self._vt = self.e.get("vt", 0.252)  # transmitancia visible del vidrio del modelo
        # planta de respaldo (generador + UPS): ver docs/PLANTA_RESPALDO.md
        self.resp = cfg.get("respaldo") or {}
        self.gen = self.resp.get("generador") or {}
        self.ptac = {z for uid, zs in self.unidades.items() if self.sistemas[uid].get("tipo") == "ptac" for z in zs}
        self.combustible_l = float(self.gen.get("tanque_l", 0.0))
        self.e_gen_kwh = 0.0
        self._sis_on: dict[str, bool] = {}   # unidades con el compresor en marcha en el paso anterior
        self.reset()

    # ------------------------------------------------------------------ estado
    def reset(self, t0: float = 25.0):
        self.estado: dict[str, EstadoZona] = {}
        for z in self.zonas:
            t = z.setpoint_fijo if z.setpoint_fijo else t0
            self.estado[z.id] = EstadoZona(t=t, tm=t, setpoint_c=z.setpoint_fijo or 24.0, t_medida=t)
        self.e_kwh = 0.0
        self.e_fv_kwh = 0.0
        self._hist_p = []

    # ------------------------------------------------------- persistencia (live)
    _CAMPOS_ESTADO = ("t", "tm", "mod_real", "setpoint_c", "hvac_enable", "luces_nivel", "equipos_nivel", "hvac_mod", "ventilacion",
                      "hvac_on", "t_medida", "w", "hr_medida", "ocupado_medido")

    def exportar_estado(self) -> dict:
        """Estado físico mínimo para continuar tras un reinicio sin arrancar «en frío»."""
        return {"zonas": {zid: {k: v for k, v in asdict(s).items() if k in self._CAMPOS_ESTADO}
                          for zid, s in self.estado.items()},
                "e_kwh": self.e_kwh, "e_fv_kwh": self.e_fv_kwh, "hist_p": self._hist_p[-12:],
                "combustible_l": self.combustible_l, "e_gen_kwh": self.e_gen_kwh}

    def restaurar_estado(self, d: dict) -> int:
        """Restaura lo exportado con `exportar_estado`; ignora zonas o campos desconocidos. Devuelve zonas restauradas."""
        n = 0
        for zid, campos in (d.get("zonas") or {}).items():
            s = self.estado.get(zid)
            if s is None:
                continue
            for k, v in campos.items():
                if k in self._CAMPOS_ESTADO:
                    setattr(s, k, v)
            if s.tm is None or "tm" not in campos:  # estado guardado por una versión de un solo nodo
                s.tm = s.t
            n += 1
        self.e_kwh = float(d.get("e_kwh", self.e_kwh))
        self.e_fv_kwh = float(d.get("e_fv_kwh", self.e_fv_kwh))
        self.combustible_l = float(d.get("combustible_l", self.combustible_l))
        self.e_gen_kwh = float(d.get("e_gen_kwh", self.e_gen_kwh))
        self._hist_p = [float(x) for x in d.get("hist_p", [])][-12:]
        return n

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
        fz = self.sensor_forzado.get(zid)
        if fz:
            if fz.get("congelado"):
                m = fz.setdefault("t_congelada", s.t_medida)
            elif "temp_c" in fz:
                m = fz["temp_c"] + self.rng_sensor.normal(0, 0.08)
            elif "temp_offset_c" in fz:
                m += fz["temp_offset_c"]
        return round(float(m), 2)

    def _medir_hr(self, zid: str, hr_real: float) -> float:
        s = self.estado[zid]
        m = hr_real + self.rng_sensor.normal(0, 0.5)
        fz = self.sensor_forzado.get(zid)
        if fz:
            if fz.get("congelado"):
                m = fz.setdefault("hr_congelada", s.hr_medida)
            elif "hr_pct" in fz:
                m = fz["hr_pct"] + self.rng_sensor.normal(0, 0.3)
        return round(float(min(max(m, 0.0), 100.0)), 1)

    def _detectar_presencia(self, zid: str, ocupado: bool) -> bool:
        s = self.estado[zid]
        fz = self.sensor_forzado.get(zid)
        if fz:
            if fz.get("congelado"):
                return bool(fz.setdefault("ocupado_congelado", s.ocupado_medido))
            if "presencia" in fz:
                return bool(fz["presencia"])
        return bool(ocupado)

    # ------------------------------------------------------------ controladores
    def ajustar_unidad(self, d: dict) -> tuple[list[dict], str | None]:
        """Ajuste del operador sobre una unidad VRF/PTAC (o `liberar`). Devuelve (alarmas, error)."""
        aj, err = m_ctl.validar_unidad(d, self.unidades, self.criticas)
        if err:
            return [], err
        uid = d.get("unidad")
        if aj is None:
            if uid == "*":
                self.ajustes_unidad.clear()
            else:
                self.ajustes_unidad.pop(uid, None)
            return [], None
        self.ajustes_unidad[uid] = aj
        if not aj["critica"]:
            return [], None
        zc = ", ".join(z for z in self.unidades[uid] if z in self.criticas)
        return [{"nivel": "warn", "codigo": "AJUSTE_CRITICO", "zona": uid,
                 "mensaje": f"Ajuste manual de {uid} (atiende la zona crítica {zc}): {m_ctl.describir_unidad(aj)}"}], None

    def forzar_sensor(self, d: dict) -> tuple[list[dict], str | None]:
        """Fuerza los datos del sensor de una zona (o `liberar`). Devuelve (alarmas, error)."""
        fz, err = m_ctl.validar_sensor(d, set(self.estado), self.criticas)
        if err:
            return [], err
        zid = d.get("zona")
        if fz is None:
            if zid == "*":
                self.sensor_forzado.clear()
            else:
                self.sensor_forzado.pop(zid, None)
            return [], None
        self.sensor_forzado[zid] = fz
        if not fz["critica"]:
            return [], None
        return [{"nivel": "warn", "codigo": "AJUSTE_CRITICO", "zona": zid,
                 "mensaje": f"Sensor de la zona crítica {zid} forzado: {m_ctl.describir_sensor(fz)}"}], None

    def estado_controladores(self) -> dict:
        """Estado de las unidades y de los sensores forzados (tópico sim/controladores)."""
        sensores = []
        for zid, fz in self.sensor_forzado.items():
            lec = self._lecturas.get(zid, {})
            sensores.append({"zona": zid, **lec,
                             "forzado": {k: fz[k] for k in m_ctl.CAMPOS_SENSOR if k in fz},
                             "restante_min": fz.get("restante_min"), "usuario": fz.get("usuario", "")})
        return {"unidades": self._estado_unidades, "sensores": sensores}

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
            if ev and ev.tipo == "corte_energia":
                # vuelve la red: retransferencia y repostaje del tanque de la planta
                self.combustible_l = float(self.gen.get("tanque_l", 0.0))
            if ev and ev.tipo == "sensor" and self.falla_sensor.get(ev.zona, {}).get("evento") == ev.id:
                self.falla_sensor.pop(ev.zona, None)

    def fijar_ocupacion(self, d: dict) -> str | None:
        """Fija las personas de una zona o el % del horario de todo el edificio ('*'). Devuelve el error."""
        zona = d.get("zona")
        if d.get("liberar"):
            if zona == "*":
                self.ocupacion_forzada.pop("*", None)
            elif zona in self.ocupacion_forzada:
                self.ocupacion_forzada.pop(zona)
            return None
        dur = d.get("duracion_min", 60)
        if not isinstance(dur, (int, float)) or not 0 < dur <= 7 * 24 * 60:
            return "duración inválida"
        if zona == "*":
            pct = d.get("porcentaje")
            if not isinstance(pct, (int, float)) or not 0 <= pct <= 200:
                return "porcentaje fuera de rango (0–200)"
            self.ocupacion_forzada["*"] = {"porcentaje": float(pct), "restante_min": float(dur)}
            return None
        z = self.zmap.get(zona)
        if z is None or z.ocupantes <= 0:
            return f"zona sin personas o inválida: {zona}"
        n = d.get("personas")
        if not isinstance(n, int) or not 0 <= n <= 2 * z.ocupantes:
            return f"personas entre 0 y {2 * z.ocupantes}"
        self.ocupacion_forzada[zona] = {"personas": n, "restante_min": float(dur)}
        return None

    def _ocupantes(self, z: Zona, n_horario: int) -> int:
        f = self.ocupacion_forzada.get(z.id)
        if f is not None and z.ocupantes > 0:
            return int(f["personas"])
        g = self.ocupacion_forzada.get("*")
        return int(round(n_horario * g["porcentaje"] / 100)) if g else n_horario

    def _efectos(self) -> dict:
        """Efectos agregados de los eventos activos."""
        ef = {"sin_frio": set(), "fuego": {}, "evac": None, "corte": None, "falla_gen": False, "puerta": {}, "dt_ext": 0.0,
              "sobre": {}, "extra_kw": {}}
        for ev in self.eventos.values():
            if ev.tipo == "incendio":
                ef["sin_frio"].update(self.estado)
                ef["fuego"][ev.zona] = ev
                ef["evac"] = max(ef["evac"] or 0.0, ev.transcurrido)
            elif ev.tipo == "corte_energia":
                ef["corte"] = ev
            elif ev.tipo == "falla_generador":
                ef["falla_gen"] = True
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
        # corte de red: con la planta de respaldo en marcha sólo quedan sin frío los equipos fuera del tablero
        # de emergencia (PTAC de los baños); sin planta (falla o sin combustible), todo el edificio
        ef["gen"] = bool(ef["corte"] is not None and self.gen.get("habilitado") and not ef["falla_gen"]
                         and self.combustible_l > 0.0)
        if ef["corte"] is not None:
            ef["sin_frio"].update(self.ptac if ef["gen"] else self.estado)
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

    def _modulaciones(self, ef: dict) -> dict[str, tuple]:
        """Modulación de cada terminal: termostato local o comando del EMS, con el controlador local de la
        unidad por encima (apagado, modo, setpoint) y el tope de capacidad repartido entre sus zonas.
        Devuelve {zona: (mod, capacidad_kw, setpoint, modo, habilitado)}."""
        pre = {}
        for z in self.zonas:
            s = self.estado[z.id]
            aj = self.ajustes_unidad.get(self.unidad_de.get(z.id, ""))
            cap = 0.0 if (z.id in self.falla_hvac or z.id in ef["sin_frio"]) else z.hvac_kw
            sp = z.setpoint_fijo or s.setpoint_c
            enable, hvac_mod, modo = s.hvac_enable, s.hvac_mod, "auto"
            if aj:
                if aj.get("setpoint_c") is not None:
                    sp = aj["setpoint_c"]
                modo = "apagado" if aj.get("encendido") is False else aj.get("modo", "auto")
                if modo == "frio":
                    # el controlador local ignora la habilitación y el deslastre del EMS
                    enable, hvac_mod = True, None
                elif modo in ("apagado", "ventilacion"):
                    cap = 0.0
            if modo in ("apagado", "ventilacion") or not enable:
                mod, s.hvac_on = 0.0, False
            elif hvac_mod is not None:
                mod = hvac_mod
                s.hvac_on = mod > 0
            else:
                mod, s.hvac_on = modulacion_termostato(s.t_medida, sp, self.banda, s.hvac_on)
            if cap == 0.0:
                mod = 0.0
                if z.id in ef["sin_frio"]:
                    s.hvac_on = False
            pre[z.id] = (mod, cap, sp, modo, enable)
        for uid, aj in self.ajustes_unidad.items():
            pct = aj.get("capacidad_pct")
            if pct is None:
                continue
            zs = self.unidades[uid]
            pedido = sum(pre[z][0] * pre[z][1] for z in zs)
            tope = pct / 100.0 * self.sistemas[uid]["capacidad_kw"]
            if pedido > tope:
                f = tope / pedido
                for z in zs:
                    mod, *resto = pre[z]
                    pre[z] = (mod * f, *resto)
                    if mod * f <= 0:
                        self.estado[z].hvac_on = False
        return pre

    def _lineas(self, p_lin: list[float], q_lin: list[float], energizado: bool) -> dict:
        """Corriente y tensión de cada línea (L1, L2, L3) y desbalance de corriente (NEMA: máx. desviación / media)."""
        v_ln_nom = self.e["v_ll"] / math.sqrt(3)
        out = {}
        corr = []
        for k in range(3):
            s_k = math.hypot(p_lin[k], q_lin[k]) if energizado else 0.0
            i_k = s_k * 1000.0 / v_ln_nom
            # caída de tensión del alimentador: ≈ 3 % a 300 A
            v_k = v_ln_nom * (1.0 - 0.03 * min(i_k / 300.0, 1.5)) if energizado else 0.0
            corr.append(i_k)
            out[f"i_l{k + 1}_a"] = round(i_k, 2)
            out[f"v_l{k + 1}_v"] = round(v_k, 1)
            out[f"p_l{k + 1}_kw"] = round(p_lin[k] if energizado else 0.0, 3)
        media = sum(corr) / 3.0
        out["desbalance_pct"] = round(100.0 * max(abs(i - media) for i in corr) / media, 2) if media > 1e-6 else 0.0
        return out

    def _actualizar_unidades(self, acum: dict, corte: bool):
        fallas = {ev.unidad for ev in self.eventos.values() if ev.tipo == "falla_vrf"}
        out = []
        for uid, zs in self.unidades.items():
            sis = self.sistemas[uid]
            aj = self.ajustes_unidad.get(uid) or {}
            a = acum[uid]
            modo = "apagado" if aj.get("encendido") is False else aj.get("modo", "auto")
            out.append({
                "unidad": uid, "tipo": sis.get("tipo", "vrf"), "zonas": list(zs),
                "capacidad_kw": sis["capacidad_kw"],
                "p_kw": round(a["p_kw"], 3), "q_frio_kw": round(a["q_frio_kw"], 3),
                "carga_pct": round(100.0 * a["q_frio_kw"] / sis["capacidad_kw"], 1),
                "cop": round(a["q_frio_kw"] / a["p_comp_kw"], 3) if a["p_comp_kw"] > 1e-6 else None,
                "modo": modo, "encendido": modo != "apagado",
                "capacidad_pct": aj.get("capacidad_pct", 100.0), "setpoint_c": aj.get("setpoint_c"),
                "cop_factor": aj.get("cop_factor", 1.0),
                "forzado": bool(aj), "restante_min": aj.get("restante_min"), "usuario": aj.get("usuario", ""),
                "falla": uid in fallas, "sin_energia": corte,
            })
        self._estado_unidades = out

    def paso(self, clima: dict, ocupantes: dict[str, int], minuto_del_dia: int = 0,
             dia_semana: int = 0) -> tuple[list[dict], dict]:
        ef = self._efectos()
        t_ext = clima["t_ext_c"] + ef["dt_ext"]
        ghi = clima["irr_wm2"]
        corte = ef["corte"]
        gen_on = ef["gen"]                       # planta de respaldo alimentando el tablero de emergencia
        ups_min = float((self.resp.get("ups") or {}).get("autonomia_min", 0) or (corte.intensidad if corte else 30) or 30)
        ups_ok = corte is not None and (gen_on or corte.transcurrido < ups_min)
        if corte is not None and corte.transcurrido == 0:
            # transferencia: los compresores se desconectan y vuelven a tomar carga en rampa
            for s0 in self.estado.values():
                s0.mod_real = 0.0
        irr = {o: clima.get(f"irr_{o}", ghi * 0.4) for o in ("N", "E", "S", "W")}
        irr["H"] = clima.get("irr_H", ghi)
        hora = minuto_del_dia / 60.0
        w_ext = humedad_absoluta(t_ext, clima.get("hr_pct", 80.0))
        dw = max(w_ext - W_INTERIOR, 0.0)
        t_suelo = self.e["t_suelo_c"]
        f_sol = self.e.get("factor_solar", 1.0)
        v_pers = self.e["ventilacion_m3s_persona"]
        no_crit = [z for z in self.zonas if not z.critica]
        # radiación hacia el cielo: temperatura exterior equivalente para la conducción de los opacos
        # (factor de forma al cielo 0.5 en muros verticales y 1 en la cubierta)
        dt_cielo = self.e.get("delta_t_cielo_c", 0.0)
        t_eq_muro = t_ext - 0.5 * dt_cielo
        t_eq_techo = t_ext - dt_cielo
        f_rad = self.e.get("fraccion_radiante", 0.5)
        rampa_comp = self.e.get("rampa_compresor_por_min", 0.1)
        # temperatura media (por área) de cada planta en el paso anterior, para el acople por el entrepiso
        t_planta = {}
        for pl in sorted({z.planta for z in self.zonas}):
            zs = [z for z in self.zonas if z.planta == pl]
            t_planta[pl] = sum(self.estado[z.id].t * z.area for z in zs) / sum(z.area for z in zs)
        edificio_ocupado = any(self._ocupantes(z, int(ocupantes.get(z.id, 0))) > 0 for z in no_crit)

        pre = self._modulaciones(ef)
        acum_u = {uid: {"p_kw": 0.0, "p_comp_kw": 0.0, "q_frio_kw": 0.0} for uid in self.unidades}

        tel = []
        tot = {"hvac": 0.0, "luces": 0.0, "equipos": 0.0, "it": 0.0}
        q_kvar = 0.0
        p_crit = 0.0
        # sistema trifásico de 4 hilos: potencia activa y reactiva por línea (L1, L2, L3). Climatización, ascensor
        # y cargas fijas son trifásicas equilibradas; iluminación y tomacorrientes de cada zona son monofásicos y
        # se reparten entre las líneas (zona i → línea i mod 3); el UPS de los servidores cuelga de L1
        p_lin = [0.0, 0.0, 0.0]
        q_lin = [0.0, 0.0, 0.0]
        tanf = {k: math.tan(math.acos(v)) for k, v in FP.items()}
        for iz, z in enumerate(self.zonas):
            s = self.estado[z.id]
            n = self._ocupantes(z, int(ocupantes.get(z.id, 0)))
            if z.id in ef["sobre"] and z.ocupantes > 0 and z.id not in self.ocupacion_forzada:
                n = int(round(z.ocupantes * (1 + ef["sobre"][z.id])))
            if ef["evac"] is not None:
                n = int(round(n * max(0.0, 1 - ef["evac"] / m_ev.MIN_EVACUACION)))
            ocupado = n > 0 or (z.tipo == "pasillo" and edificio_ocupado)
            # el detector de presencia (que puede estar forzado) decide el ventilador en modo DCV
            ocupado_det = self._detectar_presencia(z.id, ocupado)
            # la central de incendio / el corte desenergizan el terminal (ventilador incluido)
            sin_energia_hvac = bool(ef["fuego"]) or (corte is not None and (not gen_on or z.id in self.ptac))
            uid = self.unidad_de.get(z.id)
            aj = self.ajustes_unidad.get(uid) if uid else None
            cop = z.cop * (1 - 0.012 * (t_ext - 30.0)) * (aj.get("cop_factor", 1.0) if aj else 1.0)

            # --- capacidad del terminal VRF (termostato/EMS + controlador local de la unidad)
            mod, cap, sp, modo, enable = pre[z.id]

            # --- ventilador y aire exterior
            if sin_energia_hvac or modo == "apagado":
                fan_on, g_vent = False, 0.0
            elif modo == "ventilacion":
                fan_on = True
                g_vent = max(z.ocupantes, 0) * v_pers * RHO_CP
            elif not enable:
                fan_on, g_vent = False, 0.0
            elif s.ventilacion == "fija":
                fan_on = True
                g_vent = max(z.ocupantes, 0) * v_pers * RHO_CP
            else:
                fan_on = ocupado_det or mod > 0
                g_vent = n * v_pers * RHO_CP
            p_fan = z.fan_kw if fan_on else 0.0

            # --- cargas internas (horarios del modelo E+)
            nivel_luces = 1.0 if (ef["fuego"] and corte is None) else s.luces_nivel  # evacuación
            p_luces = z.p_luces_max_kw * nivel_luces
            f_eq = horario(self.cfg, z.horario_equipos, dia_semana, hora)
            p_eq = (z.p_equipos_max_kw * f_eq * max(s.equipos_nivel, z.min_equipos) + self.carga_extra_kw.get(z.id, 0.0)
                    + ef["extra_kw"].get(z.id, 0.0))
            p_it = z.it_kw * (1 + 0.02 * math.sin(minuto_del_dia / 1440 * 2 * math.pi)) if z.it_kw else 0.0
            if corte is not None and gen_on:
                # planta de respaldo: iluminación y servidores (UPS en línea); los tomacorrientes de oficina
                # no están en el tablero de emergencia
                if not z.critica:
                    p_eq = 0.0
            elif corte is not None:
                # sin red ni planta: sólo las cargas críticas (UPS) mientras dure su autonomía
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

            # --- integración térmica 2R2C (subpasos de 1 min, Euler explícito)
            # Nodo de aire (rápido): vidrio, ventilación/infiltración, fracción convectiva de las ganancias y
            # el HVAC. Nodo de masa (lento): muros, cubierta, terreno, losas entre plantas, la fracción
            # radiante de las ganancias y el sol sobre los opacos. El aire sigue a la masa con retardo:
            # con los equipos apagados la zona deriva hacia el clima exterior en horas, no de golpe.
            t_arriba = t_planta.get(z.planta + 1, s.t)
            t_abajo = t_planta.get(z.planta - 1, s.t)
            q_rad = f_rad * (q_int - p_fan - q_opaco) + q_opaco
            q_conv = q_int - q_rad
            sub = max(int(self.e["paso_min"]), 1)
            dt = self.paso_h / sub
            t, tm = s.t, (s.t if s.tm is None else s.tm)
            mod_r = s.mod_real if cap > 0 else 0.0
            g_ext = z.ua_vidrio + z.g_inf + g_vent + g_puerta
            sube = rampa_comp * self.e["paso_min"] / sub     # el inverter acelera de forma gradual
            q_hvac_sens = 0.0
            for _ in range(sub):
                mod_r = min(mod, mod_r + sube) if mod > mod_r else mod
                q_h = mod_r * cap
                q_hvac_sens += q_h / sub
                dTm = (z.ua_muro * (t_eq_muro - tm) + z.ua_techo * (t_eq_techo - tm) + z.ua_suelo * (t_suelo - tm)
                       + z.ua_arriba * (t_arriba - tm) + z.ua_abajo * (t_abajo - tm) + z.h_am * (t - tm) + q_rad) / z.c_masa
                # el nodo de aire es rígido (constante de tiempo de minutos): Euler implícito
                k = dt / z.c_aire
                t = (t + k * (g_ext * t_ext + z.h_am * tm + q_conv - q_h)) / (1 + k * (g_ext + z.h_am))
                tm += dTm * dt
            s.t, s.tm, s.mod_real = t, tm, mod_r
            mod = q_hvac_sens / cap if cap > 0 else 0.0
            # el VRF no controla humedad (en E+ la HR interior llega a 90 %+): sólo retira el latente que
            # condensa su serpentín, ≈ fracción del sensible, limitado por la humedad disponible
            q_lat_ret = min(q_lat, self.e.get("fraccion_latente_serpentin", 0.25) * q_hvac_sens) if mod > 0 else 0.0
            p_comp = (q_hvac_sens + q_lat_ret) / max(cop, 1.0)
            p_hvac = p_comp + p_fan
            if uid:
                a = acum_u[uid]
                a["p_kw"] += p_hvac
                a["p_comp_kw"] += p_comp
                a["q_frio_kw"] += q_hvac_sens + q_lat_ret

            # --- humedad real del aire (balance de vapor, solución exacta en el paso)
            m_aire = 1.2 * z.area * self.e.get("altura_piso_m", 3.0)
            mdot = 1.2 * caudal_ext
            fuente = (n * Q_PERSONA_LAT_KW - q_lat_ret) / H_FG
            dt_s = self.paso_h * 3600.0
            if mdot > 1e-6:
                w_eq = w_ext + fuente / mdot
                s.w = w_eq + (s.w - w_eq) * math.exp(-mdot / m_aire * dt_s)
            else:
                s.w += fuente / m_aire * dt_s
            s.w = min(max(s.w, 0.002), humedad_absoluta(s.t, 100.0))
            hr_real = humedad_relativa(s.t, s.w)

            s.t_medida = self._medir(z.id, s.t)
            s.hr_medida = self._medir_hr(z.id, hr_real)
            s.ocupado_medido = ocupado_det
            fz = self.sensor_forzado.get(z.id)
            if fz:
                self._lecturas[z.id] = {"temp_c": s.t_medida, "temp_real_c": round(s.t, 2),
                                        "hr_pct": s.hr_medida, "hr_real_pct": round(hr_real, 1),
                                        "ocupado": ocupado_det, "ocupado_real": bool(ocupado)}
            lux_dia = EFICACIA_LUZ_DIA * self._vt * 0.25 * sum(a * irr[o] for o, a in z.ventanas.items()) / max(z.area, 1)
            lux = lux_dia + LUX_ARTIFICIAL * s.luces_nivel

            p_zona = p_hvac + p_luces + p_eq + p_it
            tot["hvac"] += p_hvac
            tot["luces"] += p_luces
            tot["equipos"] += p_eq
            tot["it"] += p_it
            q_kvar += sum(p * math.tan(math.acos(FP[k])) for k, p in
                          (("hvac", p_hvac), ("luces", p_luces), ("equipos", p_eq), ("it", p_it)))
            for k in range(3):
                p_lin[k] += p_hvac / 3.0
                q_lin[k] += p_hvac * tanf["hvac"] / 3.0
            lin = iz % 3
            p_lin[lin] += p_luces + p_eq
            q_lin[lin] += p_luces * tanf["luces"] + p_eq * tanf["equipos"]
            p_lin[0] += p_it
            q_lin[0] += p_it * tanf["it"]
            if z.critica:
                p_crit += p_zona
            tel.append({
                "zona": z.id, "nombre": z.nombre, "tipo": z.tipo, "critica": z.critica,
                "temp_c": s.t_medida, "temp_real_c": round(s.t, 3), "setpoint_c": sp,
                "hr_pct": s.hr_medida, "hr_real_pct": round(hr_real, 1),
                "ocupantes": n, "ocupado": ocupado_det, "ocupado_real": bool(ocupado), "lux": round(lux, 0),
                "luces_nivel": round(s.luces_nivel, 3), "equipos_nivel": round(s.equipos_nivel, 3),
                "hvac_on": bool(s.hvac_on), "hvac_enable": bool(enable), "sensor_forzado": bool(fz),
                **m_ctl.campos_sensor(fz),
                "hvac_mod": round(mod, 3), "q_frio_kw": round(q_hvac_sens + q_lat_ret, 3),
                "p_luces_kw": round(p_luces, 3), "p_equipos_kw": round(p_eq + p_it, 3),
                "p_hvac_kw": round(p_hvac, 3), "p_ventilador_kw": round(p_fan, 3), "p_total_kw": round(p_zona, 3),
            })

        p_fija = 0.0
        for cf in self.cfg.get("cargas_fijas") or []:
            f_edif = sum(ocupantes.get(z.id, 0) for z in no_crit) / max(sum(z.ocupantes for z in no_crit), 1)
            if "horario" in cf:
                p = cf["kw"] * horario(self.cfg, cf["horario"], dia_semana, hora)
                if corte is not None and not ((cf.get("critica") and ups_ok) or (gen_on and cf.get("respaldo"))):
                    p = 0.0
            elif "kw_noche" in cf:
                p = cf["kw_noche"] if ghi < 5 else 0.0
            else:
                p = cf["kw_desocupado"] + (cf["kw_ocupado"] - cf["kw_desocupado"]) * min(f_edif * 1.5, 1.0)
            p_fija += p
            q_kvar += p * math.tan(math.acos(cf.get("fp", 0.9)))
            for k in range(3):
                p_lin[k] += p / 3.0
                q_lin[k] += p * math.tan(math.acos(cf.get("fp", 0.9))) / 3.0
            if cf.get("critica"):
                p_crit += p

        p_edificio = sum(tot.values()) + p_fija
        # sin red ni planta el medidor lee cero (el UPS alimenta las cargas críticas); con la planta de respaldo
        # el edificio sigue consumiendo, pero de la planta y de los paneles, no de la acometida
        p_total = p_edificio if (corte is None or gen_on) else 0.0
        p_fv_disp = potencia_fv_kw(self.cfg, irr["H"]) if self.fv else 0.0
        p_gen = p_fv_rec = 0.0
        if corte is None:
            p_fv = p_fv_disp
            p_red = p_total - p_fv
        elif gen_on:
            # híbrido FV–diésel: el inversor se reconecta `fv_reconexion_min` después de que la planta forma la
            # red (IEEE 1547) y se recorta para que la planta no baje de su carga mínima (evita el «wet stacking»)
            p_nom = float(self.gen["potencia_kw"])
            if corte.transcurrido < float(self.resp.get("fv_reconexion_min", 5)):
                p_fv_disp = 0.0
            p_fv = max(0.0, min(p_fv_disp, p_total - float(self.gen.get("carga_min", 0.3)) * p_nom))
            p_fv_rec = p_fv_disp - p_fv
            p_gen = p_total - p_fv
            litros = (float(self.gen.get("consumo_vacio_l_h_kw", 0.03)) * p_nom
                      + float(self.gen.get("consumo_l_kwh", 0.24)) * p_gen) * self.paso_h
            self.combustible_l = max(0.0, self.combustible_l - litros)
            self.e_gen_kwh += p_gen * self.paso_h
            p_red = 0.0
        else:
            p_fv = 0.0   # sin red ni planta el inversor se desconecta (anti-isla)
            p_red = 0.0
        if corte is not None and not gen_on:
            q_kvar = 0.0
        s_kva = math.hypot(p_total, q_kvar)
        # --- pico de arranque: al encender, cada compresor toma durante unos segundos más corriente que en
        # régimen (VRF inverter con arranque suave ≈ 1.5 × nominal; PTAC de arranque directo ≈ 5 ×). No cambia la
        # energía, pero sí la potencia instantánea que ven la acometida y la planta: por eso el EMS escalona
        arr = self.e.get("arranque") or {}
        p_arranque, n_arranques = 0.0, 0
        for uid, a in acum_u.items():
            en_marcha = a["p_comp_kw"] > 1e-3 and p_total > 0
            if en_marcha and not self._sis_on.get(uid, False):
                sis = self.sistemas[uid]
                k = float(arr.get("factor_ptac", 5.0) if sis.get("tipo") == "ptac" else arr.get("factor_vrf", 1.5))
                nominal = sis["capacidad_kw"] / max(sis["cop"] * self.e.get("factor_cop", 1.0), 1.0)
                p_arranque += (k - 1.0) * nominal
                n_arranques += 1
            self._sis_on[uid] = en_marcha
        p_pico = p_total + p_arranque
        self.e_kwh += p_total * self.paso_h
        self.e_fv_kwh += p_fv * self.paso_h
        # la demanda facturable es la que ve el medidor de la acometida (importación neta)
        self._hist_p.append(max(p_red, 0.0))
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
            "v_ll": 0.0 if (corte is not None and not gen_on) else self.e["v_ll"],
            "i_a": round(s_kva * 1000 / (math.sqrt(3) * self.e["v_ll"]), 2),
            # potencia y corriente instantáneas máximas del paso (con el arranque de compresores)
            "p_pico_kw": round(p_pico, 3), "p_arranque_kw": round(p_arranque, 3), "n_arranques_equipos": n_arranques,
            "i_pico_a": round((s_kva + p_arranque / 0.6) * 1000 / (math.sqrt(3) * self.e["v_ll"]), 2),
            "e_kwh": round(self.e_kwh, 3), "demanda_15min_kw": round(dem15, 3),
            "t_ext_c": round(t_ext, 2), "hr_pct": round(clima.get("hr_pct", 0), 1), "irr_wm2": round(ghi, 1),
            **{f"irr_{o}": round(v, 1) for o, v in irr.items() if o != "H"},
            "red_ok": corte is None,
            **self._lineas(p_lin, q_lin, energizado=p_total > 0 or corte is None),
            "modo_energia": "red" if corte is None else "generador" if gen_on else "ups" if ups_ok else "sin_energia",
        }
        if self.gen.get("habilitado"):
            p_nom = float(self.gen["potencia_kw"])
            l_h = (float(self.gen.get("consumo_vacio_l_h_kw", 0.03)) * p_nom + float(self.gen.get("consumo_l_kwh", 0.24)) * p_gen)
            tanque = float(self.gen.get("tanque_l", 0.0)) or 1.0
            medidor.update({
                "p_gen_kw": round(p_gen, 3), "gen_carga_pct": round(100.0 * p_gen / p_nom, 1),
                "gen_combustible_l": round(self.combustible_l, 1),
                "gen_combustible_pct": round(100.0 * self.combustible_l / tanque, 1),
                "gen_consumo_l_h": round(l_h if gen_on else 0.0, 2),
                "gen_autonomia_h": round(self.combustible_l / l_h, 1) if gen_on and l_h > 0 else 0.0,
                "e_gen_kwh": round(self.e_gen_kwh, 3), "p_fv_recortada_kw": round(p_fv_rec, 3),
            })
        if self.fv:
            medidor.update({"p_fv_kw": round(p_fv, 3), "p_red_kw": round(p_red, 3), "e_fv_kwh": round(self.e_fv_kwh, 3)})
        if corte is not None:
            # el UPS de los servidores: en línea con la planta (autonomía completa) o descargándose sin ella
            medidor["ups_kw"] = round(p_crit if gen_on else p_edificio, 3)
            medidor["ups_min"] = round(ups_min if gen_on else max(0.0, ups_min - corte.transcurrido), 1)
        if self.eventos:
            medidor["eventos"] = sorted({ev.tipo for ev in self.eventos.values()})
        if self.ajustes_unidad:
            medidor["unidades_ajustadas"] = sorted(self.ajustes_unidad)
        if self.sensor_forzado:
            medidor["sensores_forzados"] = sorted(self.sensor_forzado)
        self._fin_eventos = self._avanzar_eventos()
        self.fin_ajustes = (m_ctl.descontar(self.ajustes_unidad, self.e["paso_min"])
                            + m_ctl.descontar(self.sensor_forzado, self.e["paso_min"]))
        # estado de las unidades con los ajustes vigentes después del paso (restante ya descontado)
        self._actualizar_unidades(acum_u, corte is not None and not gen_on)
        for zid in list(self._lecturas):
            if zid not in self.sensor_forzado:
                self._lecturas.pop(zid)
        for k in list(self.ocupacion_forzada):
            self.ocupacion_forzada[k]["restante_min"] -= self.e["paso_min"]
            if self.ocupacion_forzada[k]["restante_min"] <= 0:
                self.ocupacion_forzada.pop(k)
        if self.ocupacion_forzada:
            medidor["ocupacion_forzada"] = sorted(self.ocupacion_forzada)
        return tel, medidor
