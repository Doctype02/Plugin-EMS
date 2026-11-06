"""Puente Python–EnergyPlus (API de co-simulación `pyenergyplus`, EnergyPlus ≥ 23.1).

EnergyPlus reemplaza al modelo RC como "planta": en cada paso de zona se leen sensores
(temperatura media del aire, ocupantes, potencia de luces/equipos, carga de enfriamiento), se arma
la misma telemetría del contrato, se llama al mismo controlador EMS y se escriben actuadores
(setpoint de enfriamiento, potencia de luces y equipos). Con `INFLUX_URL`/`MQTT_HOST` definidos
publica igual que el modo live.

El mapa entre las zonas Z01…Z10 y los objetos del IDF está en `config/energyplus_mapa.yaml`.
Requisitos del IDF: `Output:Variable` no hace falta (se solicitan por API); los objetos Lights,
ElectricEquipment y People deben existir por zona y la zona debe tener un termostato
(ThermostatSetpoint:DualSetpoint o SingleCooling) para que el actuador "Zone Temperature Control"
esté disponible. Si el IDF usa HVACTemplate:Zone:IdealLoadsAirSystem, la potencia eléctrica HVAC se
estima como carga de enfriamiento / COP de la zona.

Uso:
    export ENERGYPLUS_DIR=/usr/local/EnergyPlus-24-2-0
    python -m ems energyplus --idf modelo.idf --epw PAN_Tocumen.epw
"""
from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import pandas as pd
import yaml

from .config import RAIZ, zonas
from .control import crear, precio
from .edificio import FP, LUX_ARTIFICIAL
from .influx import Escritor

MAPA_DEFECTO = RAIZ / "config" / "energyplus_mapa.yaml"


def _importar_api():
    d = os.getenv("ENERGYPLUS_DIR")
    if d and d not in sys.path:
        sys.path.insert(0, d)
    try:
        from pyenergyplus.api import EnergyPlusAPI
    except ImportError as exc:
        raise SystemExit("No se encontró pyenergyplus. Instale EnergyPlus ≥ 23.1 y defina ENERGYPLUS_DIR "
                         "con la carpeta de instalación.") from exc
    return EnergyPlusAPI


