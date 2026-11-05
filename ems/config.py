"""Carga y acceso a los parámetros del edificio (config/edificio.yaml)."""
from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

RAIZ = Path(__file__).resolve().parent.parent
CONFIG_DEFECTO = RAIZ / "config" / "edificio.yaml"


@dataclass
class Zona:
    id: str
    nombre: str
    tipo: str
    critica: bool
    area: float
    ocupantes: int
    lpd: float           # W/m2 iluminación
    epd: float           # W/m2 equipos
    ua: float            # kW/K envolvente + infiltración
    c: float             # kWh/K capacitancia térmica
    ventana: float       # m2
    shgc: float
    hvac_kw: float       # capacidad térmica total (kW)
    cop: float
    lux_dia_max: float
    it_kw: float = 0.0
    setpoint_fijo: float | None = None
    min_equipos: float = 0.10

    @property
    def p_luces_max_kw(self) -> float:
        return self.lpd * self.area / 1000.0

    @property
    def p_equipos_max_kw(self) -> float:
        return self.epd * self.area / 1000.0


def cargar(ruta: str | Path | None = None, sobrescribir: dict | None = None) -> dict[str, Any]:
    """Lee el YAML y aplica sobrescrituras con notación 'seccion.clave' (útil para sensibilidad)."""
    with open(ruta or CONFIG_DEFECTO, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if sobrescribir:
        cfg = aplicar(cfg, sobrescribir)
    return cfg


def aplicar(cfg: dict, sobrescribir: dict) -> dict:
    cfg = copy.deepcopy(cfg)
    for clave, valor in sobrescribir.items():
        nodo = cfg
        partes = clave.split(".")
        for p in partes[:-1]:
            nodo = nodo[p]
        nodo[partes[-1]] = valor
    return cfg


def zonas(cfg: dict) -> list[Zona]:
    return [Zona(**z) for z in cfg["zonas"]]
