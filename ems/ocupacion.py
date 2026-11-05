"""Modelo de ocupación por tipo de zona (número de personas por paso)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import Zona


def _rampa(h: np.ndarray, a: float, b: float, ancho: float = 0.5) -> np.ndarray:
    """1 entre a y b con rampas lineales de 'ancho' horas."""
    sube = np.clip((h - (a - ancho / 2)) / ancho, 0, 1)
    baja = np.clip(((b + ancho / 2) - h) / ancho, 0, 1)
    return np.minimum(sube, baja)


def fraccion_tipo(tipo: str, h: np.ndarray, p: dict, rng: np.random.Generator, n_dias: int, dia: np.ndarray) -> np.ndarray:
    e, s = p["hora_entrada"], p["hora_salida"]
    a0, a1 = p["almuerzo"]
    base = _rampa(h, e, s, 1.0)
    almuerzo = _rampa(h, a0, a1, 0.3)
    if tipo == "oficina":
        return base * (1 - (1 - p["fraccion_almuerzo"]) * almuerzo) * 0.92
    if tipo == "lobby":
        picos = sum(np.exp(-((h - c) ** 2) / (2 * 0.25**2)) for c in (e, a0, a1, s))
        return np.clip(0.25 * base + 0.75 * picos, 0, 1)
    if tipo == "conferencia":
        # reuniones aleatorias de 1–2 h por día
        f = np.zeros_like(h)
        for d in range(n_dias):
            for _ in range(rng.integers(1, 4)):
                ini = rng.choice([8.5, 9.5, 10.5, 13.5, 14.5, 15.5])
                dur = rng.choice([1.0, 1.5, 2.0])
                llen = rng.uniform(0.4, 1.0)
                m = (dia == d) & (h >= ini) & (h < ini + dur)
                f[m] = np.maximum(f[m], llen)
        return f * base
    if tipo == "laboratorio":
        return _rampa(h, e + 0.5, s - 1.0, 1.0) * (1 - 0.5 * almuerzo) * 0.85
    if tipo == "cafeteria":
        desayuno = 0.30 * _rampa(h, 7.0, 8.5, 0.5)
        comida = 1.0 * _rampa(h, 11.75, 13.5, 0.5)
        cafe = 0.15 * base
        return np.clip(desayuno + comida + cafe, 0, 1)
    if tipo == "servidores":
        return 0.6 * _rampa(h, 9.0, 10.0, 0.25)  # visita técnica diaria
    if tipo == "soporte":
        return np.ones_like(h)  # vigilancia 24/7
    return base


def generar(zs: list[Zona], idx: pd.DatetimeIndex, p: dict, factor: float = 1.0) -> pd.DataFrame:
    """DataFrame [tiempo × zona] con el número de ocupantes (entero)."""
    rng = np.random.default_rng(p.get("semilla", 11))
    h = (idx.hour + idx.minute / 60.0).values
    dia = (idx.normalize() - idx[0].normalize()).days.values
    n_dias = int(dia.max()) + 1
    dow = idx.dayofweek.values
    out = {}
    for z in zs:
        f = fraccion_tipo(z.tipo, h, p, rng, n_dias, dia)
        if z.tipo != "soporte":
            f = np.where(dow == 5, f * p["fraccion_sabado"], f)
            f = np.where(dow == 6, 0.0, f)
            if z.tipo != "servidores":
                f = f * factor
        ruido = 1 + rng.normal(0, p["ruido"], len(h))
        ruido = pd.Series(ruido).rolling(3, min_periods=1).mean().values
        out[z.id] = np.clip(np.round(f * ruido * z.ocupantes), 0, z.ocupantes * 1.2).astype(int)
    return pd.DataFrame(out, index=idx)
