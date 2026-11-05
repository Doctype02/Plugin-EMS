"""Algoritmos de control del EMS.

- `Baseline`: operación típica sin EMS (horarios fijos, setpoint 22.5 °C, ventilación de diseño).
- `Reglas`: setpoints por ocupación con retardo de vacancia, pre-enfriamiento, aprovechamiento de luz
  natural, corte de standby de enchufes; el termostato local hace on/off con histéresis.
- `ReglasDR`: Reglas + respuesta a la demanda (deslastre escalonado con histéresis sobre la demanda
  de 15 min).
- `MPC`: ReglasDR para luces/equipos + MPC simplificado (horizonte finito, búsqueda exhaustiva de
  la modulación del HVAC por zona con modelo RC) que minimiza costo energético + confort + pico.

Todos usan sólo valores *medidos* (temperatura del sensor, ocupación, lux, medidor), nunca el estado
real del modelo, y pasan por el `Supervisor`, que valida sensores, genera alarmas y fuerza modo seguro.
"""
from __future__ import annotations

from collections import defaultdict, deque

import numpy as np
import pandas as pd

from .config import zonas
from .edificio import LUX_ARTIFICIAL, Q_PERSONA_KW, RHO_CP


def precio(cfg: dict, t: pd.Timestamp) -> float:
    tar = cfg["tarifa"]
    a, b = tar["hora_punta"]
    if t.dayofweek < 5 and a <= t.hour < b:
        return tar["precio_punta_usd_kwh"]
    return tar["precio_fuera_punta_usd_kwh"]


def hora(t: pd.Timestamp) -> float:
    return t.hour + t.minute / 60.0


