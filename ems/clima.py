"""Clima exterior: archivo EPW (Panamá-Albrook TMYx) o perfil sintético tropical.

Además de temperatura, humedad e irradiancia global horizontal, calcula la irradiancia sobre las
fachadas N, E, S y O (cielo isotrópico + reflejo del suelo) a partir de la posición solar, que es lo
que determina la ganancia por ventanas en un edificio con WWR ≈ 69 %.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .config import ORIENTACIONES, RAIZ

COLUMNAS = ["t_ext_c", "hr_pct", "irr_wm2", "irr_N", "irr_E", "irr_S", "irr_W", "irr_H"]


def indice(inicio: str | pd.Timestamp, dias: float, paso_min: int, tz: str = "America/Panama") -> pd.DatetimeIndex:
    t0 = pd.Timestamp(inicio)
    t0 = t0.tz_localize(tz) if t0.tzinfo is None else t0.tz_convert(tz)
    n = int(round(dias * 24 * 60 / paso_min))
    return pd.date_range(t0, periods=n, freq=f"{paso_min}min")


# ----------------------------------------------------------------------------- geometría solar
def posicion_solar(idx: pd.DatetimeIndex, lat: float, lon: float, tz_horas: float = -5.0) -> tuple[np.ndarray, np.ndarray]:
    """Cenit y azimut solar (grados; azimut desde el norte, sentido horario) para cada instante.

    Se usa el centro del paso para evitar sesgos al inicio/fin del día.
    """
    doy = idx.dayofyear.values
    h_local = (idx.hour + idx.minute / 60.0).values
    b = np.radians(360.0 / 365.0 * (doy - 81))
    eot = 9.87 * np.sin(2 * b) - 7.53 * np.cos(b) - 1.5 * np.sin(b)          # minutos
    decl = np.radians(23.45) * np.sin(np.radians(360.0 / 365.0 * (284 + doy)))
    t_solar = h_local + (4 * (lon - 15 * tz_horas) + eot) / 60.0
    w = np.radians(15.0 * (t_solar - 12.0))
    phi = np.radians(lat)
    cosz = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(w)
    zen = np.arccos(np.clip(cosz, -1, 1))
    sin_az = -np.cos(decl) * np.sin(w) / np.maximum(np.sin(zen), 1e-6)
    cos_az = (np.sin(decl) - np.sin(phi) * cosz) / np.maximum(np.cos(phi) * np.sin(zen), 1e-6)
    az = (np.degrees(np.arctan2(sin_az, cos_az)) + 360) % 360
    return np.degrees(zen), az


def separar_difusa(ghi: np.ndarray, zen_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Correlación de Erbs: GHI → (DNI, DHI) cuando el clima no trae las componentes."""
    cosz = np.cos(np.radians(zen_deg))
    i0h = 1367.0 * np.maximum(cosz, 0.0)
    kt = np.where(i0h > 10, np.clip(ghi / np.maximum(i0h, 1e-6), 0, 1), 0.0)
    fd = np.where(kt <= 0.22, 1 - 0.09 * kt,
                  np.where(kt <= 0.8, 0.9511 - 0.1604 * kt + 4.388 * kt**2 - 16.638 * kt**3 + 12.336 * kt**4, 0.165))
    dhi = ghi * fd
    dni = np.where(cosz > 0.05, (ghi - dhi) / np.maximum(cosz, 0.05), 0.0)
    return np.clip(dni, 0, 1100), dhi


def irradiancia_fachadas(ghi, dni, dhi, zen_deg, az_deg, rho: float = 0.2) -> dict[str, np.ndarray]:
    zen = np.radians(zen_deg)
    out = {"irr_H": np.asarray(ghi, float)}
    for o, gamma in ORIENTACIONES.items():
        cos_t = np.sin(zen) * np.cos(np.radians(az_deg - gamma))
        directa = dni * np.clip(cos_t, 0, None) * (zen_deg < 90)
        out[f"irr_{o}"] = directa + dhi * 0.5 + ghi * rho * 0.5
    return out


