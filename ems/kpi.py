"""Indicadores energéticos, de confort, económicos y ambientales."""
from __future__ import annotations

import numpy as np
import pandas as pd

SEMANAS_ANIO = 365 / 7


def energeticos(res, cfg: dict) -> dict:
    m, z = res.medidor, res.zonas
    paso_h = cfg["edificio"]["paso_min"] / 60
    e = float(m["p_total_kw"].sum() * paso_h)
    costo_e = float((m["p_total_kw"] * m["precio_usd_kwh"]).sum() * paso_h)
    dias = len(m) * paso_h / 24
    occ = z[z["ocupado"] & ~z["critica"]]
    t = occ["temp_real_c"]
    em = cfg["ems"]
    confort = float(((t >= em["confort_min_c"]) & (t <= em["confort_max_c"])).mean() * 100) if len(t) else 100.0
    grados_h = float((np.clip(t - em["confort_max_c"], 0, None)).sum() * paso_h)
    crit = z[z["critica"]]
    srv_ok = float((z.loc[z["tipo"] == "servidores", "temp_real_c"] <= em["alarma_servidor_c"]).mean() * 100)
    return {
        "dias": dias,
        "energia_kwh": e,
        "energia_dia_kwh": e / dias,
        "pico_kw": float(m["p_total_kw"].max()),
        "demanda_max_15min_kw": float(m["demanda_15min_kw"].max()),
        "p_media_kw": float(m["p_total_kw"].mean()),
        "factor_carga": float(m["p_total_kw"].mean() / m["demanda_15min_kw"].max()),
        "fp_medio": float(m["fp"].mean()),
        "e_hvac_kwh": float(m["p_hvac_kw"].sum() * paso_h),
        "e_luces_kwh": float(m["p_luces_kw"].sum() * paso_h),
        "e_equipos_kwh": float(m["p_equipos_kw"].sum() * paso_h),
        "e_critica_kwh": float(m["p_critica_kw"].sum() * paso_h),
        "costo_energia_usd": costo_e,
        "co2_kg": e * cfg["tarifa"]["factor_co2_kg_kwh"],
        "confort_pct": confort,
        "grados_hora_exceso": grados_h,
        "servidores_ok_pct": srv_ok,
        "n_alarmas": int(len(res.alarmas)),
        "latencia_media_ms": float(np.mean(res.latencia_ms)) if len(res.latencia_ms) else 0.0,
        "latencia_p99_ms": float(np.percentile(res.latencia_ms, 99)) if len(res.latencia_ms) else 0.0,
    }


def anualizar(k: dict, cfg: dict) -> dict:
    f = 365 / k["dias"]
    cargo = cfg["tarifa"]["cargo_demanda_usd_kw_mes"]
    return {
        "energia_anual_kwh": k["energia_kwh"] * f,
        "costo_energia_anual_usd": k["costo_energia_usd"] * f,
        "costo_demanda_anual_usd": k["demanda_max_15min_kw"] * cargo * 12,
        "co2_anual_t": k["co2_kg"] * f / 1000,
    }


def capex(cfg: dict) -> float:
    return float(sum(cfg["economia"]["capex_usd"].values()))