# ============================================================================ Supervisor
class Supervisor:
    """Validación de sensores y alarmas (con detección por flanco)."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.e = cfg["ems"]
        self.paso = cfg["edificio"]["paso_min"]
        self.hist = defaultdict(lambda: deque(maxlen=6))
        self.cont = defaultdict(int)
        self.activas: set[tuple[str, str]] = set()
        self.invalidos: set[str] = set()

    def sensor_valido(self, zid: str, temp: float) -> bool:
        h = self.hist[zid]
        h.append(temp)
        if temp is None or not np.isfinite(temp) or temp < 5 or temp > 50:
            motivo = "SENSOR_FUERA_RANGO"
        elif len(h) == h.maxlen and np.ptp(h) < 0.005:
            motivo = "SENSOR_CONGELADO"
        elif len(h) >= 4 and np.sum(np.abs(np.diff(list(h))) > 1.2) >= 3:
            motivo = "SENSOR_FUERA_RANGO"
        else:
            motivo = None
        if motivo:
            self.invalidos.add(zid)
            self._motivo = motivo
            return False
        self.invalidos.discard(zid)
        return True

    def _cond(self, clave: tuple[str, str], activa: bool, pasos: int = 1) -> bool:
        """True sólo en el flanco de subida tras 'pasos' consecutivos."""
        self.cont[clave] = self.cont[clave] + 1 if activa else 0
        if self.cont[clave] >= pasos and clave not in self.activas:
            self.activas.add(clave)
            return True
        if not activa:
            self.activas.discard(clave)
        return False

    def evaluar(self, t, tel: list[dict], med: dict, limite_kw: float, dr_activo: bool) -> list[dict]:
        al = []

        def add(nivel, codigo, zona, msg, valor=None):
            al.append({"ts": t.isoformat(), "nivel": nivel, "codigo": codigo, "zona": zona,
                       "mensaje": msg, "valor": valor})

        for z in tel:
            zid, tm = z["zona"], z["temp_c"]
            valido = self.sensor_valido(zid, tm)
            if self._cond((zid, "SENSOR"), not valido):
                add("crit", getattr(self, "_motivo", "SENSOR_FUERA_RANGO"), zid,
                    f"Sensor de temperatura no confiable ({tm}) → modo seguro", tm)
            if not valido:
                continue
            if self._cond((zid, "TEMP_ALTA"), z["ocupado"] and tm > self.e["confort_max_c"], 3):
                add("warn", "TEMP_ALTA", zid, f"{tm:.1f} °C > {self.e['confort_max_c']} °C con ocupación", tm)
            if self._cond((zid, "TEMP_BAJA"), z["ocupado"] and tm < self.e["confort_min_c"], 3):
                add("info", "TEMP_BAJA", zid, f"{tm:.1f} °C < {self.e['confort_min_c']} °C con ocupación", tm)
            if z["tipo"] == "servidores" and self._cond((zid, "SERVIDOR_TEMP"), tm > self.e["alarma_servidor_c"], 2):
                add("crit", "SERVIDOR_TEMP", zid, f"Cuarto de servidores a {tm:.1f} °C", tm)
            if not z["critica"] and self._cond(
                    (zid, "HVAC_SIN_OCUP"), z["hvac_on"] and not z["ocupado"], int(60 / self.paso)):
                add("info", "HVAC_ON_SIN_OCUPACION", zid, "HVAC encendido > 60 min sin ocupación")
        if self._cond(("EDIF", "PICO"), med["demanda_15min_kw"] > limite_kw):
            add("warn", "PICO_DEMANDA", "EDIF", f"Demanda 15 min {med['demanda_15min_kw']:.1f} kW > {limite_kw} kW",
                med["demanda_15min_kw"])
        if self._cond(("EDIF", "DR"), dr_activo):
            add("info", "DR_ACTIVO", "EDIF", "Respuesta a la demanda activada")
        return al


# ============================================================================ Controladores
class Controlador:
    nombre = "base"
    usa_dr = False

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.e = cfg["ems"]
        self.zonas = zonas(cfg)
        self.zmap = {z.id: z for z in self.zonas}
        self.sup = Supervisor(cfg)
        self.limite_kw = self.e["limite_demanda_kw"]
        self.dr_activo = False
        self.dr_etapa = 0
        self._dr_cont = 0
        self.alarmas: list[dict] = []
        self.ultimo_ocupado: dict[str, pd.Timestamp] = {}
        self.modo_seguro: set[str] = set()

    # ---------------------------------------------------------------- utilidades
    def ocupado_efectivo(self, t, z: dict) -> bool:
        if z["ocupado"]:
            self.ultimo_ocupado[z["zona"]] = t
            return True
        u = self.ultimo_ocupado.get(z["zona"])
        return u is not None and (t - u) <= pd.Timedelta(minutes=self.e["retardo_vacancia_min"])

    def horario_laboral(self, t) -> bool:
        o = self.cfg["ocupacion"]
        return t.dayofweek < 5 and o["hora_entrada"] - 0.5 <= hora(t) < o["hora_salida"] + 0.5

    def precool(self, t) -> bool:
        o = self.cfg["ocupacion"]
        h = hora(t)
        return t.dayofweek < 5 and o["hora_entrada"] - self.e["precool_min"] / 60 <= h < o["hora_entrada"]

    # ------------------------------------------------------------------ interfaz
    def decidir(self, t: pd.Timestamp, tel: list[dict], med: dict) -> dict[str, dict]:
        self.alarmas = self.sup.evaluar(t, tel, med, self.limite_kw, self.dr_activo)
        cmds = self._decidir(t, tel, med)
        if self.usa_dr:
            self._respuesta_demanda(med, cmds, tel)
        # modo seguro: sensor inválido → capacidad fija, sin depender del termostato
        self.modo_seguro = set(self.sup.invalidos)
        for z in self.zonas:
            if z.critica:
                cmds.setdefault(z.id, {})
        for zid in self.modo_seguro:
            c = cmds.setdefault(zid, {})
            mod = 1.0 if self.zmap[zid].critica else 0.55
            c.update({"hvac_enable": True, "hvac_mod": mod, "setpoint_c": self.e["setpoint_ocupado_c"]})
        for zid, c in cmds.items():
            if zid not in self.modo_seguro and "hvac_mod" not in c:
                c["hvac_mod"] = None
        return cmds

    def _decidir(self, t, tel, med) -> dict[str, dict]:
        raise NotImplementedError

    def estado(self, t) -> dict:
        return {"ts": t.isoformat(), "origen": "python", "modo": self.nombre, "dr_activo": self.dr_activo,
                "dr_etapa": self.dr_etapa, "limite_kw": self.limite_kw, "n_alarmas": len(self.sup.activas),
                "modo_seguro": sorted(self.modo_seguro)}

    # ------------------------------------------------------- respuesta a la demanda
    def _respuesta_demanda(self, med: dict, cmds: dict, tel: list[dict]):
        """Limitador de demanda máxima en dos niveles.

        1. Rotación de compresores: con un presupuesto `limite − margen − cargas no HVAC`, se concede
           capacidad a las zonas que piden frío en orden de urgencia (T − setpoint); las demás quedan
           forzadas a 0 este paso. Zonas a menos de `dr_margen_confort_c` del límite de confort siempre
           reciben frío (el confort tiene prioridad sobre el límite de demanda).
        2. Si la demanda de 15 min aún supera el límite: deslastre de iluminación y enchufes no críticos
           (con histéresis de salida de `dr_histeresis_kw` durante 3 pasos).
        """
        e_cfg = self.cfg["edificio"]
        banda = self.e["banda_histeresis_c"]
        t_ext = med["t_ext_c"]
        solicitudes, p_comp_actual = [], 0.0
        for z in tel:
            zid = z["zona"]
            p = self.zmap[zid]
            if p.critica or zid not in cmds or zid in self.sup.invalidos:
                continue
            c = cmds[zid]
            cop = p.cop * (1 - 0.015 * (t_ext - 30.0))
            fan = e_cfg["fan_frac"] * p.hvac_kw * 0.6 if z["hvac_enable"] and (z["ocupado"] or z["hvac_on"]) else 0.0
            if z["hvac_on"]:
                p_comp_actual += max(z["p_hvac_kw"] - fan, 0.0)
            if not c.get("hvac_enable"):
                continue
            sp = c["setpoint_c"]
            if c.get("hvac_mod") is not None:
                pide = c["hvac_mod"]
            else:
                pide = 1.0 if (z["temp_c"] > sp + banda or (z["hvac_on"] and z["temp_c"] > sp - banda)) else 0.0
            if pide > 0:
                solicitudes.append((z["temp_c"] - sp, zid, pide * p.hvac_kw / max(cop, 1.0), p.hvac_kw / max(cop, 1.0),
                                    z["temp_c"] > self.e["confort_max_c"] - self.e["dr_margen_confort_c"]))
        presupuesto = self.limite_kw - 3.0 - (med["p_total_kw"] - p_comp_actual)
        forzadas = 0
        for urg, zid, kw, kw_max, emergencia in sorted(solicitudes, key=lambda x: (not x[4], -x[0])):
            c = cmds[zid]
            if emergencia or kw <= presupuesto:
                presupuesto -= kw
                continue
            if c.get("hvac_mod") is not None and presupuesto > 0:
                c["hvac_mod"] = round(max(presupuesto / kw_max, 0.0), 3)
                presupuesto = 0.0
            else:
                c["hvac_mod"] = 0.0
            forzadas += 1

        d = med["demanda_15min_kw"]
        if d > self.limite_kw:
            self.dr_etapa, self._dr_cont = 2, 0
        elif self.dr_etapa == 2 and d < self.limite_kw - self.e["dr_histeresis_kw"]:
            self._dr_cont += 1
            if self._dr_cont >= 3:
                self.dr_etapa, self._dr_cont = 0, 0
        if self.dr_etapa < 2:
            self.dr_etapa = 1 if forzadas else 0
        self.dr_activo = self.dr_etapa > 0
        if self.dr_etapa >= 2:
            for zid, c in cmds.items():
                if self.zmap[zid].critica:
                    continue
                if "luces_nivel" in c:
                    c["luces_nivel"] = round(c["luces_nivel"] * self.e["dr_luces_nivel"], 3)
                if "equipos_nivel" in c:
                    c["equipos_nivel"] = min(c["equipos_nivel"], self.e["dr_equipos_nivel"])


class Baseline(Controlador):
    nombre = "baseline"

    def _decidir(self, t, tel, med):
        b = self.cfg["baseline"]
        h = hora(t)
        laborable = t.dayofweek < 5
        sabado = t.dayofweek == 5
        cmds = {}
        for z in tel:
            if z["critica"]:
                continue
            hvac = (laborable and b["hvac_horario"][0] <= h < b["hvac_horario"][1]) or (sabado and 7 <= h < 13)
            luces_horario = laborable and b["luces_horario"][0] <= h < b["luces_horario"][1]
            cmds[z["zona"]] = {
                "hvac_enable": hvac, "setpoint_c": self.e["setpoint_baseline_c"], "ventilacion": "fija",
                "luces_nivel": b["luces_nivel"] if (luces_horario or z["ocupado"]) else 0.0,
                "equipos_nivel": 1.0,
            }
        return cmds


class Reglas(Controlador):
    nombre = "reglas"

    def _reglas_zona(self, t, z: dict) -> dict:
        ocup = self.ocupado_efectivo(t, z)
        if ocup or self.precool(t):
            sp, en = self.e["setpoint_ocupado_c"], True
        elif self.horario_laboral(t):
            sp, en = self.e["setpoint_desocupado_c"], True
        else:
            sp, en = 29.0, z["temp_c"] > 29.0 + self.e["banda_histeresis_c"]
        if ocup:
            lux_dia = max(z["lux"] - LUX_ARTIFICIAL * z["luces_nivel"], 0.0)
            luces = float(np.clip((self.e["lux_objetivo"] - lux_dia) / LUX_ARTIFICIAL, 0.1, 1.0))
            luces = round(round(luces / 0.05) * 0.05, 2)
            equipos = 1.0
        else:
            luces = self.e["luces_desocupado_ems"]
            equipos = self.e["equipos_desocupado_ems"]
        return {"hvac_enable": en, "setpoint_c": sp, "ventilacion": "dcv",
                "luces_nivel": luces, "equipos_nivel": equipos}

    def _decidir(self, t, tel, med):
        return {z["zona"]: self._reglas_zona(t, z) for z in tel if not z["critica"]}


class ReglasDR(Reglas):
    nombre = "reglas_dr"
    usa_dr = True


class MPC(ReglasDR):
    """MPC simplificado por zona: modulación constante en el horizonte (move blocking)."""
    nombre = "mpc"

    def _decidir(self, t, tel, med):
        cmds = super()._decidir(t, tel, med)
        H = self.e["mpc_horizonte_pasos"]
        dt = self.cfg["edificio"]["paso_min"] / 60.0
        niveles = self.e["mpc_niveles"]
        pr = precio(self.cfg, t)
        e_cfg = self.cfg["edificio"]
        shr = e_cfg["shr"]
        p_otros_base = med["p_total_kw"] - med["p_hvac_kw"]
        t_ext = med["t_ext_c"]
        for z in tel:
            if z["critica"] or z["zona"] not in cmds:
                continue
            c = cmds[z["zona"]]
            if not c["hvac_enable"]:
                continue
            p = self.zmap[z["zona"]]
            ocup = self.ocupado_efectivo(t, z) or self.precool(t)
            sup = c["setpoint_c"] + (0.5 if ocup else 1.0)
            inf = c["setpoint_c"] - 1.5
            g_vent = z["ocupantes"] * e_cfg["ventilacion_m3s_persona"] * RHO_CP
            q_sol = p.ventana * p.shgc * 0.5 * med["irr_wm2"] / 1000.0
            q_int = z["ocupantes"] * Q_PERSONA_KW + z["p_luces_kw"] + z["p_equipos_kw"] + q_sol
            cop = p.cop * (1 - 0.015 * (t_ext - 30.0))
            p_otros_hvac = med["p_hvac_kw"] - z["p_hvac_kw"]
            mejor, j_min = 0.0, np.inf
            for m in niveles:
                T, J = z["temp_c"], 0.0
                p_elec = m * p.hvac_kw / max(cop, 1.0) + e_cfg["fan_frac"] * p.hvac_kw * 0.6
                for _ in range(H):
                    T += dt * ((p.ua + g_vent) * (t_ext - T) + q_int - m * p.hvac_kw * shr) / p.c
                    viol = max(0.0, T - sup) + max(0.0, inf - T)
                    exceso = max(0.0, p_otros_base + p_otros_hvac + p_elec - self.limite_kw)
                    J += pr * p_elec * dt + self.e["mpc_peso_confort"] * viol * dt + self.e["mpc_peso_pico"] * exceso
                if J < j_min - 1e-9:
                    mejor, j_min = m, J
            c["hvac_mod"] = mejor
        return cmds


CONTROLADORES = {c.nombre: c for c in (Baseline, Reglas, ReglasDR, MPC)}


def crear(nombre: str, cfg: dict) -> Controlador:
    return CONTROLADORES[nombre](cfg)