def _completar_solar(df: pd.DataFrame, cfg: dict, dni=None, dhi=None) -> pd.DataFrame:
    e = cfg["edificio"]
    zen, az = posicion_solar(df.index, e.get("latitud", 8.97), e.get("longitud", -79.5))
    ghi = df["irr_wm2"].values
    if dni is None or dhi is None:
        dni, dhi = separar_difusa(ghi, zen)
    for k, v in irradiancia_fachadas(ghi, dni, dhi, zen, az, e.get("reflectancia_suelo", 0.2)).items():
        df[k] = v
    return df


# ----------------------------------------------------------------------------- fuentes
def sintetico(idx: pd.DatetimeIndex, p: dict, desplazamiento_t: float = 0.0) -> pd.DataFrame:
    """Temperatura senoidal diaria + nubosidad estocástica (AR(1) diario y ruido intradía)."""
    rng = np.random.default_rng(p.get("semilla", 7))
    h = idx.hour + idx.minute / 60.0
    dias = (idx.normalize() - idx[0].normalize()).days.values
    n_dias = int(dias.max()) + 1
    nub_d = np.empty(n_dias)
    nub_d[0] = p["nubosidad_media"]
    for d in range(1, n_dias):
        nub_d[d] = 0.6 * nub_d[d - 1] + 0.4 * p["nubosidad_media"] + rng.normal(0, 0.12)
    nub_d = np.clip(nub_d, 0.0, 0.95)
    nub = np.clip(nub_d[dias] + rng.normal(0, 0.08, len(idx)), 0, 1)
    nub = pd.Series(nub).rolling(6, min_periods=1, center=True).mean().values
    x = (h - 6.25) / 12.0
    campana = np.where((x > 0) & (x < 1), np.sin(np.pi * np.clip(x, 0, 1)) ** 1.3, 0.0)
    ghi = p["irr_max_wm2"] * campana * (1 - 0.75 * nub)
    amp = (p["t_max_c"] - p["t_min_c"]) / 2
    media = (p["t_max_c"] + p["t_min_c"]) / 2
    fase = np.cos(2 * np.pi * (h - p["hora_t_max"]) / 24.0)
    t_ext = media + amp * fase * (1 - 0.35 * nub) + rng.normal(0, 0.15, len(idx)) + desplazamiento_t
    hr = np.clip(88 - 2.4 * (t_ext - p["t_min_c"]) + 10 * nub, 55, 98)
    return pd.DataFrame({"t_ext_c": t_ext, "hr_pct": hr, "irr_wm2": ghi}, index=idx)


def leer_epw(ruta: str | Path, idx: pd.DatetimeIndex, desplazamiento_t: float = 0.0) -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Lee un EPW (8760 h) y lo interpola al índice pedido usando día del año y hora.

    El EPW reporta promedios de la hora que termina en `hora`: se ubican en el centro de cada hora.
    """
    cols = {6: "t_ext_c", 8: "hr_pct", 13: "irr_wm2", 14: "dni", 15: "dhi"}
    df = pd.read_csv(ruta, skiprows=8, header=None, usecols=list(cols))
    df.columns = [cols[c] for c in sorted(cols)]
    horas = np.arange(len(df)) + 0.5
    hora_anual = ((idx.dayofyear - 1) * 24 + idx.hour + idx.minute / 60.0).values
    hora_anual = np.minimum(hora_anual, len(df) - 1e-6)  # años bisiestos: 31-dic usa el último día
    out = {c: np.interp(hora_anual, horas, df[c].values, period=len(df)) for c in df.columns}
    res = pd.DataFrame({k: out[k] for k in ("t_ext_c", "hr_pct", "irr_wm2")}, index=idx)
    res["t_ext_c"] += desplazamiento_t
    return res, out["dni"], out["dhi"]


def ruta_epw(cfg: dict) -> Path | None:
    p = cfg["clima"].get("epw")
    if not p:
        return None
    ruta = Path(p)
    if not ruta.is_absolute():
        ruta = RAIZ / ruta
    return ruta if ruta.exists() else None


def generar(cfg: dict, idx: pd.DatetimeIndex, desplazamiento_t: float = 0.0) -> pd.DataFrame:
    p = cfg["clima"]
    epw = ruta_epw(cfg) if p.get("fuente") == "epw" else None
    if epw is not None:
        df, dni, dhi = leer_epw(epw, idx, desplazamiento_t)
        return _completar_solar(df, cfg, dni, dhi)[COLUMNAS]
    return _completar_solar(sintetico(idx, p, desplazamiento_t), cfg)[COLUMNAS]
