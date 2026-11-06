"""Eventos simulados en el gemelo digital: fallas, accidentes y condiciones extremas.

Mismos tipos y efectos que el panel de Grafana (grafana-ems-panel/src/building/events.ts). En modo en vivo
llegan desde el panel por `POST /ems/control {tipo: "evento"}` → Node-RED → MQTT `ems/<edif>/sim/control`
`{accion: "evento", ...}` y los aplica `Edificio` mientras dura el evento (tiempo simulado).

- incendio: la central de incendio para la climatización de todo el edificio (NFPA 90A, control de humo),
  el edificio se evacúa y la zona afectada se calienta rápidamente.
- corte_energia: sin red; las cargas críticas siguen con el UPS durante su autonomía, sin climatización.
- falla_vrf / falla_terminal: la unidad exterior (todas sus zonas) o el terminal de una zona deja de enfriar.
- puerta_abierta: entra aire exterior (sensible + latente).
- sensor: la lectura de temperatura se congela (el supervisor la detecta y pasa la zona a modo seguro).
- ola_calor: la temperatura exterior sube `intensidad` °C.
- sobreocupacion: `intensidad` % de personas sobre el aforo.
- pico_carga: `intensidad` kW de equipos adicionales.
"""
from __future__ import annotations

from dataclasses import dataclass, field

TIPOS = {
    "incendio": {"nivel": "crit", "objetivo": "zona"},
    "corte_energia": {"nivel": "crit", "objetivo": "edificio", "intensidad": 30},
    "falla_vrf": {"nivel": "crit", "objetivo": "unidad"},
    "falla_terminal": {"nivel": "warn", "objetivo": "zona"},
    "puerta_abierta": {"nivel": "warn", "objetivo": "zona", "intensidad": 50},
    "sensor": {"nivel": "crit", "objetivo": "zona"},
    "ola_calor": {"nivel": "info", "objetivo": "edificio", "intensidad": 4},
    "sobreocupacion": {"nivel": "warn", "objetivo": "zona", "intensidad": 50},
    "pico_carga": {"nivel": "warn", "objetivo": "zona", "intensidad": 10},
}

CALOR_INCENDIO_KW = 150.0  # conato de incendio en una oficina (orden de 0.1–1 MW)
CAUDAL_PUERTA_M3S = 0.6
MIN_EVACUACION = 5.0


@dataclass
class Evento:
    id: str
    tipo: str
    minutos: float
    zona: str | None = None
    unidad: str | None = None
    intensidad: float | None = None
    transcurrido: float = 0.0
    extra: dict = field(default_factory=dict)

    @property
    def activo(self) -> bool:
        return self.transcurrido < self.minutos


def validar(d: dict, zonas: set[str], unidades: set[str]) -> str | None:
    """Motivo por el que el evento no es válido (o None)."""
    tipo = d.get("evento") or d.get("tipo")
    if tipo not in TIPOS:
        return f"evento desconocido: {tipo}"
    obj = TIPOS[tipo]["objetivo"]
    if obj == "zona" and d.get("zona") not in zonas:
        return f"zona inválida: {d.get('zona')}"
    if obj == "unidad" and d.get("unidad") not in unidades:
        return f"unidad inválida: {d.get('unidad')}"
    dur = d.get("duracion_min", 30)
    if not isinstance(dur, (int, float)) or not 0 < dur <= 7 * 24 * 60:
        return "duración inválida"
    return None


def crear(d: dict) -> Evento:
    tipo = d.get("evento") or d.get("tipo")
    inten = d.get("intensidad")
    return Evento(
        id=str(d.get("id") or f"{tipo}-{d.get('zona') or d.get('unidad') or 'edif'}"),
        tipo=tipo,
        minutos=float(d.get("duracion_min", 30)),
        zona=d.get("zona"),
        unidad=d.get("unidad"),
        intensidad=float(inten) if inten is not None else TIPOS[tipo].get("intensidad"),
    )


def alarmas_inicio(ev: Evento, zonas_unidad: list[str] | None = None) -> list[dict]:
    """Alarmas que el supervisor emite al iniciar un evento."""
    if ev.tipo == "incendio":
        return [{"nivel": "crit", "codigo": "INCENDIO", "zona": ev.zona or "EDIF",
                 "mensaje": "Alarma de incendio: evacuación y paro de la climatización (NFPA 90A)"}]
    if ev.tipo == "corte_energia":
        return [{"nivel": "crit", "codigo": "CORTE_ENERGIA", "zona": "EDIF",
                 "mensaje": "Sin tensión en la acometida: VRF, iluminación y tomacorrientes sin servicio"},
                {"nivel": "warn", "codigo": "EN_UPS", "zona": "Z09",
                 "mensaje": f"Cargas críticas en UPS, autonomía ≈ {ev.intensidad:.0f} min", "valor": ev.intensidad}]
    if ev.tipo == "falla_vrf":
        return [{"nivel": "crit", "codigo": "FALLA_VRF", "zona": ev.unidad,
                 "mensaje": f"{ev.unidad}: compresor sin respuesta, zonas {', '.join(zonas_unidad or [])} sin enfriamiento"}]
    if ev.tipo == "falla_terminal":
        return [{"nivel": "warn", "codigo": "FALLA_TERMINAL", "zona": ev.zona, "mensaje": "Terminal VRF sin enfriamiento"}]
    if ev.tipo == "puerta_abierta":
        return [{"nivel": "warn", "codigo": "PUERTA_ABIERTA", "zona": ev.zona,
                 "mensaje": f"Puerta/ventana abierta con HVAC en marcha ({ev.intensidad:.0f} %)"}]
    if ev.tipo == "ola_calor":
        return [{"nivel": "info", "codigo": "OLA_CALOR", "zona": "EDIF",
                 "mensaje": f"Temperatura exterior +{ev.intensidad:.1f} °C: vigilancia de demanda"}]
    if ev.tipo == "sobreocupacion":
        return [{"nivel": "warn", "codigo": "SOBREOCUPACION", "zona": ev.zona,
                 "mensaje": f"{ev.intensidad:.0f} % sobre el aforo de diseño"}]
    if ev.tipo == "pico_carga":
        return [{"nivel": "warn", "codigo": "CARGA_EXTRA", "zona": ev.zona,
                 "mensaje": f"+{ev.intensidad:.0f} kW de equipos no previstos"}]
    return []  # sensor: lo detecta el supervisor (SENSOR_CONGELADO)
