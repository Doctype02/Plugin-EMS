"""Escenarios de eficiencia, pruebas normales/anómalas y análisis de sensibilidad."""
from __future__ import annotations

import time

import numpy as np
import pandas as pd

from . import config as m_config
from . import kpi
from .simulacion import Anomalia, simular

ESCENARIOS_EMS = ["baseline", "reglas", "reglas_dr", "mpc"]


def area_total(cfg: dict) -> float:
    return float(sum(z["area"] for z in cfg["zonas"]))


# ============================================================================ eficiencia
def comparar(cfg: dict, dias: float = 7, controladores=ESCENARIOS_EMS, guardar_series: bool = True):
    """Ejecuta cada controlador sobre el mismo clima y ocupación. Devuelve (tabla KPI, resultados)."""
    resultados, filas = {}, []
    for c in controladores:
        r = simular(cfg, c, dias=dias)
        resultados[c] = r
    base = kpi.energeticos(resultados["baseline"], cfg)
    for c, r in resultados.items():
        k = kpi.energeticos(r, cfg)
        fila = {"escenario": c, **k}
        if c != "baseline":
            fila.update(kpi.economia(base, k, cfg))
            fila["energia_ahorrada_kwh"] = base["energia_kwh"] - k["energia_kwh"]
        filas.append(fila)
    return pd.DataFrame(filas).set_index("escenario"), resultados


# ============================================================================ pruebas
def _casos(cfg: dict) -> list[dict]:
    lim = cfg["ems"]["limite_demanda_kw"]
    d = 24.0  # el día 2 (martes) es el día de la perturbación; día 1 = arranque
    return [
        {"id": "P01", "nombre": "Perfil normal (semana)", "anomalias": [], "dias": 7,
         "esperado": [], "criterios": {"confort_min_pct": 95, "dem_max_kw": lim * 1.03}},
        {"id": "P02", "nombre": "Ola de calor +4 °C", "dias": 3,
         "anomalias": [Anomalia("ola_calor", d, d + 24, params={"delta_c": 4.0})],
         "esperado": ["TEMP_ALTA"], "criterios": {"confort_vs_base_pp": -1.0, "energia_vs_base": True}},
        {"id": "P03", "nombre": "Ocupación fuera de horario (evento nocturno Z06)", "dias": 3,
         "anomalias": [Anomalia("ocupacion_extra", d + 19, d + 22, "Z06", {"personas": 35})],
         "esperado": [], "criterios": {"recuperacion": ("Z06", d + 19, 75)}},
        {"id": "P04", "nombre": "Sensor congelado Z03 (4 h)", "dias": 3,
         "anomalias": [Anomalia("sensor", d + 9, d + 13, "Z03", {"tipo": "congelado"})],
         "esperado": ["SENSOR_CONGELADO"], "criterios": {"zona_tmax": ("Z03", d + 9, d + 13, 27.0)}},
        {"id": "P05", "nombre": "Sensor fuera de rango Z05 (85 °C)", "dias": 3,
         "anomalias": [Anomalia("sensor", d + 10, d + 11, "Z05", {"tipo": "fuera_rango", "valor": 85.0})],
         "esperado": ["SENSOR_FUERA_RANGO"], "criterios": {"zona_tmax": ("Z05", d + 10, d + 11, 26.5)}},
        {"id": "P06", "nombre": "Sensor ruidoso Z02 (σ = 2 °C)", "dias": 3,
         "anomalias": [Anomalia("sensor", d + 8, d + 12, "Z02", {"tipo": "ruidoso", "sigma": 2.0})],
         "esperado": ["SENSOR_FUERA_RANGO"], "criterios": {"zona_tmax": ("Z02", d + 8, d + 12, 27.0)}},
        {"id": "P07", "nombre": "Falla de HVAC Z04 (10–14 h)", "dias": 3,
         "anomalias": [Anomalia("falla_hvac", d + 10, d + 14, "Z04")],
         "esperado": ["TEMP_ALTA"], "criterios": {}},
        {"id": "P08", "nombre": "Pico de carga +40 kW laboratorio (13–15 h)", "dias": 3,
         "anomalias": [Anomalia("carga_extra", d + 13, d + 15, "Z07", {"kw": 40.0})],
         "esperado": ["DR_ACTIVO"], "criterios": {"respuesta_dr": (d + 13, 2)}},
        {"id": "P09", "nombre": "Pérdida del 30 % de comandos", "dias": 3,
         "anomalias": [Anomalia("perdida_comandos", d, d + 24, params={"prob": 0.3})],
         "esperado": [], "criterios": {"confort_min_pct": 93, "dem_max_kw": lim * 1.08}},
        {"id": "P10", "nombre": "Sobrecalentamiento servidores (falla CRAC 1 h)", "dias": 3,
         "anomalias": [Anomalia("falla_hvac", d + 15, d + 16, "Z09")],
         "esperado": ["SERVIDOR_TEMP"], "criterios": {}},
    ]


