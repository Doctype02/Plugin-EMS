"""Carga y acceso a los parámetros del edificio (config/edificio.yaml)."""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

RAIZ = Path(__file__).resolve().parent.parent
CONFIG_DEFECTO = RAIZ / "config" / "edificio.yaml"
RHO_CP = 1.2 * 1.006  # kJ/(m3·K): con m3/s da kW/K
ORIENTACIONES = {"N": 0.0, "E": 90.0, "S": 180.0, "W": 270.0}


@dataclass
class Zona:
    id: str
    nombre: str
    tipo: str
    critica: bool
    planta: int
    rect: list
    area: float
    ocupantes: int
    lpd: float              # W/m2 iluminación
    epd: float              # W/m2 equipos
    hvac_kw: float          # capacidad total del terminal VRF (kW térmicos)
    sistema: str
    fan_w: float
    ventilador: str         # "continuo" | "horario" (modo del ventilador en la línea base, como en E+)
    horario_equipos: str
    horario_ac: str
    ventanas: dict = field(default_factory=dict)
    muros: dict = field(default_factory=dict)
    techo: float = 0.0
    suelo: float = 0.0
    it_kw: float = 0.0
    setpoint_fijo: float | None = None
    horario_ocupacion: str = "ocupacion"
    horario_luces: str = "iluminacion"
    min_equipos: float = 0.10
    rects: list = field(default_factory=list)  # partes de la huella si la zona no es rectangular
    # --- derivados (se completan en zonas())
    ua: float = 0.0          # kW/K conducción por la envolvente (muros, vidrio, techo)
    ua_vidrio: float = 0.0   # kW/K conducción por el vidrio (al nodo de aire)
    ua_muro: float = 0.0     # kW/K conducción por los muros opacos (al nodo de masa)
    ua_techo: float = 0.0    # kW/K conducción por la cubierta (al nodo de masa)
    g_inf: float = 0.0       # kW/K infiltración (al aire exterior)
    ua_arriba: float = 0.0   # kW/K acople con la planta superior a través de la losa intermedia
    ua_abajo: float = 0.0    # kW/K acople con la planta inferior
    ua_suelo: float = 0.0    # kW/K hacia el terreno
    c: float = 0.0           # kWh/K capacitancia total (aire + masa; la usa el modelo de predicción del MPC)
    c_aire: float = 0.0      # kWh/K nodo de aire (aire + mobiliario)
    c_masa: float = 0.0      # kWh/K nodo de masa (losas, muros y tabiques)
    h_am: float = 0.0        # kW/K acople convectivo aire ↔ masa
    cop: float = 3.0
    ventana: float = 0.0     # m2 totales de vidrio
    shgc: float = 0.25
    sol_opaco: dict = field(default_factory=dict)  # kW por W/m2 de irradiancia sobre muros/techo opacos

    @property
    def p_luces_max_kw(self) -> float:
        return self.lpd * self.area / 1000.0

    @property
    def p_equipos_max_kw(self) -> float:
        return self.epd * self.area / 1000.0

    @property
    def fan_kw(self) -> float:
        return self.fan_w / 1000.0


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
    """Zonas con sus parámetros térmicos derivados de la envolvente del modelo."""
    e = cfg["edificio"]
    cop_sis = {s["id"]: s["cop"] for s in cfg.get("sistemas_vrf", [])}
    alpha_ho = 0.7 / 17.0  # absortancia / coef. película exterior (W/m2K) → aire-sol
    out = []
    for d in cfg["zonas"]:
        z = Zona(**d)
        vidrio = sum(z.ventanas.values())
        opaco = {o: max(z.muros.get(o, 0.0) - z.ventanas.get(o, 0.0), 0.0) for o in ORIENTACIONES}
        sup_ext = sum(z.muros.values()) + z.techo
        ua_w = e["u_muro"] * sum(opaco.values()) + e["u_ventana"] * vidrio + e["u_techo"] * z.techo
        z.ua = ua_w / 1000.0
        z.ua_vidrio = e["u_ventana"] * vidrio / 1000.0
        z.ua_muro = e["u_muro"] * sum(opaco.values()) / 1000.0
        z.ua_techo = e["u_techo"] * z.techo / 1000.0
        z.g_inf = e["infiltracion_m3s_m2"] * sup_ext * RHO_CP
        # losas entre plantas: techo interior si no es la última planta, piso interior si no es la PB
        n_plantas = int(e.get("plantas", 1 + max(int(x["planta"]) for x in cfg["zonas"])))
        u_ep = e.get("u_entrepiso", 0.0)
        z.ua_arriba = u_ep * z.area / 1000.0 if (z.planta < n_plantas - 1 and not z.techo) else 0.0
        z.ua_abajo = u_ep * z.area / 1000.0 if (z.planta > 0 and not z.suelo) else 0.0
        z.ua_suelo = e["u_suelo"] * z.suelo / 1000.0
        # modelo 2R2C (ISO 13790 simplificado): nodo de aire rápido + nodo de masa lento
        z.c_masa = e["capacitancia_kwh_k_m2"] * z.area
        z.c_aire = e.get("capacitancia_aire_kwh_k_m2", 0.004) * z.area
        z.c = z.c_masa + z.c_aire
        z.h_am = e.get("h_aire_masa_kw_k_m2", 0.0228) * z.area
        z.cop = cop_sis.get(z.sistema, 3.0) * e.get("factor_cop", 1.0)
        z.ventana = vidrio
        z.shgc = e["shgc"]
        z.sol_opaco = {o: e["u_muro"] * a * alpha_ho / 1000.0 for o, a in opaco.items() if a}
        if z.techo:
            z.sol_opaco["H"] = e["u_techo"] * z.techo * alpha_ho / 1000.0
        out.append(z)
    return out


