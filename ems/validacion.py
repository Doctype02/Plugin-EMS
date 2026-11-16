"""Validación y calibración del gemelo digital contra la simulación de EnergyPlus del edificio.

Criterios de ASHRAE Guideline 14 para datos horarios: |NMBE| ≤ 10 % y CV(RMSE) ≤ 30 %.
Los datos de referencia están en data/energyplus/ (tools/importar_energyplus.py). El calendario es el
de la simulación de E+ (año 2006, 1 de enero = domingo).
"""
from __future__ import annotations

import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as m_config
from .config import RAIZ
from .simulacion import simular

DATOS = RAIZ / "data" / "energyplus"
TZ = "America/Panama"
SEMANAS_CALIBRACION = [("2006-02-12", 8), ("2006-08-13", 8)]  # estación seca y lluviosa (1 día de arranque)


def _local(ts: pd.Series) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(pd.to_datetime(ts)).tz_localize(TZ)


def cargar_energyplus() -> dict:
    el = pd.read_csv(DATOS / "electricidad_10min.csv")
    el.index = _local(el.pop("ts"))
    zonas = pd.read_csv(DATOS / "zonas_horario.csv")
    zonas.index = _local(zonas.pop("ts"))
    resumen = json.loads((DATOS / "resumen_anual.json").read_text(encoding="utf-8"))
    out = {"electricidad": el["p_total_kw"], "zonas": zonas, "resumen": resumen}
    if (DATOS / "fv_horario.csv").exists():
        fv = pd.read_csv(DATOS / "fv_horario.csv")
        fv.index = _local(fv.pop("ts"))
        out["fv_dc"] = fv["p_fv_dc_kw"]
    return out


def metricas(medido: pd.Series, modelo: pd.Series) -> dict:
    """NMBE y CV(RMSE) (ASHRAE G14, p = 1) del modelo frente a la referencia."""
    a, b = medido.align(modelo, join="inner")
    n = len(a)
    media = a.mean()
    nmbe = (a - b).sum() / ((n - 1) * media) * 100
    cvrmse = np.sqrt(((a - b) ** 2).sum() / (n - 1)) / media * 100
    return {"n": int(n), "nmbe_pct": float(nmbe), "cvrmse_pct": float(cvrmse),
            "cumple_g14": bool(abs(nmbe) <= 10 and cvrmse <= 30), "r2": float(np.corrcoef(a, b)[0, 1] ** 2)}


def comparar(cfg: dict, inicio: str, dias: float, ref: dict | None = None) -> dict:
    """Corre la línea base (operación del modelo E+) y la compara hora a hora con EnergyPlus:
    electricidad total, equipos de las zonas, fotovoltaica y temperatura de cada zona en horario ocupado."""
    ref = ref or cargar_energyplus()
    r = simular(cfg, "baseline", dias=dias, inicio=inicio)
    m = r.medidor
    z = r.zonas.copy()
    z["ts"] = pd.to_datetime(z["ts"])
    t0, t1 = m.index[0], m.index[-1]
    # serie horaria (inicio de intervalo) de ambos modelos; se descarta el primer día (arranque)
    desde = t0 + pd.Timedelta(days=1)
    mod_h = m["p_total_kw"].resample("1h").mean().loc[desde:t1]
    ep_h = ref["electricidad"].resample("1h").mean().loc[desde:t1]
    eq_mod = z.groupby("ts")["p_equipos_kw"].sum().resample("1h").mean().loc[desde:t1]
    eq_ep = ref["zonas"].groupby(level=0)["p_equipos_kw"].sum().loc[desde:t1]
    temp_mod = z.set_index("ts").groupby("zona")["temp_real_c"].resample("1h").mean().unstack(0).loc[desde:t1]
    temp_ep = ref["zonas"].pivot_table(index=ref["zonas"].index, columns="zona", values="temp_c").loc[desde:t1]
    idx = temp_ep.index
    ocup = pd.Series((idx.dayofweek < 5) & (idx.hour >= 8) & (idx.hour < 18), index=idx)  # BASE_Ocupacion
    rmse_t = {}
    for zid in temp_mod.columns:
        a, b = temp_ep[zid].align(temp_mod[zid], join="inner")
        sel = ocup.reindex(a.index).fillna(False)
        rmse_t[zid] = float(np.sqrt(((a[sel] - b[sel]) ** 2).mean())) if sel.any() else float("nan")
    series = {"energyplus_kw": ep_h, "modelo_kw": mod_h, "equipos_energyplus_kw": eq_ep, "equipos_modelo_kw": eq_mod}
    out = {
        "periodo": f"{desde.date()} → {t1.date()}",
        "electricidad_total": metricas(ep_h, mod_h),
        "equipos": metricas(eq_ep, eq_mod),
        "energia_kwh": {"energyplus": float(ep_h.sum()), "modelo": float(mod_h.sum())},
        "pico_kw": {"energyplus": float(ep_h.max()), "modelo": float(mod_h.max())},
        "rmse_temp_ocupado_c": rmse_t,
    }
    if "fv_dc" in ref and "p_fv_kw" in m:
        fv_ep = ref["fv_dc"].loc[desde:t1] * cfg["fv"]["inversor"]
        fv_mod = m["p_fv_kw"].resample("1h").mean().loc[desde:t1]
        out["fv"] = {**metricas(fv_ep[fv_ep.index.hour.isin(range(7, 18))], fv_mod[fv_mod.index.hour.isin(range(7, 18))]),
                     "energia_kwh": {"energyplus": float(fv_ep.sum()), "modelo": float(fv_mod.sum())}}
        series.update({"fv_energyplus_kw": fv_ep, "fv_modelo_kw": fv_mod})
    out["series"] = pd.DataFrame(series)
    return out


