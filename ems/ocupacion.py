"""Ocupación por zona según los horarios del modelo E+ ("Programacion de horarios"), con variación.

Número de personas = fracción del horario × aforo de diseño × (1 − ausentismo del día) × ruido.
El pasillo no tiene aforo en el modelo: se considera "en tránsito" (ocupado) cuando hay gente en el
edificio, lo que el EMS usa para decidir su climatización.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import Zona, horario


def fraccion(cfg: dict, nombre: str, idx: pd.DatetimeIndex) -> np.ndarray:
    dow = idx.dayofweek.values
    h = (idx.hour + idx.minute / 60.0).values
    # el horario es escalonado: se evalúa una vez por (día de semana, hora del día) para ir rápido
    claves = dow * 10000 + np.round(h * 100).astype(int)
    unicos, inv = np.unique(claves, return_inverse=True)
    vals = np.array([horario(cfg, nombre, int(k // 10000), (k % 10000) / 100.0) for k in unicos])
    return vals[inv]


def generar(zs: list[Zona], idx: pd.DatetimeIndex, cfg_o: dict, factor: float = 1.0, cfg: dict | None = None) -> pd.DataFrame:
    """DataFrame [tiempo × zona] con el número de ocupantes (entero)."""
    if cfg is None:
        raise ValueError("generar() necesita la configuración completa (horarios)")
    rng = np.random.default_rng(cfg_o.get("semilla", 11))
    dia = (idx.normalize() - idx[0].normalize()).days.values
    n_dias = int(dia.max()) + 1
    laborable = idx.dayofweek.values < 5
    out = {}
    for z in zs:
        f = fraccion(cfg, z.horario_ocupacion, idx)
        aus = np.clip(rng.normal(cfg_o.get("ausentismo", 0.0), 0.05, n_dias), 0, 0.5)[dia]
        f = f * np.where(laborable, 1 - aus, 1.0) * factor
        ruido = pd.Series(1 + rng.normal(0, cfg_o.get("ruido", 0.1), len(idx))).rolling(3, min_periods=1).mean().values
        out[z.id] = np.clip(np.round(f * ruido * z.ocupantes), 0, max(z.ocupantes * 1.2, 0)).astype(int)
    return pd.DataFrame(out, index=idx)
