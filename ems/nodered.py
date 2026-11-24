"""Controlador que ejecuta la lógica de Node-RED (nodered/src/*.js) vía Node.js.

Permite (a) validar paridad entre la implementación Python y la de Node-RED y (b) correr escenarios
offline con exactamente el mismo código que corre en vivo en Node-RED.
"""
from __future__ import annotations

import json
import shutil
import subprocess

import pandas as pd

from .config import RAIZ
from .control import Controlador
from .edificio import BANDA_PROPORCIONAL_C, PLR_MIN

HARNESS = RAIZ / "nodered" / "harness.js"


def disponible() -> bool:
    return shutil.which("node") is not None


def _respaldo(cfg: dict) -> dict:
    """Parámetros del modo emergencia (planta de respaldo) para la lógica de Node-RED."""
    r = cfg.get("respaldo") or {}
    g, em = r.get("generador") or {}, r.get("emergencia") or {}
    return {"gen_kw": g.get("potencia_kw", 100), "gen_carga_max": g.get("carga_max", 0.8),
            "sp_emergencia": em.get("setpoint_c", 25.0), "sp_emergencia_min": em.get("setpoint_min_c", 24.0),
            "luces_emergencia": em.get("luces_nivel", 0.7), "sin_hvac_emergencia": em.get("tipos_sin_hvac") or []}


class ControladorNodeRed(Controlador):
    nombre = "nodered"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.proc = subprocess.Popen(["node", str(HARNESS)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True, bufsize=1)
        e = self.e
        o = cfg["ocupacion"]
        self._enviar("parametros", {
            "banda": e["banda_histeresis_c"], "sp_ocupado": e["setpoint_ocupado_c"],
            "sp_desocupado": e["setpoint_desocupado_c"], "precool_min": e["precool_min"],
            "entrada": o["hora_entrada"], "salida": o["hora_salida"], "lux_objetivo": e["lux_objetivo"],
            "luces_desocupado": e["luces_desocupado_ems"], "equipos_desocupado": e["equipos_desocupado_ems"],
            "retardo_vacancia_min": e["retardo_vacancia_min"], "limite_kw": e["limite_demanda_kw"],
            "dr_hist_kw": e["dr_histeresis_kw"], "dr_luces": e["dr_luces_nivel"], "dr_equipos": e["dr_equipos_nivel"],
            "dr_margen_confort": e["dr_margen_confort_c"], "confort_max": e["confort_max_c"],
            "confort_min": e["confort_min_c"], "alarma_servidor": e["alarma_servidor_c"],
            "plr_min": PLR_MIN, "banda_prop": BANDA_PROPORCIONAL_C,
            "t_prot_max": e.get("t_proteccion_max_c", 32.0), "t_prot_retorno": e.get("t_proteccion_retorno_c", 30.0),
            "rampa_sp_c_h": e.get("rampa_setpoint_c_h", 0.0), "arranques_max": e.get("arranques_max_paso", 0),
            "paso_min": cfg["edificio"]["paso_min"],
            **_respaldo(cfg),
            "precool_margen": e.get("precool_margen_c", 1.5), "precool_min_grado": e.get("precool_min_por_grado", 0.0),
            "precool_max_min": e.get("precool_max_min", e["precool_min"]), "limite_precool_kw": e.get("limite_precool_kw", 0),
            "hvac": {z.id: [z.hvac_kw, z.cop, z.fan_kw] for z in self.zonas},
        })

    def _enviar(self, tipo: str, payload: dict) -> dict:
        self.proc.stdin.write(json.dumps({"tipo": tipo, "payload": payload}, default=str) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def decidir(self, t: pd.Timestamp, tel: list[dict], med: dict) -> dict[str, dict]:
        for z in tel:
            pub = {k: v for k, v in z.items() if k not in ("temp_real_c", "hvac_mod")}
            pub["ts"] = t.isoformat()
            self._enviar("zona", pub)
        r = self._enviar("medidor", {**med, "ts": t.isoformat()})
        self.alarmas = r["alarmas"]
        self._estado = r["estado"]
        self.dr_activo = bool(r["estado"]["dr_activo"])
        self.dr_etapa = r["estado"]["dr_etapa"]
        self.modo_seguro = set(r["estado"]["modo_seguro"])
        cmds = {}
        for c in r["cmds"]:
            zid = c.pop("zona")
            c.pop("cmd_id", None)
            c.pop("wall_ms", None)
            cmds[zid] = c
        return cmds

    def estado(self, t) -> dict:
        e = dict(getattr(self, "_estado", {}))
        e.setdefault("ts", t.isoformat())
        e["modo"] = self.nombre
        return e

    def cerrar(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