def _ventana(df: pd.DataFrame, t0, h0: float, h1: float) -> pd.DataFrame:
    ts = pd.to_datetime(df["ts"]) if "ts" in df else pd.Series(df.index, index=df.index)
    h = (ts - t0).dt.total_seconds() / 3600
    return df[(h >= h0) & (h < h1)]


def pruebas(cfg: dict, controlador: str = "reglas_dr") -> tuple[pd.DataFrame, list[dict]]:
    filas, detalle = [], []
    for caso in _casos(cfg):
        t_ini = time.perf_counter()
        r = simular(cfg, controlador, dias=caso["dias"], anomalias=caso["anomalias"], nombre=caso["id"])
        dur = time.perf_counter() - t_ini
        k = kpi.energeticos(r, cfg)
        t0 = r.medidor.index[0]
        checks = {}
        codigos = set(r.alarmas["codigo"]) if len(r.alarmas) else set()
        for cod in caso["esperado"]:
            checks[f"alarma_{cod}"] = cod in codigos
        crit = caso["criterios"]
        if "confort_min_pct" in crit:
            checks["confort"] = k["confort_pct"] >= crit["confort_min_pct"]
        if "dem_max_kw" in crit:
            checks["demanda_max"] = k["demanda_max_15min_kw"] <= crit["dem_max_kw"]
        if "confort_vs_base_pp" in crit or "energia_vs_base" in crit:
            rb = simular(cfg, "baseline", dias=caso["dias"], anomalias=caso["anomalias"])
            kb = kpi.energeticos(rb, cfg)
            if "confort_vs_base_pp" in crit:
                checks["confort_vs_baseline"] = k["confort_pct"] - kb["confort_pct"] >= crit["confort_vs_base_pp"]
            if crit.get("energia_vs_base"):
                checks["energia_menor_baseline"] = k["energia_kwh"] < kb["energia_kwh"]
        rec_min = np.nan
        if "recuperacion" in crit:
            zid, h0, max_min = crit["recuperacion"]
            w = _ventana(r.zonas[r.zonas.zona == zid], t0, h0, h0 + 6)
            ok_t = w[w.temp_real_c <= cfg["ems"]["confort_max_c"]]
            if len(ok_t):
                rec_min = (pd.to_datetime(ok_t["ts"].iloc[0]) - t0).total_seconds() / 60 - h0 * 60
            checks["recuperacion"] = bool(len(ok_t)) and rec_min <= max_min
        if "zona_confort" in crit:
            zid, h0, h1, minimo = crit["zona_confort"]
            w = _ventana(r.zonas[r.zonas.zona == zid], t0, h0, h1)
            checks["confort_zona"] = ((w.temp_real_c <= cfg["ems"]["confort_max_c"]).mean() * 100) >= minimo
        if "zona_tmax" in crit:
            zid, h0, h1, tmax = crit["zona_tmax"]
            w = _ventana(r.zonas[r.zonas.zona == zid], t0, h0, h1)
            checks["temp_real_acotada"] = float(w.temp_real_c.max()) <= tmax
        resp_pasos = np.nan
        if "respuesta_dr" in crit:
            h0, max_pasos = crit["respuesta_dr"]
            e = r.estado.copy()
            e["h"] = (pd.to_datetime(e["ts"]) - t0).dt.total_seconds() / 3600
            act = e[(e.h >= h0) & (e.dr_activo)]
            if len(act):
                resp_pasos = int(round((act.h.iloc[0] - h0) * 60 / cfg["edificio"]["paso_min"]))
            checks["respuesta_dr"] = bool(len(act)) and resp_pasos <= max_pasos
        # estabilidad: conmutaciones de compresor por zona-hora (ciclado corto si > 6)
        zz = r.zonas[~r.zonas.critica].sort_values(["zona", "ts"])
        conm = zz.groupby("zona")["hvac_on"].apply(lambda s: s.astype(int).diff().abs().sum()).sum()
        horas_zona = len(zz) * cfg["edificio"]["paso_min"] / 60
        ciclos_h = conm / max(horas_zona, 1)
        checks["estabilidad"] = ciclos_h <= 6.0
        # disponibilidad de la lógica: pasos con decisión válida (no NaN, dentro del tiempo de paso)
        disp = float(np.mean(r.latencia_ms < cfg["edificio"]["paso_min"] * 60 * 1000) * 100)
        checks["disponibilidad"] = disp >= 99.9
        ok = sum(checks.values())
        filas.append({
            "id": caso["id"], "prueba": caso["nombre"], "controlador": controlador,
            "superada": all(checks.values()), "checks_ok": ok, "checks_total": len(checks),
            "confort_pct": round(k["confort_pct"], 2), "demanda_max_kw": round(k["demanda_max_15min_kw"], 1),
            "energia_dia_kwh": round(k["energia_dia_kwh"], 1),
            "alarmas": ";".join(sorted(codigos)),
            "conmutaciones_por_zona_h": round(ciclos_h, 3),
            "latencia_media_ms": round(k["latencia_media_ms"], 3), "latencia_p99_ms": round(k["latencia_p99_ms"], 3),
            "respuesta_dr_pasos": resp_pasos, "recuperacion_min": rec_min, "disponibilidad_pct": disp,
            "duracion_sim_s": round(dur, 2),
            "detalle_checks": ";".join(f"{c}={'OK' if v else 'FALLA'}" for c, v in checks.items()),
        })
        detalle.append({"caso": caso, "resultado": r})
    df = pd.DataFrame(filas)
    return df, detalle


