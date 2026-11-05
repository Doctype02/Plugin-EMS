"""Gemelo digital del edificio: modelo térmico RC por zona, cargas, sensores, actuadores y medidor.

Cada zona se modela como un nodo térmico (1R1C):

    C·dT/dt = UA·(Text − T) + G_vent·(Text − T) + Q_personas + Q_luces + Q_equipos + Q_solar − Q_hvac

con Q en kW, C en kWh/K y t en horas. El HVAC es un equipo DX con termostato on/off con histéresis
(o modulante si el EMS envía `hvac_mod`, usado por el MPC). La potencia eléctrica HVAC incluye el
ventilador. Los sensores agregan ruido y pueden fallar (congelado, ruidoso, fuera de rango).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .config import Zona, zonas

Q_PERSONA_KW = 0.075        # calor sensible por persona
LUX_ARTIFICIAL = 500.0      # lux con luces al 100 %
RHO_CP = 1.2 * 1.006        # kJ/(m3·K) → con m3/s da kW/K
FP = {"hvac": 0.85, "luces": 0.95, "equipos": 0.92, "it": 0.97}

ACTUADORES = ("setpoint_c", "hvac_enable", "luces_nivel", "equipos_nivel", "hvac_mod", "ventilacion")


@dataclass
class EstadoZona:
    t: float                          # temperatura real (°C)
    setpoint_c: float = 24.0
    hvac_enable: bool = True
    luces_nivel: float = 1.0
    equipos_nivel: float = 1.0
    hvac_mod: float | None = None     # None = termostato on/off
    ventilacion: str = "dcv"          # "fija" (caudal de diseño) | "dcv" (por ocupación)
    hvac_on: bool = False
    t_medida: float = 0.0
    historial_medida: list = field(default_factory=list)


class Edificio:
    def __init__(self, cfg: dict, rng_semilla: int = 3):
        self.cfg = cfg
        self.e = cfg["edificio"]
        self.zonas: list[Zona] = zonas(cfg)
        self.zmap = {z.id: z for z in self.zonas}
        self.banda = cfg["ems"]["banda_histeresis_c"]
        self.paso_h = self.e["paso_min"] / 60.0
        self.rng = np.random.default_rng(rng_semilla)
        # perturbaciones activas (las fija el ejecutor de escenarios)
        self.carga_extra_kw: dict[str, float] = {}
        self.falla_hvac: set[str] = set()
        self.falla_sensor: dict[str, dict] = {}
        self.e_kwh = 0.0
        self._hist_p: list[float] = []
        self.reset()

    # ------------------------------------------------------------------ estado
    def reset(self, t0: float = 26.0):
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
                if k not in ACTUADORES or v is None and k != "hvac_mod":
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
    def _medir(self, zid: str, t_real: float, minuto: int) -> float:
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
    def paso(self, clima: dict, ocupantes: dict[str, int], minuto_del_dia: int = 0) -> tuple[list[dict], dict]:
        t_ext = clima["t_ext_c"]
        ghi = clima["irr_wm2"]
        shr = self.e["shr"]
        fs = self.e["fraccion_standby_equipos"]
        tel = []
        tot = {"hvac": 0.0, "luces": 0.0, "equipos": 0.0, "it": 0.0}
        q_kvar = 0.0
        p_crit = 0.0
        for z in self.zonas:
            s = self.estado[z.id]
            n = int(ocupantes.get(z.id, 0))
            f_uso = min(n / max(z.ocupantes, 1), 1.0)
            cap_disp = 0.0 if z.id in self.falla_hvac else z.hvac_kw
            cop = z.cop * (1 - 0.015 * (t_ext - 30.0))

            # --- termostato local (on/off con histéresis) o modulación externa
            sp = z.setpoint_fijo or s.setpoint_c
            if not s.hvac_enable:
                mod = 0.0
                s.hvac_on = False
            elif s.hvac_mod is not None:
                mod = s.hvac_mod
                s.hvac_on = mod > 0
            else:
                if s.t_medida > sp + self.banda:
                    s.hvac_on = True
                elif s.t_medida < sp - self.banda:
                    s.hvac_on = False
                mod = 1.0 if s.hvac_on else 0.0

            # --- ventilación: caudal fijo de diseño (línea base) o DCV
            if not s.hvac_enable:
                g_vent, fan_on = 0.0, False
            elif s.ventilacion == "fija":
                g_vent, fan_on = z.ocupantes * self.e["ventilacion_m3s_persona"] * RHO_CP, True
            else:
                g_vent = n * self.e["ventilacion_m3s_persona"] * RHO_CP
                fan_on = n > 0 or mod > 0
            p_fan = self.e["fan_frac"] * z.hvac_kw * (1.0 if fan_on else 0.0) * (0.6 if s.ventilacion == "dcv" else 1.0)

            # --- cargas internas
            p_luces = z.p_luces_max_kw * s.luces_nivel
            nivel_eq = max(s.equipos_nivel, z.min_equipos)
            p_eq = z.p_equipos_max_kw * (f_uso + (1 - f_uso) * fs) * nivel_eq + self.carga_extra_kw.get(z.id, 0.0)
            p_it = z.it_kw * (1 + 0.03 * math.sin(minuto_del_dia / 1440 * 2 * math.pi)) if z.it_kw else 0.0
            q_sol = z.ventana * z.shgc * 0.5 * ghi / 1000.0
            q_int = n * Q_PERSONA_KW + p_luces + p_eq + p_it + p_fan + q_sol

            # --- integración térmica (subpasos de 1 min, Euler explícito)
            q_hvac_sens = mod * cap_disp * shr
            sub = max(int(self.e["paso_min"]), 1)
            dt = self.paso_h / sub
            t = s.t
            for _ in range(sub):
                dTdt = ((z.ua + g_vent) * (t_ext - t) + q_int - q_hvac_sens) / z.c
                t += dTdt * dt
            s.t = t
            p_comp = mod * cap_disp / max(cop, 1.0)
            p_hvac = p_comp + p_fan

            s.t_medida = self._medir(z.id, s.t, minuto_del_dia)
            lux_dia = z.lux_dia_max * ghi / max(self.cfg["clima"]["irr_max_wm2"], 1)
            lux = lux_dia + LUX_ARTIFICIAL * s.luces_nivel if z.lux_dia_max or s.luces_nivel else 0.0

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
                "ocupantes": n, "ocupado": n > 0, "lux": round(lux, 0),
                "luces_nivel": round(s.luces_nivel, 3), "equipos_nivel": round(s.equipos_nivel, 3),
                "hvac_on": bool(s.hvac_on), "hvac_enable": bool(s.hvac_enable),
                "hvac_mod": round(mod, 3),
                "p_luces_kw": round(p_luces, 3), "p_equipos_kw": round(p_eq + p_it, 3),
                "p_hvac_kw": round(p_hvac, 3), "p_total_kw": round(p_zona, 3),
            })

        # --- cargas fijas del edificio
        f_edif = sum(ocupantes.get(z.id, 0) for z in self.zonas if not z.critica) / \
            max(sum(z.ocupantes for z in self.zonas if not z.critica), 1)
        p_fija = 0.0
        for cf in self.cfg.get("cargas_fijas", []):
            if "kw_noche" in cf:
                p = cf["kw_noche"] if ghi < 5 else 0.0
            else:
                p = cf["kw_desocupado"] + (cf["kw_ocupado"] - cf["kw_desocupado"]) * min(f_edif * 1.5, 1.0)
            p_fija += p
            q_kvar += p * math.tan(math.acos(cf.get("fp", 0.9)))
            if cf.get("critica"):
                p_crit += p

        p_total = sum(tot.values()) + p_fija
        s_kva = math.hypot(p_total, q_kvar)
        self.e_kwh += p_total * self.paso_h
        self._hist_p.append(p_total)
        n15 = max(int(round(15 / self.e["paso_min"])), 1)
        dem15 = float(np.mean(self._hist_p[-n15:]))
        medidor = {
            "p_total_kw": round(p_total, 3), "p_critica_kw": round(p_crit, 3),
            "p_no_critica_kw": round(p_total - p_crit, 3),
            "p_hvac_kw": round(tot["hvac"], 3), "p_luces_kw": round(tot["luces"], 3),
            "p_equipos_kw": round(tot["equipos"] + tot["it"], 3), "p_fija_kw": round(p_fija, 3),
            "q_kvar": round(q_kvar, 3), "s_kva": round(s_kva, 3), "fp": round(p_total / s_kva, 4) if s_kva else 1.0,
            "v_ll": self.e["v_ll"], "i_a": round(s_kva * 1000 / (math.sqrt(3) * self.e["v_ll"]), 2),
            "e_kwh": round(self.e_kwh, 3), "demanda_15min_kw": round(dem15, 3),
            "t_ext_c": round(t_ext, 2), "hr_pct": round(clima.get("hr_pct", 0), 1), "irr_wm2": round(ghi, 1),
        }
        return tel, medidor
