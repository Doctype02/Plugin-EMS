"""Ajustes del operador sobre los controladores del gemelo digital (escenarios de simulación).

Dos familias, ambas con duración opcional (sin `duracion_min` quedan hasta `liberar`):

- **Unidades de climatización** (`sistemas_vrf`: 6 VRF + 5 PTAC). El controlador local de la unidad
  tiene prioridad sobre el EMS:
  - `encendido: false` apaga compresor y terminales (sin ventilador) de todas las zonas de la unidad;
  - `modo`: `auto` (obedece al EMS), `frio` (termostato local: ignora habilitación y deslastre del EMS),
    `ventilacion` (sólo ventiladores con aire exterior, sin compresor);
  - `capacidad_pct` (0–100): tope de la capacidad total de la unidad; si las zonas piden más, se reparte
    proporcionalmente (limitación del inverter);
  - `setpoint_c` (18–30): setpoint del controlador local para todas sus zonas (reemplaza al del EMS);
  - `cop_factor` (0.5–1.2): degradación (o mejora) del COP: mismo frío con más (o menos) potencia.
  La falla de la unidad no es un ajuste: es el evento `falla_vrf` (ems/eventos.py), que se informa como
  `falla` en el estado de la unidad.

- **Datos del sensor de zona** (lo que lee el controlador; la física no cambia): `temp_offset_c`
  (−10…10, descalibración) o `temp_c` (5–50, valor fijo con el ruido normal del sensor), `hr_pct`
  (0–100, valor fijo), `presencia` (detector de ocupación forzado) y `congelado` (todas las lecturas
  quedan fijas en el último valor; el supervisor lo detecta como SENSOR_CONGELADO). El termostato local y
  el EMS reaccionan al valor forzado como con un sensor real mal calibrado.

Las zonas críticas (y las unidades que las atienden) exigen `confirmar: true`; al aplicarse se emite
la alarma `AJUSTE_CRITICO`.
"""
from __future__ import annotations

MODOS_UNIDAD = ("auto", "frio", "ventilacion")
RANGO_CAPACIDAD = (0.0, 100.0)
RANGO_SETPOINT = (18.0, 30.0)
RANGO_COP = (0.5, 1.2)
RANGO_OFFSET = (-10.0, 10.0)
RANGO_TEMP = (5.0, 50.0)
RANGO_HR = (0.0, 100.0)
DURACION_MAX_MIN = 7 * 24 * 60

CAMPOS_UNIDAD = ("encendido", "modo", "capacidad_pct", "setpoint_c", "cop_factor")
CAMPOS_SENSOR = ("temp_offset_c", "temp_c", "hr_pct", "presencia", "congelado")


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _en(v, rango) -> bool:
    return _num(v) and rango[0] <= v <= rango[1]


def _duracion(d: dict) -> tuple[float | None, str | None]:
    dur = d.get("duracion_min")
    if dur is None:
        return None, None
    if not _num(dur) or not 0 < dur <= DURACION_MAX_MIN:
        return None, "duración inválida (1–10080 min o sin duración)"
    return float(dur), None


def validar_unidad(d: dict, unidades: dict[str, list[str]], criticas: set[str]) -> tuple[dict | None, str | None]:
    """Normaliza un ajuste de unidad. Devuelve (ajuste, error); con `liberar` el ajuste es None."""
    uid = d.get("unidad")
    if d.get("liberar"):
        if uid != "*" and uid not in unidades:
            return None, f"unidad inválida: {uid}"
        return None, None
    if uid not in unidades:
        return None, f"unidad inválida: {uid}"
    aj: dict = {}
    if "encendido" in d and d["encendido"] is not None:
        if not isinstance(d["encendido"], bool):
            return None, "encendido debe ser booleano"
        aj["encendido"] = d["encendido"]
    if d.get("modo") is not None:
        if d["modo"] not in MODOS_UNIDAD:
            return None, f"modo inválido: {d['modo']} (auto, frio, ventilacion)"
        aj["modo"] = d["modo"]
    for k, rango in (("capacidad_pct", RANGO_CAPACIDAD), ("setpoint_c", RANGO_SETPOINT), ("cop_factor", RANGO_COP)):
        if d.get(k) is not None:
            if not _en(d[k], rango):
                return None, f"{k} fuera de rango ({rango[0]:g}–{rango[1]:g})"
            aj[k] = float(d[k])
    if not aj:
        return None, "sin cambios"
    zc = [z for z in unidades[uid] if z in criticas]
    if zc and d.get("confirmar") is not True:
        return None, f"{uid} atiende la zona crítica {', '.join(zc)}: envíe confirmar: true"
    dur, err = _duracion(d)
    if err:
        return None, err
    aj["restante_min"] = dur
    aj["usuario"] = str(d.get("usuario") or "")
    aj["critica"] = bool(zc)
    return aj, None


