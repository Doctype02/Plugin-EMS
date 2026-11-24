"""Escritura a InfluxDB 2.x según docs/CONTRATO.md (§3)."""
from __future__ import annotations

import os

import pandas as pd

CAMPOS_ZONA = ["temp_c", "setpoint_c", "ocupantes", "ocupado", "lux", "luces_nivel", "equipos_nivel",
               "hvac_on", "hvac_enable", "p_luces_kw", "p_equipos_kw", "p_hvac_kw", "p_total_kw",
               "temp_real_c", "hr_pct", "hr_real_pct", "ocupado_real", "sensor_forzado",
               # sólo mientras el sensor está forzado (ems/controladores.py)
               "sensor_temp_offset_c", "sensor_temp_fijo_c", "sensor_hr_fijo_pct", "sensor_presencia",
               "sensor_congelado", "sensor_restante_min"]
CAMPOS_UNIDAD = ["p_kw", "q_frio_kw", "carga_pct", "cop", "modo", "encendido", "capacidad_pct", "setpoint_c",
                 "cop_factor", "forzado", "restante_min", "falla", "sin_energia"]
CAMPOS_MEDIDOR = ["p_total_kw", "p_critica_kw", "p_no_critica_kw", "p_hvac_kw", "p_luces_kw", "p_equipos_kw",
                  "p_fija_kw", "q_kvar", "s_kva", "fp", "v_ll", "i_a", "e_kwh", "demanda_15min_kw", "t_ext_c",
                  "hr_pct", "irr_wm2", "precio_usd_kwh", "p_fv_kw", "p_red_kw", "e_fv_kwh", "red_ok", "ups_kw", "ups_min",
                  # planta de respaldo (docs/PLANTA_RESPALDO.md)
                  "modo_energia", "p_gen_kw", "gen_carga_pct", "gen_combustible_l", "gen_combustible_pct",
                  "gen_consumo_l_h", "gen_autonomia_h", "e_gen_kwh", "p_fv_recortada_kw"]


def _num(v):
    if isinstance(v, bool):
        return int(v)
    return float(v)


