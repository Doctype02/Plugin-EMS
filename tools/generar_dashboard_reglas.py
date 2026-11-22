"""Genera el dashboard de Grafana «EMS · Reglas del EMS» desde config/edificio.yaml.

    python tools/generar_dashboard_reglas.py

Escribe deploy/arch/grafana/dashboards/ems-reglas.json y agrega el enlace «Reglas» a la barra fija de
enlaces de los demás dashboards. El catálogo toma los parámetros de la configuración, así que al cambiar
un valor basta con volver a correr este script. La actividad de cada regla viene de la medida `ems`
(campos `r_*`) que escriben el EMS de Node-RED (en vivo) y los escenarios offline.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from ems import config as m_config  # noqa: E402

DASH = RAIZ / "deploy" / "arch" / "grafana" / "dashboards"
DS = {"type": "influxdb", "uid": "ems-influx"}
ENLACES = [("Edificio 3D", "ems-edificio-3d-vivo", "EMS · Edificio 3D"), ("Tiempo real", "ems-tiempo-real", "EMS · Tiempo real"),
           ("Zonas", "ems-zonas", "EMS · Zonas"), ("Alarmas", "ems-alarmas", "EMS · Alarmas"),
           ("Reglas", "ems-reglas", "EMS · Reglas del EMS"), ("Resultados", "ems-resultados", "EMS · Resultados")]

# campo r_* → (nombre corto, color)
CAMPOS = {
    "r_ocupadas": ("Zonas con gente", "#73BF69"),
    "r_vacancia": ("Retardo de vacancia", "#B877D9"),
    "r_setback": ("Espera a 27 °C", "#FADE2A"),
    "r_apagadas": ("Apagado fuera de horario", "#8E8E8E"),
    "r_proteccion_alta": ("Protección por calor", "#F2495C"),
    "r_proteccion_baja": ("Protección por frío", "#5794F2"),
    "r_luz_natural": ("Luz natural", "#FFB357"),
    "r_standby": ("Corte de standby", "#A352CC"),
    "r_rampa_setpoint": ("Rampa de consigna", "#37872D"),
    "r_arranque_espera": ("Arranque en espera", "#FF9830"),
    "r_arranques": ("Arranques en el paso", "#56A64B"),
    "r_rotacion_compresores": ("Rotación de compresores", "#E0752D"),
    "r_dr_etapa": ("Etapa de deslastre", "#C4162A"),
    "r_modo_seguro": ("Modo seguro", "#F2495C"),
    "r_manual": ("Control manual", "#8AB8FF"),
}

_id = [0]


def nid() -> int:
    _id[0] += 1
    return _id[0]


def flux_ultimo(campo: str) -> str:
    return ('from(bucket: "ems")\n  |> range(start: -2h)\n'
            f'  |> filter(fn: (r) => r._measurement == "ems" and r.escenario == "live" and r._field == "{campo}")\n'
            '  |> last()\n  |> keep(columns: ["_time", "_value"])')


def flux_serie(campos: list[str], fn: str = "max") -> str:
    nombres = " else ".join(f'if r._field == "{c}" then "{CAMPOS[c][0]}"' for c in campos) + " else r._field"
    regex = "|".join(c[2:] for c in campos)
    return ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
            f'  |> filter(fn: (r) => r._measurement == "ems" and r.escenario == "live" and r._field =~ /^r_({regex})$/)\n'
            f'  |> aggregateWindow(every: v.windowPeriod, fn: {fn}, createEmpty: false)\n'
            f'  |> map(fn: (r) => ({{r with _field: {nombres}}}))\n'
            '  |> keep(columns: ["_time", "_value", "_field"])')


def target(q: str, ref: str = "A") -> dict:
    return {"refId": ref, "datasource": DS, "query": q}


def fila(titulo: str, y: int, colapsada: bool = False, paneles: list | None = None) -> dict:
    return {"type": "row", "title": titulo, "collapsed": colapsada, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1},
            "panels": paneles or [], "id": nid()}


def stat(titulo: str, desc: str, q: str, pos: tuple, color: str, unidad: str = "zonas", mappings=None,
         umbral_alerta: float | None = None) -> dict:
    pasos = [{"color": "#8E8E8E", "value": None}, {"color": color, "value": 1}]
    if umbral_alerta is not None:
        pasos.append({"color": "#F2495C", "value": umbral_alerta})
    return {
        "type": "stat", "title": titulo, "description": desc, "datasource": DS, "targets": [target(q)],
        "gridPos": dict(zip("xywh", pos)),
        "fieldConfig": {"defaults": {"noValue": "Sin datos", "decimals": 0, "unit": "none",
                                     "color": {"mode": "thresholds"},
                                     "thresholds": {"mode": "absolute", "steps": pasos},
                                     "mappings": mappings or [{"type": "value", "options": {"0": {"text": "Inactiva", "index": 0}}}],
                                     "displayName": unidad},
                        "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "colorMode": "background", "graphMode": "none", "justifyMode": "center", "orientation": "auto",
                    "textMode": "value_and_name", "wideLayout": True, "showPercentChange": False,
                    "percentChangeColorMode": "standard", "text": {"titleSize": 13, "valueSize": 28}},
        "id": nid(),
    }


def serie(titulo: str, desc: str, targets: list, pos: tuple, overrides: list, unidad: str = "none",
          apilar: bool = False, estilo: str = "line", extra_defaults: dict | None = None) -> dict:
    custom = {"drawStyle": estilo, "lineInterpolation": "smooth" if estilo == "line" else "stepAfter", "lineWidth": 2,
              "fillOpacity": 35 if apilar else 10, "gradientMode": "opacity", "showPoints": "never", "pointSize": 4,
              "spanNulls": 1800000, "axisPlacement": "auto", "axisLabel": "", "axisBorderShow": False,
              "axisCenteredZero": False, "axisColorMode": "text", "barAlignment": 0, "insertNulls": False,
              "stacking": {"mode": "normal" if apilar else "none", "group": "A"},
              "thresholdsStyle": {"mode": "off"}, "scaleDistribution": {"type": "linear"},
              "hideFrom": {"legend": False, "tooltip": False, "viz": False}, "lineStyle": {"fill": "solid"}}
    defaults = {"unit": unidad, "decimals": 1, "custom": custom, "noValue": "Sin datos en el rango",
                "color": {"mode": "palette-classic"}, "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}}
    defaults.update(extra_defaults or {})
    return {"type": "timeseries", "title": titulo, "description": desc, "datasource": DS, "targets": targets,
            "gridPos": dict(zip("xywh", pos)), "fieldConfig": {"defaults": defaults, "overrides": overrides},
            "options": {"legend": {"showLegend": True, "displayMode": "list", "placement": "bottom", "calcs": []},
                        "tooltip": {"mode": "multi", "sort": "desc"}},
            "id": nid()}


def color_de(nombre: str, color: str, extra: list | None = None) -> dict:
    return {"matcher": {"id": "byName", "options": nombre},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": color}}] + (extra or [])}


def catalogo(cfg: dict) -> str:
    e, o, ed, h = cfg["ems"], cfg["ocupacion"], cfg["edificio"], cfg["horarios"]
    paso = ed["paso_min"]
    ent, sal = o["hora_entrada"], o["hora_salida"]
    hh = lambda x: f"{int(x):02d}:{int(round((x % 1) * 60)):02d}"  # noqa: E731
    rampa_paso = e["rampa_setpoint_c_h"] * paso / 60
    reglas = [
        ("Horario", "1. Horario laboral",
         f"Lunes a viernes de {hh(ent - 0.5)} a {hh(sal + 0.5)}",
         "Con gente: consigna de confort. Sin gente: espera.",
         f"Entrada {hh(ent)}, salida {hh(sal)}", "Climatiza sólo cuando el edificio se usa."),
        ("Horario", "2. Pre-enfriamiento escalonado",
         f"Días laborables, {e['precool_min']} min antes de la entrada ({hh(ent - e['precool_min'] / 60)}–{hh(ent)})",
         f"Las zonas arrancan de forma escalonada hacia {e['setpoint_ocupado_c']:g} °C",
         f"{e['precool_min']} min", "Recibe a la gente a temperatura de confort sin un pico de arranque."),
        ("Horario", "3. Apagado fuera de horario",
         "Noches, sábados y domingos",
         "Aire apagado: la zona sigue al clima exterior (sube de día, baja de noche)",
         f"Protección a {e['t_proteccion_max_c']:g} °C", "Es donde más energía se ahorra."),
        ("Confort", "4. Consigna por ocupación",
         "Hay gente en la zona (detector de presencia)",
         f"Consigna {e['setpoint_ocupado_c']:g} °C", f"Banda ±{e['banda_histeresis_c']:g} °C",
         "Confort donde hay personas."),
        ("Confort", "5. Retardo de vacancia",
         f"La zona queda vacía menos de {e['retardo_vacancia_min']} min",
         "Mantiene la consigna de confort", f"{e['retardo_vacancia_min']} min",
         "Evita encender y apagar por salidas cortas."),
        ("Confort", "6. Espera sin ocupación",
         "Horario laboral y zona vacía",
         f"Consigna {e['setpoint_desocupado_c']:g} °C", f"{e['setpoint_desocupado_c']:g} °C",
         "Ahorra sin dejar que la zona se caliente demasiado."),
        ("Secuencia", "7. Rampa de consigna",
         "Cada vez que cambia la consigna",
         f"Cambia como máximo {e['rampa_setpoint_c_h']:g} °C/h ({rampa_paso:g} °C cada {paso} min). Un "
         "terminal que arranca parte de la temperatura medida", f"{e['rampa_setpoint_c_h']:g} °C/h",
         "La temperatura baja de forma gradual y el compresor sube de carga poco a poco."),
        ("Secuencia", "8. Arranque escalonado",
         "Varias zonas quieren arrancar a la vez (pre-enfriamiento, protección, fin de un corte)",
         f"Arrancan como máximo {e['arranques_max_paso']} terminales cada {paso} min, la más caliente primero",
         f"{e['arranques_max_paso']} por paso", "Evita que todos los compresores arranquen juntos."),
        ("Secuencia", "9. Arranque suave del compresor",
         "Un compresor recibe más carga",
         f"El inverter sube {ed.get('rampa_compresor_por_min', 0.1) * 100:g} % de capacidad por minuto",
         f"{ed.get('rampa_compresor_por_min', 0.1) * 100:g} %/min", "La potencia sube en rampa, nunca de golpe."),
        ("Secuencia", "10. Llegada gradual",
         "Entrada y salida del personal",
         f"Los horarios pasan en rampas de {h.get('transicion_min', 0)} min y cada zona llega ±"
         f"{o.get('dispersion_llegada_min', 0)} min", f"{h.get('transicion_min', 0)} min",
         "Luces y equipos se encienden a medida que llega la gente."),
        ("Iluminación", "11. Luz natural",
         "Zona ocupada con luz del sol",
         f"Atenúa las luces para mantener {e['lux_objetivo']} lux", f"{e['lux_objetivo']} lux",
         "Aprovecha la fachada acristalada."),
        ("Enchufes", "12. Corte de standby",
         "Zona vacía", f"Enchufes al {e['equipos_desocupado_ems'] * 100:g} % y luces al "
         f"{e['luces_desocupado_ems'] * 100:g} %", f"{e['equipos_desocupado_ems'] * 100:g} %",
         "Elimina el consumo fantasma."),
        ("Demanda", "13. Rotación de compresores",
         f"La demanda se acerca al límite de {e['limite_demanda_kw']:g} kW",
         "Reparte la capacidad por urgencia; las zonas cerca del límite de confort siempre reciben frío",
         f"Límite {e['limite_demanda_kw']:g} kW", "Recorta el pico sin perder confort."),
        ("Demanda", "14. Deslastre (DR)",
         f"La demanda de 15 min supera {e['limite_demanda_kw']:g} kW",
         f"Luces al {e['dr_luces_nivel'] * 100:g} % y enchufes al {e['dr_equipos_nivel'] * 100:g} %; sale con "
         f"{e['dr_histeresis_kw']:g} kW de histéresis", f"{e['dr_histeresis_kw']:g} kW",
         "Evita el cargo por demanda máxima."),
        ("Protección", "15. Protección por calor",
         f"Fuera de horario la zona supera {e['t_proteccion_max_c']:g} °C",
         f"Enfría hasta {e['t_proteccion_retorno_c']:g} °C y vuelve a apagar",
         f"{e['t_proteccion_max_c']:g} / {e['t_proteccion_retorno_c']:g} °C", "Protege materiales y equipos."),
        ("Protección", "16. Protección por frío",
         f"La zona baja de {e['confort_min_c'] + 1:g} °C", "Ventila con aire exterior, sin compresor",
         f"{e['confort_min_c'] + 1:g} °C", "Planta baja sobre el terreno."),
        ("Seguridad", "17. Validación de sensores y modo seguro",
         "Sensor fuera de rango, congelado o con saltos", "Capacidad fija (55 %, 100 % en zonas críticas) y alarma",
         "6 lecturas", "El EMS nunca decide con un dato falso."),
        ("Seguridad", "18. Zonas críticas",
         "Cuarto de servidores", "Nunca se deslastra ni se apaga; consigna fija", "22 °C",
         "Continuidad del servicio."),
    ]
    filas = "\n".join(
        f"<tr><td><span class=\"tag\">{g}</span></td><td><b>{n}</b></td><td>{c}</td><td>{a}</td><td class=\"num\">{p}</td>"
        f"<td class=\"why\">{w}</td></tr>" for g, n, c, a, p, w in reglas)
    return (
        "<style>.ems-reglas{width:100%;border-collapse:collapse;font-size:13px}"
        ".ems-reglas th{text-align:left;padding:6px 8px;border-bottom:2px solid rgba(128,128,128,.35);opacity:.8;font-weight:600}"
        ".ems-reglas td{padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.18);vertical-align:top}"
        ".ems-reglas .tag{font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(87,148,242,.18);white-space:nowrap}"
        ".ems-reglas .num{white-space:nowrap;font-variant-numeric:tabular-nums}.ems-reglas .why{opacity:.75}</style>"
        "<table class=\"ems-reglas\"><thead><tr><th>Grupo</th><th>Regla</th><th>Cuándo se aplica</th><th>Qué hace</th>"
        f"<th>Parámetro</th><th>Para qué</th></tr></thead><tbody>{filas}</tbody></table>"
        "<p style=\"opacity:.65;font-size:12px;margin-top:8px\">Orden de prioridad: protección y seguridad → control "
        "manual del operador → limitador de demanda → secuencia (rampa y arranque escalonado) → reglas de horario, "
        "ocupación e iluminación. Los valores salen de <code>config/edificio.yaml</code>; la lógica es la misma en "
        "Python (<code>ems/control.py</code>) y en Node-RED (<code>nodered/src/ems_reglas.js</code>).</p>")


def dashboard(cfg: dict) -> dict:
    _id[0] = 0
    e = cfg["ems"]
    paneles = [fila("Estado de cada regla ahora", 0)]
    horario_q = ('from(bucket: "ems")\n  |> range(start: -2h)\n'
                 '  |> filter(fn: (r) => r._measurement == "ems" and r.escenario == "live" and (r._field == "r_precool" or r._field == "r_fuera_horario"))\n'
                 '  |> last()\n  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")\n'
                 '  |> map(fn: (r) => ({_time: r._time, _value: if r.r_precool > 0 then 1 else if r.r_fuera_horario > 0 then 0 else 2}))')
    paneles.append(stat("Modo del edificio", "Qué parte del horario rige ahora.", horario_q, (0, 1, 6, 4), "#5794F2",
                        unidad="horario", mappings=[{"type": "value", "options": {
                            "0": {"text": "Fuera de horario · aire apagado", "color": "#8E8E8E", "index": 0},
                            "1": {"text": "Pre-enfriamiento escalonado", "color": "#5794F2", "index": 1},
                            "2": {"text": "Horario laboral", "color": "#73BF69", "index": 2}}}]))
    tiles = [
        ("r_ocupadas", "Consigna por ocupación", f"Zonas con gente a {e['setpoint_ocupado_c']:g} °C."),
        ("r_vacancia", "Retardo de vacancia", f"Zonas vacías hace menos de {e['retardo_vacancia_min']} min que siguen en confort."),
        ("r_setback", "Espera sin ocupación", f"Zonas vacías en horario laboral a {e['setpoint_desocupado_c']:g} °C."),
        ("r_apagadas", "Apagado fuera de horario", "Zonas con el aire apagado (siguen al clima exterior)."),
        ("r_rampa_setpoint", "Rampa de consigna", f"Zonas cuya consigna aún avanza hacia el objetivo ({e['rampa_setpoint_c_h']:g} °C/h)."),
        ("r_arranque_espera", "Arranque escalonado", f"Terminales esperando turno para arrancar (máx. {e['arranques_max_paso']} por paso)."),
        ("r_luz_natural", "Luz natural", f"Zonas ocupadas con las luces atenuadas por el sol ({e['lux_objetivo']} lux)."),
        ("r_standby", "Corte de standby", "Zonas vacías con enchufes y luces en standby."),
        ("r_rotacion_compresores", "Rotación de compresores", f"Compresores frenados por el limitador de {e['limite_demanda_kw']:g} kW."),
        ("r_dr_etapa", "Deslastre (DR)", "0 = inactivo, 1 = rotación, 2 = deslastre de luces y enchufes."),
        ("r_proteccion_alta", "Protección por calor", f"Zonas fuera de horario que pasaron de {e['t_proteccion_max_c']:g} °C."),
        ("r_proteccion_baja", "Protección por frío", f"Zonas bajo {e['confort_min_c'] + 1:g} °C ventilando sin compresor."),
        ("r_modo_seguro", "Modo seguro", "Zonas con el sensor no confiable (capacidad fija)."),
        ("r_manual", "Control manual", "Zonas con orden del operador vigente."),
    ]
    x, y = 6, 1
    for campo, titulo, desc in tiles:
        alerta = 1 if campo in ("r_modo_seguro", "r_proteccion_alta") else None
        unidad = "etapa" if campo == "r_dr_etapa" else "zonas"
        paneles.append(stat(titulo, desc, flux_ultimo(campo), (x, y, 3, 4), CAMPOS[campo][1], unidad=unidad,
                            umbral_alerta=alerta))
        x += 3
        if x >= 24:
            x, y = 0, y + 4
    y += 4

    paneles.append(fila("Qué hace cada regla", y))
    y += 1
    paneles.append({"type": "text", "title": "Reglas con las que se construyó el EMS",
                    "description": "Catálogo generado desde config/edificio.yaml (tools/generar_dashboard_reglas.py).",
                    "gridPos": {"x": 0, "y": y, "w": 24, "h": 19}, "id": nid(),
                    "options": {"mode": "html", "content": catalogo(cfg), "code": {"language": "html", "showLineNumbers": False, "showMiniMap": False}}})
    y += 19

    paneles.append(fila("Secuencia: transiciones graduales", y))
    y += 1
    q_pot = ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
             '  |> filter(fn: (r) => r._measurement == "medidor" and r.escenario == "live" and r._field == "p_total_kw")\n'
             '  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n'
             '  |> map(fn: (r) => ({r with _field: "Consumo del edificio"}))\n  |> keep(columns: ["_time", "_value", "_field"])')
    q_arr = flux_serie(["r_arranques", "r_arranque_espera"], fn="max")
    paneles.append(serie(
        "Arranque de la mañana: la potencia sube en rampa",
        "Línea: consumo del edificio (kW). Barras: terminales que arrancan en cada paso y los que esperan turno. "
        "Con el arranque escalonado la potencia sube de forma gradual durante el pre-enfriamiento.",
        [target(q_pot, "A"), target(q_arr, "B")], (0, y, 14, 9),
        [color_de("Consumo del edificio", "#5794F2", [{"id": "unit", "value": "kwatt"}, {"id": "decimals", "value": 0}]),
         color_de(CAMPOS["r_arranques"][0], CAMPOS["r_arranques"][1],
                  [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.axisPlacement", "value": "right"},
                   {"id": "custom.fillOpacity", "value": 70}, {"id": "decimals", "value": 0}, {"id": "unit", "value": "none"},
                   {"id": "custom.axisLabel", "value": "terminales"}]),
         color_de(CAMPOS["r_arranque_espera"][0], CAMPOS["r_arranque_espera"][1],
                  [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.axisPlacement", "value": "right"},
                   {"id": "custom.fillOpacity", "value": 40}, {"id": "decimals", "value": 0}, {"id": "unit", "value": "none"},
                   {"id": "custom.axisLabel", "value": "terminales"}])],
        extra_defaults={"min": 0}))
    q_temp = ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
              '  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.critica == "no")\n'
              '  |> filter(fn: (r) => r._field == "temp_c" or r._field == "setpoint_c")\n'
              '  |> group(columns: ["_field"])\n'
              '  |> aggregateWindow(every: if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m, fn: mean, createEmpty: false)\n'
              '  |> map(fn: (r) => ({r with _field: if r._field == "temp_c" then "Temperatura interior (promedio)" else "Consigna enviada (promedio)"}))\n'
              '  |> keep(columns: ["_time", "_value", "_field"])')
    q_ext = ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
             '  |> filter(fn: (r) => r._measurement == "medidor" and r.escenario == "live" and r._field == "t_ext_c")\n'
             '  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)\n'
             '  |> map(fn: (r) => ({r with _field: "Temperatura exterior"}))\n  |> keep(columns: ["_time", "_value", "_field"])')
    paneles.append(serie(
        "Temperatura: rampas y efecto del clima exterior",
        "La consigna cambia en rampa (sin escalones) y la temperatura interior la sigue de forma gradual. Fuera de "
        "horario el aire está apagado: la temperatura interior sube y baja con la exterior, con retraso por la masa "
        "térmica del edificio.",
        [target(q_temp, "A"), target(q_ext, "B")], (14, y, 10, 9),
        [color_de("Temperatura interior (promedio)", "#FF9830"),
         color_de("Consigna enviada (promedio)", "#73BF69", [{"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [8, 6]}}]),
         color_de("Temperatura exterior", "#8AB8FF", [{"id": "custom.lineWidth", "value": 1}])],
        unidad="celsius"))
    y += 9

    paneles.append(fila("Actividad de las reglas en el tiempo", y))
    y += 1
    horario = ["r_ocupadas", "r_vacancia", "r_setback", "r_apagadas", "r_proteccion_alta", "r_proteccion_baja"]
    paneles.append(serie(
        "Zonas por modo de climatización",
        "Cuántas zonas (de 25 no críticas) está manejando cada regla de horario y ocupación.",
        [target(flux_serie(horario, fn="last"))], (0, y, 12, 9),
        [color_de(CAMPOS[c][0], CAMPOS[c][1]) for c in horario], apilar=True,
        extra_defaults={"min": 0, "decimals": 0, "custom": None}))
    otras = ["r_luz_natural", "r_standby", "r_rampa_setpoint", "r_rotacion_compresores", "r_modo_seguro", "r_manual"]
    paneles.append(serie(
        "Ahorro, secuencia y seguridad",
        "Zonas afectadas por luz natural, standby, rampa de consigna, rotación de compresores, modo seguro y control manual.",
        [target(flux_serie(otras, fn="max"))], (12, y, 12, 9),
        [color_de(CAMPOS[c][0], CAMPOS[c][1]) for c in otras], extra_defaults={"min": 0, "decimals": 0}))
    # el panel apilado necesita su propio bloque custom (el helper lo arma; aquí sólo se corrige)
    for p in paneles:
        if p.get("type") == "timeseries" and p["fieldConfig"]["defaults"].get("custom") is None:
            p["fieldConfig"]["defaults"].pop("custom")
            p["fieldConfig"]["defaults"]["custom"] = serie("", "", [], (0, 0, 1, 1), [], apilar=True)["fieldConfig"]["defaults"]["custom"]

    return {
        "uid": "ems-reglas", "title": "EMS · Reglas del EMS",
        "description": "Las reglas con las que se construyó el EMS, sus parámetros y cuándo actúa cada una.",
        "tags": ["ems"], "editable": True, "graphTooltip": 1, "schemaVersion": 39, "version": 1, "refresh": "30s",
        "time": {"from": "now-48h", "to": "now"}, "timezone": "America/Panama", "fiscalYearStartMonth": 0,
        "liveNow": False, "weekStart": "monday", "timepicker": {"refresh_intervals": ["30s", "1m", "5m", "15m"]},
        "links": enlaces(), "templating": {"list": []},
        "annotations": {"list": [{"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True,
                                  "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts",
                                  "type": "dashboard"}]},
        "panels": paneles,
    }


def enlaces() -> list[dict]:
    return [{"type": "link", "title": t, "url": f"/d/{uid}", "icon": "dashboard", "targetBlank": False, "keepTime": False,
             "includeVars": False, "asDropdown": False, "tags": [], "tooltip": tip} for t, uid, tip in ENLACES]


def main():
    cfg = m_config.cargar()
    d = dashboard(cfg)
    (DASH / "ems-reglas.json").write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
    # barra de enlaces fija y en el mismo orden en todos los dashboards
    for f in sorted(DASH.glob("ems-*.json")):
        if f.name == "ems-reglas.json":
            continue
        x = json.loads(f.read_text())
        propios = [l for l in x.get("links", []) if l.get("url", "") not in {f"/d/{u}" for _, u, _ in ENLACES}]
        x["links"] = enlaces() + propios
        f.write_text(json.dumps(x, ensure_ascii=False, indent=2) + "\n")
    print(f"ems-reglas.json: {len(d['panels'])} paneles; enlaces actualizados en {len(list(DASH.glob('ems-*.json'))) - 1} dashboards")


if __name__ == "__main__":
    main()