def resumen_confiabilidad(df: pd.DataFrame) -> dict:
    return {
        "pruebas_superadas": int(df["superada"].sum()),
        "pruebas_total": int(len(df)),
        "confiabilidad_logica_pct": float(df["checks_ok"].sum() / df["checks_total"].sum() * 100),
        "disponibilidad_pct": float(df["disponibilidad_pct"].mean()),
        "latencia_media_ms": float(df["latencia_media_ms"].mean()),
        "latencia_p99_ms": float(df["latencia_p99_ms"].max()),
    }


# ============================================================================ sensibilidad
def sensibilidad(cfg: dict, controlador: str = "reglas_dr", dias: float = 7) -> pd.DataFrame:
    """Tornado: variación ±de parámetros técnicos (re-simula) y económicos (recalcula)."""
    base_res = simular(cfg, "baseline", dias=dias)
    kb = kpi.energeticos(base_res, cfg)
    ke = kpi.energeticos(simular(cfg, controlador, dias=dias), cfg)
    ref = kpi.economia(kb, ke, cfg)
    filas = [{"parametro": "referencia", "valor": "-", **_sel(ref)}]

    def fila(nombre, valor, eco):
        filas.append({"parametro": nombre, "valor": valor, **_sel(eco)})

    for f in (0.7, 1.3):
        fila("tarifa", f"{f:.0%}", kpi.economia(kb, ke, cfg, tarifa_factor=f))
        fila("capex", f"{f:.0%}", kpi.economia(kb, ke, cfg, capex_factor=f))
    tecnicos = [
        ("ems.setpoint_ocupado_c", [23.0, 25.0]),
        ("ems.limite_demanda_kw", [135, 160]),
        ("ems.equipos_desocupado_ems", [0.2, 0.4]),
        ("clima.t_max_c", [29.5, 33.5]),
    ]
    for clave, valores in tecnicos:
        for v in valores:
            c2 = m_config.aplicar(cfg, {clave: v})
            kb2 = kb if not clave.startswith("clima") else kpi.energeticos(simular(c2, "baseline", dias=dias), c2)
            ke2 = kpi.energeticos(simular(c2, controlador, dias=dias), c2)
            eco = kpi.economia(kb2, ke2, c2)
            eco["confort_pct"] = ke2["confort_pct"]
            fila(clave, v, eco)
    for f in (0.8, 1.2):
        kb2 = kpi.energeticos(simular(cfg, "baseline", dias=dias, factor_ocupacion=f), cfg)
        ke2 = kpi.energeticos(simular(cfg, controlador, dias=dias, factor_ocupacion=f), cfg)
        eco = kpi.economia(kb2, ke2, cfg)
        eco["confort_pct"] = ke2["confort_pct"]
        fila("ocupacion", f"{f:.0%}", eco)
    return pd.DataFrame(filas)


def _sel(e: dict) -> dict:
    claves = ["ahorro_pct", "energia_ahorrada_anual_kwh", "pico_evitado_kw", "ahorro_total_usd_anio",
              "vpn_usd", "payback_anios", "roi_pct", "costo_kwh_evitado_usd", "confort_pct"]
    return {k: e.get(k, np.nan) for k in claves}