def nombres_plantas(cfg: dict) -> list[str]:
    e = cfg["edificio"]
    n = int(e.get("plantas", 1 + max(int(x["planta"]) for x in cfg["zonas"])))
    return list(e.get("nombres_plantas") or [f"P{i}" for i in range(n)])


def criticas(cfg: dict) -> list[str]:
    return [z["id"] for z in cfg["zonas"] if z.get("critica")]


def potencia_fv_kw(cfg: dict, irr_h_wm2: float) -> float:
    """Potencia AC de la fotovoltaica (PhotovoltaicPerformance:Simple de E+): área × fracción activa ×
    eficiencia × irradiancia sobre el plano horizontal × eficiencia del inversor."""
    fv = cfg.get("fv")
    if not fv:
        return 0.0
    area = sum(c["area_m2"] for c in fv["campos"]) * fv["fraccion_activa"]
    return max(irr_h_wm2, 0.0) * area * fv["eficiencia"] * fv["inversor"] / 1000.0


def fv_habilitada(cfg: dict) -> bool:
    return bool(cfg.get("fv")) and bool(cfg["fv"].get("habilitado", True))


def _escalon(perfil: list, hora: float) -> float:
    valor = perfil[0][1]
    for inicio, v in perfil:
        if hora >= inicio:
            valor = v
        else:
            break
    return float(valor)


def _promedio_ventana(perfil: list, a: float, b: float) -> float:
    """Promedio exacto del horario escalonado entre las horas a y b (mismo día)."""
    if b <= a:
        return _escalon(perfil, a)
    cortes = [a] + [float(i) for i, _ in perfil if a < i < b] + [b]
    return sum(_escalon(perfil, x0) * (x1 - x0) for x0, x1 in zip(cortes, cortes[1:])) / (b - a)


_CACHE_HORARIO: dict = {}


def horario(cfg: dict, nombre: str, dia_semana: int, hora: float) -> float:
    """Valor de un horario del modelo E+ (dia_semana: lunes=0 … domingo=6).

    Los horarios de E+ son escalonados (todo cambia de golpe a la misma hora). Con
    `horarios.transicion_min` > 0 cada escalón se convierte en una rampa lineal de esa duración centrada
    en la hora del cambio (la gente no llega ni enciende los equipos toda en el mismo minuto)."""
    hs = cfg["horarios"]
    h = hs[nombre]
    perfil = h["domingo"] if dia_semana == 6 else h["sabado"] if dia_semana == 5 else h["laborable"]
    w = float(hs.get("transicion_min", 0) or 0) / 60.0
    if w <= 0:
        return _escalon(perfil, hora)
    clave = (id(hs), nombre, dia_semana, round(hora * 60))
    v = _CACHE_HORARIO.get(clave)
    if v is None or v[0] is not hs:
        v = (hs, _promedio_ventana(perfil, max(hora - w / 2, 0.0), min(hora + w / 2, 24.0)))
        if len(_CACHE_HORARIO) > 200_000:
            _CACHE_HORARIO.clear()
        _CACHE_HORARIO[clave] = v
    return v[1]
