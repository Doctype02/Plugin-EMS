"""Clima exterior: perfil sintético tropical (Ciudad de Panamá) o archivo EPW."""
from __future__ import annotations

import numpy as np
import pandas as pd


def indice(inicio: str | pd.Timestamp, dias: float, paso_min: int, tz: str = "America/Panama") -> pd.DatetimeIndex:
    t0 = pd.Timestamp(inicio)
    t0 = t0.tz_localize(tz) if t0.tzinfo is None else t0.tz_convert(tz)
    n = int(round(dias * 24 * 60 / paso_min))
    return pd.date_range(t0, periods=n, freq=f"{paso_min}min")


def sintetico(idx: pd.DatetimeIndex, p: dict, desplazamiento_t: float = 0.0) -> pd.DataFrame:
    """Temperatura senoidal diaria + nubosidad estocástica (AR(1) diario y ruido intradía)."""
    rng = np.random.default_rng(p.get("semilla", 7))
    h = idx.hour + idx.minute / 60.0
    dias = (idx.normalize() - idx[0].normalize()).days.values
    n_dias = int(dias.max()) + 1

    # nubosidad diaria AR(1)
    nub_d = np.empty(n_dias)
    nub_d[0] = p["nubosidad_media"]
    for d in range(1, n_dias):
        nub_d[d] = 0.6 * nub_d[d - 1] + 0.4 * p["nubosidad_media"] + rng.normal(0, 0.12)
    nub_d = np.clip(nub_d, 0.0, 0.95)
    nub = np.clip(nub_d[dias] + rng.normal(0, 0.08, len(idx)), 0, 1)
    nub = pd.Series(nub).rolling(6, min_periods=1, center=True).mean().values

    # irradiancia global horizontal (campana entre 6:15 y 18:15, latitud ~9°N)
    x = (h - 6.25) / 12.0
    campana = np.where((x > 0) & (x < 1), np.sin(np.pi * np.clip(x, 0, 1)) ** 1.3, 0.0)
    ghi = p["irr_max_wm2"] * campana * (1 - 0.75 * nub)

    # temperatura: mínima ~6:00, máxima a hora_t_max; la nubosidad reduce la amplitud
    amp = (p["t_max_c"] - p["t_min_c"]) / 2
    media = (p["t_max_c"] + p["t_min_c"]) / 2
    fase = np.cos(2 * np.pi * (h - p["hora_t_max"]) / 24.0)
    t_ext = media + amp * fase * (1 - 0.35 * nub) + rng.normal(0, 0.15, len(idx)) + desplazamiento_t
    hr = np.clip(88 - 2.4 * (t_ext - p["t_min_c"]) + 10 * nub, 55, 98)

    return pd.DataFrame({"t_ext_c": t_ext, "hr_pct": hr, "irr_wm2": ghi}, index=idx)


def leer_epw(ruta: str, idx: pd.DatetimeIndex, desplazamiento_t: float = 0.0) -> pd.DataFrame:
    """Lee un EPW (8760 h) y lo interpola al índice pedido usando día del año y hora."""
    cols = {6: "t_ext_c", 8: "hr_pct", 13: "irr_wm2"}
    df = pd.read_csv(ruta, skiprows=8, header=None, usecols=list(cols))
    df.columns = [cols[c] for c in sorted(cols)]
    horas = np.arange(len(df)) + 0.5  # EPW: valor al final de la hora
    hora_anual = ((idx.dayofyear - 1) * 24 + idx.hour + idx.minute / 60.0).values
    out = {c: np.interp(hora_anual, horas, df[c].values, period=len(df)) for c in df.columns}
    res = pd.DataFrame(out, index=idx)
    res["t_ext_c"] += desplazamiento_t
    return res


def generar(cfg: dict, idx: pd.DatetimeIndex, desplazamiento_t: float = 0.0) -> pd.DataFrame:
    p = cfg["clima"]
    if p.get("fuente") == "epw" and p.get("epw"):
        return leer_epw(p["epw"], idx, desplazamiento_t)
    return sintetico(idx, p, desplazamiento_t)