def validar_sensor(d: dict, zonas: set[str], criticas: set[str]) -> tuple[dict | None, str | None]:
    """Normaliza un forzado de sensor de zona. Devuelve (forzado, error); con `liberar` el forzado es None."""
    zid = d.get("zona")
    if d.get("liberar"):
        if zid != "*" and zid not in zonas:
            return None, f"zona inválida: {zid}"
        return None, None
    if zid not in zonas:
        return None, f"zona inválida: {zid}"
    f: dict = {}
    if d.get("temp_offset_c") is not None and d.get("temp_c") is not None:
        return None, "use temp_offset_c o temp_c, no ambos"
    for k, rango in (("temp_offset_c", RANGO_OFFSET), ("temp_c", RANGO_TEMP), ("hr_pct", RANGO_HR)):
        if d.get(k) is not None:
            if not _en(d[k], rango):
                return None, f"{k} fuera de rango ({rango[0]:g}–{rango[1]:g})"
            f[k] = float(d[k])
    for k in ("presencia", "congelado"):
        if d.get(k) is not None:
            if not isinstance(d[k], bool):
                return None, f"{k} debe ser booleano"
            f[k] = d[k]
    if f.get("congelado") is False:
        f.pop("congelado")
    if not f:
        return None, "sin cambios"
    if zid in criticas and d.get("confirmar") is not True:
        return None, f"{zid} es una zona crítica: envíe confirmar: true"
    dur, err = _duracion(d)
    if err:
        return None, err
    f["restante_min"] = dur
    f["usuario"] = str(d.get("usuario") or "")
    f["critica"] = zid in criticas
    return f, None


def descontar(ajustes: dict[str, dict], minutos: float) -> list[str]:
    """Descuenta el paso a los ajustes con duración y quita los vencidos (los devuelve)."""
    fin = []
    for k in list(ajustes):
        r = ajustes[k].get("restante_min")
        if r is None:
            continue
        r -= minutos
        if r <= 0:
            ajustes.pop(k)
            fin.append(k)
        else:
            ajustes[k]["restante_min"] = r
    return fin


def describir_unidad(aj: dict) -> str:
    partes = []
    if aj.get("encendido") is False:
        partes.append("apagada")
    elif aj.get("modo") and aj["modo"] != "auto":
        partes.append({"frio": "frío local (sin EMS)", "ventilacion": "sólo ventilación"}[aj["modo"]])
    if aj.get("capacidad_pct") is not None:
        partes.append(f"capacidad {aj['capacidad_pct']:.0f} %")
    if aj.get("setpoint_c") is not None:
        partes.append(f"setpoint {aj['setpoint_c']:.1f} °C")
    if aj.get("cop_factor") is not None:
        partes.append(f"COP × {aj['cop_factor']:.2f}")
    dur = aj.get("restante_min")
    partes.append(f"{dur:.0f} min" if dur else "sin vencimiento")
    return ", ".join(partes)


def describir_sensor(fz: dict) -> str:
    partes = []
    if fz.get("congelado"):
        partes.append("congelado")
    if fz.get("temp_c") is not None:
        partes.append(f"T fija {fz['temp_c']:.1f} °C")
    if fz.get("temp_offset_c") is not None:
        partes.append(f"T {fz['temp_offset_c']:+.1f} °C")
    if fz.get("hr_pct") is not None:
        partes.append(f"HR {fz['hr_pct']:.0f} %")
    if fz.get("presencia") is not None:
        partes.append("presencia" if fz["presencia"] else "sin presencia")
    dur = fz.get("restante_min")
    partes.append(f"{dur:.0f} min" if dur else "sin vencimiento")
    return ", ".join(partes)


def campos_sensor(fz: dict | None) -> dict:
    """Campos `sensor_*` de la fila de zona (Influx) mientras el sensor está forzado."""
    if not fz:
        return {}
    out = {"sensor_restante_min": fz.get("restante_min") if fz.get("restante_min") is not None else -1.0}
    for k, campo in (("temp_offset_c", "sensor_temp_offset_c"), ("temp_c", "sensor_temp_fijo_c"),
                     ("hr_pct", "sensor_hr_fijo_pct"), ("presencia", "sensor_presencia"),
                     ("congelado", "sensor_congelado")):
        if k in fz:
            out[campo] = fz[k]
    return out
