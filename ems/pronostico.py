"""Pronóstico de carga del día siguiente (horario) y validación con MAE / RMSE / MAPE.

Modelos:
- `persistencia`: mismo día de la semana anterior (referencia ingenua).
- `regresion`: mínimos cuadrados con hora×tipo de día (laborable/sábado/domingo), temperatura e
  irradiancia pronosticadas y carga de la misma hora 24 h y 168 h antes.
- `sarimax`: SARIMAX(1,0,1)(1,1,0,24) con temperatura e indicadores de horario exógenos (statsmodels), actualizado cada día
  sin reestimar parámetros.

El pronóstico se emite a las 00:00 de cada día de prueba usando sólo información disponible.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd


def metricas(real: np.ndarray, pred: np.ndarray) -> dict:
    real, pred = np.asarray(real, float), np.asarray(pred, float)
    err = pred - real
    return {
        "mae_kw": float(np.mean(np.abs(err))),
        "rmse_kw": float(np.sqrt(np.mean(err**2))),
        "mape_pct": float(np.mean(np.abs(err) / np.maximum(np.abs(real), 1e-6)) * 100),
        "error_pico_kw": float(pred.max() - real.max()),
        "r2": float(1 - np.sum(err**2) / np.sum((real - real.mean()) ** 2)),
    }


def a_horario(medidor: pd.DataFrame) -> pd.DataFrame:
    h = medidor[["p_total_kw", "t_ext_c", "irr_wm2"]].resample("1h").mean()
    return h


def _tipo_dia(idx: pd.DatetimeIndex) -> np.ndarray:
    return np.where(idx.dayofweek < 5, 0, np.where(idx.dayofweek == 5, 1, 2))


def _diseno(df: pd.DataFrame, rng: np.random.Generator, ruido_t: float = 0.7) -> np.ndarray:
    """Matriz de diseño. La meteorología se toma como 'pronóstico' (real + ruido)."""
    idx = df.index
    td = _tipo_dia(idx)
    cols = []
    for k in range(3):
        for hh in range(24):
            cols.append(((td == k) & (idx.hour == hh)).astype(float))
    t_pron = df["t_ext_c"].values + rng.normal(0, ruido_t, len(df))
    irr_pron = df["irr_wm2"].values * (1 + rng.normal(0, 0.15, len(df)))
    lab = (td == 0).astype(float)
    cols += [t_pron * lab, t_pron * (1 - lab), irr_pron / 1000 * lab, df["lag24"].values, df["lag168"].values]
    return np.column_stack(cols)


def regresion(h: pd.DataFrame, dias_prueba: int, semilla: int = 5) -> tuple[pd.Series, np.ndarray]:
    rng = np.random.default_rng(semilla)
    df = h.copy()
    df["lag24"] = df["p_total_kw"].shift(24)
    df["lag168"] = df["p_total_kw"].shift(168)
    df = df.dropna()
    corte = df.index[-1].normalize() - pd.Timedelta(days=dias_prueba - 1)
    tr, te = df[df.index < corte], df[df.index >= corte]
    X, y = _diseno(tr, rng), tr["p_total_kw"].values
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    # lag24 del día pronosticado = carga del día anterior (disponible a las 00:00)
    pred = _diseno(te, rng) @ beta
    return pd.Series(pred, index=te.index, name="regresion"), beta


def persistencia(h: pd.DataFrame, dias_prueba: int) -> pd.Series:
    s = h["p_total_kw"].shift(168)
    corte = h.index[-1].normalize() - pd.Timedelta(days=dias_prueba - 1)
    return s[s.index >= corte].rename("persistencia")


def _exog_sarimax(h: pd.DataFrame) -> pd.DataFrame:
    """Temperatura + indicadores de horario laboral (lun-vie 7-18 h y sábado 8-13 h)."""
    idx = h.index
    hh = idx.hour
    return pd.DataFrame({
        "t_ext_c": h["t_ext_c"].values,
        "laboral": ((idx.dayofweek < 5) & (hh >= 7) & (hh < 18)).astype(float),
        "sabado": ((idx.dayofweek == 5) & (hh >= 8) & (hh < 13)).astype(float),
    }, index=idx)


def sarimax(h: pd.DataFrame, dias_prueba: int, semilla: int = 5) -> pd.Series:
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    rng = np.random.default_rng(semilla)
    corte = h.index[-1].normalize() - pd.Timedelta(days=dias_prueba - 1)
    y = h["p_total_kw"].asfreq("1h")
    x = _exog_sarimax(h).asfreq("1h")
    ytr, xtr = y[y.index < corte], x[x.index < corte]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = SARIMAX(ytr, exog=xtr, order=(1, 0, 1), seasonal_order=(1, 1, 0, 24),
                      enforce_stationarity=False, enforce_invertibility=False).fit(disp=False, maxiter=80)
        preds = []
        actual = res
        for d in range(dias_prueba):
            ini = corte + pd.Timedelta(days=d)
            fin = ini + pd.Timedelta(hours=23)
            x_d = x.loc[ini:fin].values.copy()
            x_d[:, 0] += rng.normal(0, 0.7, 24)
            f = actual.forecast(steps=24, exog=x_d)
            preds.append(pd.Series(np.asarray(f), index=y.loc[ini:fin].index))
            actual = actual.append(y.loc[ini:fin], exog=x.loc[ini:fin], refit=False)
    return pd.concat(preds).rename("sarimax")


def evaluar(medidor: pd.DataFrame, dias_prueba: int = 7, usar_sarimax: bool = True) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Devuelve (serie real vs pronósticos, tabla de métricas por modelo)."""
    h = a_horario(medidor)
    reg, _ = regresion(h, dias_prueba)
    out = pd.DataFrame({"real": h["p_total_kw"]}).loc[reg.index]
    out["regresion"] = reg
    out["persistencia"] = persistencia(h, dias_prueba).reindex(out.index)
    if usar_sarimax:
        try:
            out["sarimax"] = sarimax(h, dias_prueba).reindex(out.index)
        except Exception as exc:  # pragma: no cover - statsmodels opcional
            print(f"[pronostico] SARIMAX omitido: {exc}")
    met = pd.DataFrame({m: metricas(out["real"], out[m]) for m in out.columns if m != "real"}).T
    met.index.name = "modelo"
    return out, met


def dia_siguiente(medidor: pd.DataFrame, semilla: int = 5) -> pd.Series:
    """Pronóstico operativo para las 24 h siguientes al último dato (para publicar en MQTT/Grafana)."""
    h = a_horario(medidor)
    rng = np.random.default_rng(semilla)
    df = h.copy()
    df["lag24"] = df["p_total_kw"].shift(24)
    df["lag168"] = df["p_total_kw"].shift(168)
    df = df.dropna()
    beta, *_ = np.linalg.lstsq(_diseno(df, rng), df["p_total_kw"].values, rcond=None)
    fut_idx = pd.date_range(h.index[-1] + pd.Timedelta(hours=1), periods=24, freq="1h")
    fut = pd.DataFrame(index=fut_idx)
    prev = h.loc[fut_idx - pd.Timedelta(days=7)]  # meteorología y forma de la semana anterior como proxy
    fut["t_ext_c"] = prev["t_ext_c"].values
    fut["irr_wm2"] = prev["irr_wm2"].values
    fut["lag24"] = h["p_total_kw"].reindex(fut_idx - pd.Timedelta(days=1)).values
    fut["lag168"] = prev["p_total_kw"].values
    return pd.Series(_diseno(fut, rng, 0.0) @ beta, index=fut_idx, name="p_kw")