class PuenteEnergyPlus:
    def __init__(self, cfg: dict, mapa: dict, control: str = "reglas_dr", salida: str | Path = "resultados"):
        self.cfg = cfg
        self.mapa = mapa["zonas"]
        self.zonas = {z.id: z for z in zonas(cfg)}
        self.ctrl = crear(control, cfg)
        self.salida = Path(salida)
        self.h = {}
        self.listo = False
        self.tel_prev = None
        self.med_prev = None
        self.filas_z, self.filas_m = [], []
        self.e_kwh = 0.0
        self.hist_p: list[float] = []
        self.influx = Escritor()
        self.anio = int(mapa.get("anio", 2026))
        EnergyPlusAPI = _importar_api()
        self.api = EnergyPlusAPI()
        self.x = self.api.exchange
        self.state = self.api.state_manager.new_state()

    # ------------------------------------------------------------------ handles
    def _solicitar(self):
        for zid, m in self.mapa.items():
            self.x.request_variable(self.state, "Zone Mean Air Temperature", m["zona_ep"])
            self.x.request_variable(self.state, "Zone People Occupant Count", m["zona_ep"])
            self.x.request_variable(self.state, "Zone Lights Electricity Rate", m["zona_ep"])
            self.x.request_variable(self.state, "Zone Electric Equipment Electricity Rate", m["zona_ep"])
            self.x.request_variable(self.state, m.get("var_enfriamiento", "Zone Air System Sensible Cooling Rate"),
                                    m["zona_ep"])
        self.x.request_variable(self.state, "Site Outdoor Air Drybulb Temperature", "Environment")
        self.x.request_variable(self.state, "Site Outdoor Air Relative Humidity", "Environment")
        self.x.request_variable(self.state, "Site Direct Solar Radiation Rate per Area", "Environment")
        self.x.request_variable(self.state, "Site Diffuse Solar Radiation Rate per Area", "Environment")

    def _handles(self) -> bool:
        s, x = self.state, self.x
        for zid, m in self.mapa.items():
            ze = m["zona_ep"]
            hz = {
                "t": x.get_variable_handle(s, "Zone Mean Air Temperature", ze),
                "n": x.get_variable_handle(s, "Zone People Occupant Count", ze),
                "pl": x.get_variable_handle(s, "Zone Lights Electricity Rate", ze),
                "pe": x.get_variable_handle(s, "Zone Electric Equipment Electricity Rate", ze),
                "qc": x.get_variable_handle(s, m.get("var_enfriamiento", "Zone Air System Sensible Cooling Rate"), ze),
                "sp": x.get_actuator_handle(s, "Zone Temperature Control", "Cooling Setpoint", ze),
                "luces": x.get_actuator_handle(s, "Lights", "Electricity Rate", m["luces"]) if m.get("luces") else -1,
                "equipos": x.get_actuator_handle(s, "ElectricEquipment", "Electricity Rate", m["equipos"])
                if m.get("equipos") else -1,
            }
            if min(hz["t"], hz["sp"]) < 0:
                print(f"[energyplus] handles inválidos en {zid} ({ze}): {hz}")
                return False
            self.h[zid] = hz
        self.h["_amb"] = {
            "t": x.get_variable_handle(s, "Site Outdoor Air Drybulb Temperature", "Environment"),
            "hr": x.get_variable_handle(s, "Site Outdoor Air Relative Humidity", "Environment"),
            "dir": x.get_variable_handle(s, "Site Direct Solar Radiation Rate per Area", "Environment"),
            "dif": x.get_variable_handle(s, "Site Diffuse Solar Radiation Rate per Area", "Environment"),
        }
        return True

    # ------------------------------------------------------------------ paso
    def _ts(self) -> pd.Timestamp:
        s, x = self.state, self.x
        mins = int(round(x.minutes(s))) % 60
        hora = x.hour(s) + (1 if x.minutes(s) >= 59.5 else 0)
        t = pd.Timestamp(year=self.anio, month=x.month(s), day=x.day_of_month(s)) + pd.Timedelta(hours=hora, minutes=mins)
        return t.tz_localize(self.cfg["edificio"]["zona_horaria"])

    def _leer(self, t: pd.Timestamp) -> tuple[list[dict], dict]:
        s, x = self.state, self.x
        gv = lambda hnd: x.get_variable_value(s, hnd) if hnd >= 0 else 0.0
        amb = self.h["_amb"]
        t_ext, hr = gv(amb["t"]), gv(amb["hr"])
        ghi = gv(amb["dir"]) * 0.6 + gv(amb["dif"])  # aproximación horizontal
        paso_h = 1.0 / x.num_time_steps_in_hour(s)
        tel, tot, q_kvar, p_crit = [], {"hvac": 0.0, "luces": 0.0, "equipos": 0.0}, 0.0, 0.0
        for zid, hz in self.h.items():
            if zid.startswith("_"):
                continue
            z = self.zonas[zid]
            temp = gv(hz["t"])
            n = int(round(gv(hz["n"])))
            pl, pe = gv(hz["pl"]) / 1000, gv(hz["pe"]) / 1000
            p_hvac = abs(gv(hz["qc"])) / 1000 / z.cop
            luces_nivel = min(pl / max(z.p_luces_max_kw, 1e-6), 1.0)
            lux_dia = 110.0 * 0.252 * 0.25 * z.ventana * ghi * 0.4 / max(z.area, 1)
            p_z = pl + pe + p_hvac
            tot["hvac"] += p_hvac
            tot["luces"] += pl
            tot["equipos"] += pe
            q_kvar += p_hvac * math.tan(math.acos(FP["hvac"])) + pl * math.tan(math.acos(FP["luces"])) + \
                pe * math.tan(math.acos(FP["equipos"]))
            if z.critica:
                p_crit += p_z
            sp = x.get_actuator_value(s, hz["sp"]) if hasattr(x, "get_actuator_value") else z.setpoint_fijo or 24.0
            tel.append({"zona": zid, "nombre": z.nombre, "tipo": z.tipo, "critica": z.critica, "temp_c": round(temp, 2),
                        "temp_real_c": temp, "setpoint_c": sp, "ocupantes": n, "ocupado": n > 0,
                        "lux": round(lux_dia + LUX_ARTIFICIAL * luces_nivel), "luces_nivel": round(luces_nivel, 3),
                        "equipos_nivel": 1.0, "hvac_on": p_hvac > 0.05, "hvac_enable": sp < 34,
                        "p_luces_kw": round(pl, 3), "p_equipos_kw": round(pe, 3), "p_hvac_kw": round(p_hvac, 3),
                        "p_total_kw": round(p_z, 3)})
        p_total = sum(tot.values())
        self.e_kwh += p_total * paso_h
        self.hist_p.append(p_total)
        n15 = max(int(round(0.25 / paso_h)), 1)
        s_kva = math.hypot(p_total, q_kvar)
        v = self.cfg["edificio"]["v_ll"]
        med = {"p_total_kw": round(p_total, 3), "p_critica_kw": round(p_crit, 3), "p_no_critica_kw": round(p_total - p_crit, 3),
               "p_hvac_kw": round(tot["hvac"], 3), "p_luces_kw": round(tot["luces"], 3),
               "p_equipos_kw": round(tot["equipos"], 3), "p_fija_kw": 0.0, "q_kvar": round(q_kvar, 3),
               "s_kva": round(s_kva, 3), "fp": round(p_total / s_kva, 4) if s_kva else 1.0, "v_ll": v,
               "i_a": round(s_kva * 1000 / (math.sqrt(3) * v), 2), "e_kwh": round(self.e_kwh, 3),
               "demanda_15min_kw": round(sum(self.hist_p[-n15:]) / len(self.hist_p[-n15:]), 3),
               "t_ext_c": round(t_ext, 2), "hr_pct": round(hr, 1), "irr_wm2": round(ghi, 1),
               "precio_usd_kwh": precio(self.cfg, t)}
        return tel, med

    def _escribir(self, cmds: dict[str, dict]):
        s, x = self.state, self.x
        for zid, c in cmds.items():
            hz = self.h.get(zid)
            if not hz:
                continue
            z = self.zonas[zid]
            if "setpoint_c" in c or "hvac_enable" in c:
                sp = c.get("setpoint_c", 24.0) if c.get("hvac_enable", True) else 35.0
                if c.get("hvac_mod") == 0.0:          # limitador de demanda: compresor bloqueado este paso
                    sp = 35.0
                x.set_actuator_value(s, hz["sp"], float(z.setpoint_fijo or sp))
            if "luces_nivel" in c and hz["luces"] >= 0:
                x.set_actuator_value(s, hz["luces"], float(z.p_luces_max_kw * 1000 * c["luces_nivel"]))
            if "equipos_nivel" in c and hz["equipos"] >= 0 and not z.critica:
                x.set_actuator_value(s, hz["equipos"],
                                     float(z.p_equipos_max_kw * 1000 * max(c["equipos_nivel"], z.min_equipos)))

    def _callback(self, state):
        x = self.x
        if not self.listo:
            if not x.api_data_fully_ready(state):
                return
            if not self._handles():
                self.api.runtime.stop_simulation(state)
                return
            self.listo = True
        if x.warmup_flag(state):
            return
        t = self._ts()
        if self.tel_prev is not None:
            cmds = self.ctrl.decidir(t, self.tel_prev, self.med_prev)
            self._escribir(cmds)
            for a in self.ctrl.alarmas:
                self.influx.alarma(a, "energyplus")
        tel, med = self._leer(t)
        for z in tel:
            z["ts"] = t
            self.influx.zona(t, z, "energyplus")
        med["ts"] = t
        self.influx.medidor(t, med, "energyplus")
        self.influx.flush()
        self.filas_z.extend(tel)
        self.filas_m.append(med)
        self.tel_prev, self.med_prev = tel, med

    def correr(self, idf: str, epw: str) -> pd.DataFrame:
        self._solicitar()
        self.api.runtime.callback_begin_zone_timestep_after_init_heat_balance(self.state, self._callback)
        out = self.salida / "energyplus"
        out.mkdir(parents=True, exist_ok=True)
        code = self.api.runtime.run_energyplus(self.state, ["-w", epw, "-d", str(out), idf])
        self.influx.cerrar()
        if code != 0:
            print(f"[energyplus] terminó con código {code}; revise {out}/eplusout.err")
        dm = pd.DataFrame(self.filas_m)
        if len(dm):
            dm.to_csv(self.salida / "energyplus_medidor.csv", index=False)
            pd.DataFrame(self.filas_z).to_csv(self.salida / "energyplus_zonas.csv", index=False)
            print(f"[energyplus] {len(dm)} pasos; energía {self.e_kwh:,.1f} kWh; "
                  f"pico {dm.p_total_kw.max():.1f} kW → {self.salida}/energyplus_*.csv")
        return dm


def ejecutar(cfg: dict, idf: str, epw: str, control: str = "reglas_dr", salida: str | Path = "resultados",
             mapa: str | Path | None = None):
    with open(mapa or MAPA_DEFECTO, encoding="utf-8") as f:
        m = yaml.safe_load(f)
    return PuenteEnergyPlus(cfg, m, control, salida).correr(idf, epw)