PARAMETROS_CALIBRACION = {
    "edificio.factor_cop": [0.8, 1.0, 1.2],                  # COP estacional de VRF/PTAC (sin datos por sistema)
    "edificio.capacitancia_kwh_k_m2": [0.03, 0.08],          # masa térmica efectiva
    "edificio.factor_solar": [0.5, 0.9],                     # fracción solar que llega al aire de inmediato
    "edificio.delta_t_cielo_c": [3.0, 6.0],                  # radiación al cielo (Text equivalente)
    "edificio.fraccion_latente_serpentin": [0.10, 0.25],     # latente retirado por el serpentín
}


def calibrar(cfg: dict, rejilla: dict | None = None, semanas=SEMANAS_CALIBRACION) -> tuple[dict, pd.DataFrame]:
    """Búsqueda en rejilla de los parámetros efectivos del modelo RC (los que no vienen del IDF),
    minimizando CV(RMSE) + |NMBE| de la electricidad horaria frente a E+ en dos semanas típicas."""
    rejilla = rejilla or PARAMETROS_CALIBRACION
    ref = cargar_energyplus()
    claves = list(rejilla)
    filas = []
    for valores in itertools.product(*rejilla.values()):
        c2 = m_config.aplicar(cfg, dict(zip(claves, valores)))
        res = [comparar(c2, ini, dias, ref) for ini, dias in semanas]
        cv = float(np.mean([x["electricidad_total"]["cvrmse_pct"] for x in res]))
        nm = float(np.mean([x["electricidad_total"]["nmbe_pct"] for x in res]))
        pico = float(np.mean([x["pico_kw"]["modelo"] / x["pico_kw"]["energyplus"] - 1 for x in res]) * 100)
        filas.append({**{k.split(".")[-1]: v for k, v in zip(claves, valores)}, "cvrmse_pct": cv, "nmbe_pct": nm,
                      "error_pico_pct": pico, "objetivo": cv + abs(nm) + 0.5 * abs(pico)})
    tabla = pd.DataFrame(filas).sort_values("objetivo").reset_index(drop=True)
    mejor = {k: float(tabla.iloc[0][k.split(".")[-1]]) for k in claves}
    return mejor, tabla


def anual(cfg: dict) -> dict:
    """Año completo con el EPW: usos finales y pico frente al resumen anual de E+."""
    ref = cargar_energyplus()
    r = simular(cfg, "baseline", dias=365, inicio="2006-01-01")
    paso_h = cfg["edificio"]["paso_min"] / 60
    m = r.medidor
    z = r.zonas
    fan = float(z["p_ventilador_kw"].sum() * paso_h)
    usos_modelo = {
        "Cooling": float(m["p_hvac_kw"].sum() * paso_h) - fan,
        "Fans": fan,
        "Interior Lighting": float(m["p_luces_kw"].sum() * paso_h),
        "Interior Equipment": float(m["p_equipos_kw"].sum() * paso_h),
        "Total End Uses": float(m["p_total_kw"].sum() * paso_h),
    }
    usos_ep = ref["resumen"]["energia_anual_kwh"]
    tabla = pd.DataFrame({"energyplus_kwh": {k: usos_ep.get(k, np.nan) for k in usos_modelo}, "modelo_kwh": usos_modelo})
    tabla["diferencia_pct"] = (tabla.modelo_kwh - tabla.energyplus_kwh) / tabla.energyplus_kwh * 100
    ep_h = ref["electricidad"].resample("1h").mean()
    mod_h = m["p_total_kw"].resample("1h").mean()
    return {"usos": tabla, "horario": metricas(ep_h.iloc[24:], mod_h.iloc[24:]),
            "pico_kw": {"energyplus": float(ref["resumen"]["pico_kw"]["Total End Uses"]), "modelo": float(m["demanda_15min_kw"].max())},
            "resultado": r}