def economia(base: dict, esc: dict, cfg: dict, capex_factor: float = 1.0, tarifa_factor: float = 1.0) -> dict:
    """Compara un escenario EMS contra la línea base (ambos dicts de `energeticos`)."""
    ec = cfg["economia"]
    ab, ae = anualizar(base, cfg), anualizar(esc, cfg)
    kwh_ahorro = ab["energia_anual_kwh"] - ae["energia_anual_kwh"]
    ahorro_e = (ab["costo_energia_anual_usd"] - ae["costo_energia_anual_usd"]) * tarifa_factor
    ahorro_d = (ab["costo_demanda_anual_usd"] - ae["costo_demanda_anual_usd"]) * tarifa_factor
    ahorro = ahorro_e + ahorro_d
    inv = capex(cfg) * capex_factor
    neto = ahorro - ec["opex_usd_anio"]
    r, n, g = ec["tasa_descuento"], ec["vida_util_anios"], ec["escalamiento_tarifa_anual"]
    flujos = [neto * (1 + g) ** (a - 1) if a else -inv for a in range(n + 1)]
    vpn = sum(f / (1 + r) ** a for a, f in enumerate(flujos))
    crf = r * (1 + r) ** n / ((1 + r) ** n - 1)
    costo_anual_ems = inv * crf + ec["opex_usd_anio"]
    acum, payback = -inv, None
    for a in range(1, n + 1):
        prev = acum
        acum += flujos[a]
        if acum >= 0 and payback is None:
            payback = a - 1 + (-prev / flujos[a])
    try:
        tir = _tir(flujos)
    except Exception:
        tir = float("nan")
    return {
        "energia_ahorrada_anual_kwh": kwh_ahorro,
        "ahorro_pct": kwh_ahorro / ab["energia_anual_kwh"] * 100,
        "pico_evitado_kw": base["demanda_max_15min_kw"] - esc["demanda_max_15min_kw"],
        "pico_evitado_pct": (base["demanda_max_15min_kw"] - esc["demanda_max_15min_kw"]) / base["demanda_max_15min_kw"] * 100,
        "ahorro_energia_usd_anio": ahorro_e,
        "ahorro_demanda_usd_anio": ahorro_d,
        "ahorro_total_usd_anio": ahorro,
        "co2_evitado_t_anio": ab["co2_anual_t"] - ae["co2_anual_t"],
        "capex_usd": inv,
        "vpn_usd": vpn,
        "tir_pct": tir * 100,
        "payback_anios": payback if payback is not None else float("inf"),
        "roi_pct": (sum(flujos[1:]) - inv) / inv * 100,
        "costo_kwh_evitado_usd": costo_anual_ems / kwh_ahorro if kwh_ahorro > 0 else float("inf"),
        "precio_medio_kwh_usd": ab["costo_energia_anual_usd"] / ab["energia_anual_kwh"],
    }


def _tir(flujos: list[float]) -> float:
    lo, hi = -0.99, 5.0
    f = lambda r: sum(c / (1 + r) ** i for i, c in enumerate(flujos))
    if f(lo) * f(hi) > 0:
        return float("nan")
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def escalamiento_panama(eco: dict, area_m2: float, p: dict | None = None) -> pd.DataFrame:
    """Extrapolación del ahorro por m² al parque de edificios comerciales/oficinas de Panamá.

    Supuestos (verificar con SNE/ASEP y anuarios del INEC): área de oficinas climatizadas con
    potencial de EMS en Panamá y niveles de adopción. Los valores por m² vienen de la simulación.
    """
    p = p or {"area_oficinas_m2": 6.0e6, "adopcion": [0.05, 0.15, 0.30], "factor_co2_kg_kwh": 0.31}
    kwh_m2 = eco["energia_ahorrada_anual_kwh"] / area_m2
    kw_m2 = eco["pico_evitado_kw"] / area_m2
    usd_m2 = eco["ahorro_total_usd_anio"] / area_m2
    capex_m2 = eco["capex_usd"] / area_m2
    filas = []
    for a in p["adopcion"]:
        area = p["area_oficinas_m2"] * a
        filas.append({
            "adopcion_pct": a * 100,
            "area_m2": area,
            "edificios_equivalentes": area / area_m2,
            "energia_ahorrada_gwh_anio": kwh_m2 * area / 1e6,
            "demanda_evitada_mw": kw_m2 * area / 1e3,
            "ahorro_musd_anio": usd_m2 * area / 1e6,
            "inversion_musd": capex_m2 * area / 1e6,
            "co2_evitado_kt_anio": kwh_m2 * area * p["factor_co2_kg_kwh"] / 1e6,
        })
    return pd.DataFrame(filas)