class Escritor:
    """Envoltura del cliente oficial. Sin INFLUX_URL queda deshabilitado (no-op)."""

    def __init__(self, url: str | None = None, token: str | None = None, org: str | None = None,
                 bucket: str | None = None, edificio: str | None = None):
        self.url = url or os.getenv("INFLUX_URL")
        self.token = token or os.getenv("INFLUX_TOKEN", "")
        self.org = org or os.getenv("INFLUX_ORG", "utp")
        self.bucket = bucket or os.getenv("INFLUX_BUCKET", "ems")
        self.edificio = edificio or os.getenv("EMS_EDIFICIO", "edificio1")
        self.habilitado = bool(self.url)
        self._buf: list = []
        if self.habilitado:
            from influxdb_client import InfluxDBClient, Point, WritePrecision
            from influxdb_client.client.write_api import SYNCHRONOUS

            self.Point, self.WP = Point, WritePrecision
            self.cliente = InfluxDBClient(url=self.url, token=self.token, org=self.org, timeout=10_000)
            self.api = self.cliente.write_api(write_options=SYNCHRONOUS)

    # ------------------------------------------------------------------ puntos
    def _p(self, medida: str, ts, tags: dict, campos: dict):
        p = self.Point(medida).tag("edificio", self.edificio)
        for k, v in tags.items():
            p = p.tag(k, str(v))
        for k, v in campos.items():
            if v is None:
                continue
            p = p.field(k, v if isinstance(v, str) else _num(v))
        self._buf.append(p.time(pd.Timestamp(ts).to_pydatetime(), self.WP.S))

    def zona(self, ts, z: dict, escenario: str = "live"):
        if not self.habilitado:
            return
        tags = {"zona": z["zona"], "nombre": z["nombre"], "tipo": z["tipo"],
                "critica": "si" if z["critica"] else "no", "escenario": escenario}
        self._p("zona", ts, tags, {k: z[k] for k in CAMPOS_ZONA if k in z})

    def unidad(self, ts, u: dict, escenario: str = "live"):
        if self.habilitado:
            self._p("unidad", ts, {"unidad": u["unidad"], "tipo": u["tipo"], "escenario": escenario},
                    {k: (-1.0 if k == "restante_min" and u[k] is None and u.get("forzado") else u[k])
                     for k in CAMPOS_UNIDAD if k in u})

    def medidor(self, ts, m: dict, escenario: str = "live"):
        if self.habilitado:
            self._p("medidor", ts, {"escenario": escenario}, {k: m[k] for k in CAMPOS_MEDIDOR if k in m})

    def ems(self, ts, est: dict, escenario: str = "live"):
        if self.habilitado:
            campos = {"dr_activo": est.get("dr_activo", False), "limite_kw": est.get("limite_kw", 0),
                      "n_alarmas": est.get("n_alarmas", 0), "latencia_ms": est.get("latencia_ms", 0.0)}
            # actividad de cada regla del EMS (zonas afectadas en el paso) → dashboard «Reglas del EMS»
            for k, v in (est.get("reglas") or {}).items():
                if isinstance(v, (int, float, bool)):
                    campos[f"r_{k}"] = v
            ms = est.get("modo_seguro")
            campos["r_modo_seguro"] = len(ms) if isinstance(ms, (list, tuple, set)) else (ms or 0)
            if isinstance(est.get("manual"), list):
                campos["r_manual"] = len(est["manual"])
            self._p("ems", ts, {"escenario": escenario, "modo": est.get("modo", "?")}, campos)

    def alarma(self, a: dict, escenario: str = "live"):
        if self.habilitado:
            self._p("alarma", a["ts"], {"escenario": escenario, "nivel": a["nivel"], "codigo": a["codigo"],
                                        "zona": a["zona"]},
                    {"mensaje": a["mensaje"], "valor": a.get("valor") if a.get("valor") is not None else 0.0})

    def auditoria(self, a: dict):
        """Orden recibida por el endpoint de control (hora real, no simulada): quién, qué y con qué resultado."""
        if self.habilitado:
            self._p("auditoria", a.get("ts") or pd.Timestamp.now(tz="UTC"),
                    {"tipo": a.get("tipo", "?"), "resultado": "aceptada" if a.get("ok") else "rechazada"},
                    {"usuario": str(a.get("usuario") or "(sin nombre)"), "objetivo": str(a.get("objetivo") or ""),
                     "codigo": int(a.get("codigo", 0)), "ip": str(a.get("ip") or ""), "detalle": str(a.get("detalle") or "")})

    def pronostico(self, serie: pd.Series, modelo: str, real: pd.Series | None = None):
        if not self.habilitado:
            return
        for ts, v in serie.items():
            campos = {"p_kw_pred": float(v)}
            if real is not None and ts in real.index and pd.notna(real[ts]):
                campos["p_kw_real"] = float(real[ts])
            self._p("pronostico", ts, {"modelo": modelo}, campos)

    def kpi(self, ts, escenario: str, campos: dict):
        if self.habilitado:
            limpios = {k: float(v) for k, v in campos.items()
                       if isinstance(v, (int, float)) and pd.notna(v) and abs(float(v)) != float("inf")}
            self._p("kpi", ts, {"escenario": escenario}, limpios)

    def flush(self, forzar: bool = False):
        if self.habilitado and self._buf and (forzar or len(self._buf) >= 500):
            self.api.write(bucket=self.bucket, org=self.org, record=self._buf)
            self._buf = []

    def cerrar(self):
        if self.habilitado:
            self.flush(forzar=True)
            self.cliente.close()


def exportar_resultado(esc: Escritor, res, escenario: str):
    """Sube una simulación offline completa (para comparar escenarios en Grafana)."""
    for z in res.zonas.to_dict("records"):
        esc.zona(z["ts"], z, escenario)
        esc.flush()
    for ts, m in res.medidor.iterrows():
        esc.medidor(ts, m.to_dict(), escenario)
        esc.flush()
    for e in res.estado.to_dict("records"):
        esc.ems(e["ts"], e, escenario)
        esc.flush()
    for a in res.alarmas.to_dict("records"):
        esc.alarma(a, escenario)
    esc.flush(forzar=True)
