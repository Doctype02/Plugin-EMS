"""Genera el dashboard de Grafana «EMS · Reglas del EMS» desde config/edificio.yaml.

    python tools/generar_dashboard_reglas.py

Escribe deploy/arch/grafana/dashboards/ems-reglas.json (esquema v2 de Grafana 13, recurso Kubernetes con
pestañas: TabsLayout) y agrega el enlace «Reglas» a la barra fija de enlaces de los demás dashboards. El
catálogo toma los parámetros de la configuración: al cambiar un valor basta con volver a correr el script.
La actividad de cada regla viene de la medida `ems` (campos `r_*`) que escriben el EMS de Node-RED (en vivo)
y los escenarios offline.
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
    "r_ocupadas": ("Con gente (24 °C)", "#73BF69"),
    "r_vacancia": ("Retardo de vacancia", "#B877D9"),
    "r_setback": ("Espera sin gente (27 °C)", "#FADE2A"),
    "r_apagadas": ("Aire apagado", "#8E8E8E"),
    "r_proteccion_alta": ("Protección por calor", "#F2495C"),
    "r_proteccion_baja": ("Protección por frío", "#5794F2"),
    "r_luz_natural": ("Luz natural", "#FFB357"),
    "r_standby": ("Corte de standby", "#A352CC"),
    "r_rampa_setpoint": ("Rampa de consigna", "#37872D"),
    "r_arranque_espera": ("Esperando turno", "#FF9830"),
    "r_arranques": ("Arrancan en el paso", "#56A64B"),
    "r_rotacion_compresores": ("Rotación de compresores", "#E0752D"),
    "r_dr_etapa": ("Etapa de deslastre", "#C4162A"),
    "r_modo_seguro": ("Modo seguro", "#F2495C"),
    "r_arranque_planta": ("Encendido por planta", "#3274D9"),
    "r_emergencia": ("Emergencia (planta)", "#FF780A"),
    "r_manual": ("Control manual", "#8AB8FF"),
}
VIVO = 'r._measurement == "ems" and r.escenario == "live"'


# ------------------------------------------------------------------------------------------- consultas
def flux_serie(campos: list[str], fn: str = "max") -> str:
    nombres = " else ".join(f'if r._field == "{c}" then "{CAMPOS[c][0]}"' for c in campos) + " else r._field"
    regex = "|".join(c[2:] for c in campos)
    return ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
            f'  |> filter(fn: (r) => {VIVO} and r._field =~ /^r_({regex})$/)\n'
            f'  |> aggregateWindow(every: if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m, fn: {fn}, createEmpty: false)\n'
            f'  |> map(fn: (r) => ({{r with _field: {nombres}}}))\n'
            '  |> keep(columns: ["_time", "_value", "_field"])')


def flux_ahora(campos: list[str]) -> str:
    nombres = " else ".join(f'if r._field == "{c}" then "{CAMPOS[c][0]}"' for c in campos) + " else r._field"
    regex = "|".join(c[2:] for c in campos)
    return ('from(bucket: "ems")\n  |> range(start: -2h)\n'
            f'  |> filter(fn: (r) => {VIVO} and r._field =~ /^r_({regex})$/)\n'
            '  |> last()\n'
            f'  |> map(fn: (r) => ({{r with _field: {nombres}}}))\n'
            '  |> keep(columns: ["_time", "_value", "_field"])')


def flux_medidor(campos: dict[str, str], fn: str = "mean", ultimo: bool = False) -> str:
    nombres = " else ".join(f'if r._field == "{c}" then "{n}"' for c, n in campos.items()) + " else r._field"
    filtro = " or ".join(f'r._field == "{c}"' for c in campos)
    rango = "range(start: -1h)" if ultimo else "range(start: v.timeRangeStart, stop: v.timeRangeStop)"
    agg = "last()" if ultimo else f"aggregateWindow(every: if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m, fn: {fn}, createEmpty: false)"
    return (f'from(bucket: "ems")\n  |> {rango}\n'
            f'  |> filter(fn: (r) => r._measurement == "medidor" and r.escenario == "live" and ({filtro}))\n'
            f'  |> {agg}\n  |> map(fn: (r) => ({{r with _field: {nombres}}}))\n'
            '  |> keep(columns: ["_time", "_value", "_field"])')


def flux_zonas(fn: str, nombre: str, ultimo: bool = False) -> str:
    """Temperatura medida de las zonas no críticas agregada entre zonas (mean/max/min)."""
    if ultimo:
        return ('from(bucket: "ems")\n  |> range(start: -1h)\n'
                '  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.critica == "no" and r._field == "temp_c")\n'
                f'  |> last()\n  |> group()\n  |> {fn}()\n  |> map(fn: (r) => ({{_time: now(), _value: r._value, _field: "{nombre}"}}))\n  |> group(columns: ["_field"])')
    return ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
            '  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.critica == "no" and r._field == "temp_c")\n'
            '  |> aggregateWindow(every: if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m, fn: mean, createEmpty: false)\n'
            f'  |> group(columns: ["_time"])\n  |> {fn}()\n  |> group()\n'
            f'  |> map(fn: (r) => ({{_time: r._time, _value: r._value, _field: "{nombre}"}}))')


# ------------------------------------------------------------------------------------------- paneles (v2)
class Tablero:
    def __init__(self):
        self.elementos: dict[str, dict] = {}
        self.n = 0

    def panel(self, tipo: str, titulo: str, desc: str, consultas: list[str], options: dict, defaults: dict,
              overrides: list | None = None, transformaciones: list | None = None) -> str:
        self.n += 1
        nombre = f"panel-{self.n}"
        qs = [{"kind": "PanelQuery", "spec": {
            "query": {"kind": "DataQuery", "group": "influxdb", "version": "v0", "datasource": {"name": DS["uid"]},
                      "spec": {"query": q}},
            "refId": chr(65 + i), "hidden": False}} for i, q in enumerate(consultas)]
        self.elementos[nombre] = {"kind": "Panel", "spec": {
            "id": self.n, "title": titulo, "description": desc, "links": [],
            "data": {"kind": "QueryGroup", "spec": {"queries": qs, "transformations": transformaciones or [], "queryOptions": {}}},
            "vizConfig": {"kind": "VizConfig", "group": tipo, "version": "",
                          "spec": {"options": options, "fieldConfig": {"defaults": defaults, "overrides": overrides or []}}}}}
        return nombre

    # --- tipos
    def texto(self, titulo: str, md: str) -> str:
        return self.panel("text", titulo, "", [], {"mode": "markdown", "content": md,
                                                   "code": {"language": "plaintext", "showLineNumbers": False, "showMiniMap": False}}, {})

    def stat(self, titulo: str, desc: str, q: str, color: str = "#5794F2", unidad: str = "none", decimales: int = 0,
             mappings: list | None = None, pasos: list | None = None, modo_color: str = "background") -> str:
        return self.panel("stat", titulo, desc, [q], {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}, "colorMode": modo_color,
            "graphMode": "none", "justifyMode": "center", "orientation": "auto", "textMode": "value",
            "wideLayout": True, "showPercentChange": False, "percentChangeColorMode": "standard",
            "text": {"titleSize": 13, "valueSize": 30}}, {
            "noValue": "Esperando datos", "decimals": decimales, "unit": unidad, "color": {"mode": "thresholds"},
            "thresholds": {"mode": "absolute", "steps": pasos or [{"color": color, "value": None}]},
            "mappings": mappings or []})

    def barras(self, titulo: str, desc: str, campos: list[tuple[str, str]], maximo: float = 25) -> str:
        regex = "|".join(c[2:] for c, _ in campos)
        q = ('from(bucket: "ems")\n  |> range(start: -2h)\n'
             f'  |> filter(fn: (r) => {VIVO} and r._field =~ /^r_({regex})$/)\n'
             '  |> last()\n  |> group()\n'
             '  |> pivot(rowKey: ["_measurement"], columnKey: ["_field"], valueColumn: "_value")\n'
             f'  |> keep(columns: [{", ".join(chr(34) + c + chr(34) for c, _ in campos)}])')
        org = {"kind": "organize", "spec": {"id": "organize", "options": {
            "indexByName": {c: i for i, (c, _) in enumerate(campos)},
            "renameByName": {c: n for c, n in campos}, "excludeByName": {}}}}
        return self.panel("bargauge", titulo, desc, [q], {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "orientation": "horizontal", "displayMode": "basic", "valueMode": "text", "namePlacement": "left",
            "showUnfilled": True, "sizing": "manual", "minVizHeight": 16, "minVizWidth": 8, "maxVizHeight": 26,
            "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom", "calcs": []}, "text": {"titleSize": 13, "valueSize": 14}}, {
            "noValue": "Esperando datos", "decimals": 0, "unit": "none", "min": 0, "max": maximo,
            "color": {"mode": "fixed", "fixedColor": "#5794F2"},
            "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}},
            [color(n, CAMPOS[c][1]) for c, n in campos], [org])

    def serie(self, titulo: str, desc: str, consultas: list[str], overrides: list, unidad: str = "none",
              apilar: bool = False, decimales: int = 0, extra: dict | None = None, escalon: bool = False,
              umbral: str = "off") -> str:
        custom = {"drawStyle": "line", "lineInterpolation": "stepAfter" if (escalon or unidad in ("kwatt", "amp")) else "smooth", "lineWidth": 2,
                  "fillOpacity": 45 if apilar else 8, "gradientMode": "opacity" if not apilar else "none",
                  "showPoints": "never", "pointSize": 4, "spanNulls": 1800000, "axisPlacement": "auto", "axisLabel": "",
                  "axisBorderShow": False, "axisCenteredZero": False, "axisColorMode": "text", "barAlignment": 0,
                  "insertNulls": False, "stacking": {"mode": "normal" if apilar else "none", "group": "A"},
                  "thresholdsStyle": {"mode": umbral}, "scaleDistribution": {"type": "linear"},
                  "hideFrom": {"legend": False, "tooltip": False, "viz": False}, "lineStyle": {"fill": "solid"}}
        defaults = {"unit": unidad, "decimals": decimales, "custom": custom, "noValue": "Esperando datos (se registran cada 5 min)",
                    "color": {"mode": "palette-classic"}, "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": None}]}}
        defaults.update(extra or {})
        return self.panel("timeseries", titulo, desc, consultas, {
            "legend": {"showLegend": True, "displayMode": "list", "placement": "bottom", "calcs": []},
            "tooltip": {"mode": "multi", "sort": "desc"}}, defaults, overrides)


def color(nombre: str, c: str, extra: list | None = None) -> dict:
    return {"matcher": {"id": "byName", "options": nombre},
            "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}] + (extra or [])}


def auto(nombres: list[str], columnas: int, llenar: bool = True) -> dict:
    """Cuadrícula automática (AutoGridLayout), sin tamaños fijos: columnas angostas que se reacomodan según el
    ancho de la pantalla. Con `llenar` los paneles crecen hasta ocupar el alto disponible (fillScreen); sin
    él (franja de indicadores) quedan bajos."""
    return {"kind": "AutoGridLayout", "spec": {
        "maxColumnCount": columnas, "columnWidthMode": "narrow", "rowHeightMode": "standard" if llenar else "short",
        "fillScreen": llenar,
        "items": [{"kind": "AutoGridLayoutItem", "spec": {"element": {"kind": "ElementReference", "name": n}}}
                  for n in nombres]}}


def filas(*bloques: tuple[dict, bool]) -> dict:
    """Filas sin encabezado, una debajo de otra; (layout, llenar_pantalla)."""
    return {"kind": "RowsLayout", "spec": {"rows": [
        {"kind": "RowsLayoutRow", "spec": {"title": "", "collapse": False, "hideHeader": True, "fillScreen": llenar,
                                            "layout": lay}} for lay, llenar in bloques]}}


# ------------------------------------------------------------------------------------------- reglas
def reglas(cfg: dict) -> list[dict]:
    e, o, ed, h = cfg["ems"], cfg["ocupacion"], cfg["edificio"], cfg["horarios"]
    paso = ed["paso_min"]
    ent, sal = o["hora_entrada"], o["hora_salida"]
    hh = lambda x: f"{int(x):02d}:{int(round((x % 1) * 60)):02d}"  # noqa: E731
    comp = ed.get("rampa_compresor_por_min", 0.1) * 100
    gen, em = cfg["respaldo"]["generador"], cfg["respaldo"]["emergencia"]
    apl = e.get("arranque_por_planta")
    nombres = ed.get("nombres_plantas") or [f"P{i}" for i in range(ed.get("plantas", 5))]
    R = lambda g, n, c, a, p, w: {"grupo": g, "nombre": n, "cuando": c, "accion": a, "param": p, "para": w}  # noqa: E731
    return [
        R("horario", "Horario laboral", f"Lunes a viernes, {hh(ent - 0.5)}–{hh(sal + 0.5)}",
          "Con gente, consigna de confort; sin gente, espera", f"Entrada {hh(ent)} · salida {hh(sal)}",
          "Climatizar sólo cuando el edificio se usa"),
        (R("horario", "Encendido escalonado por planta",
           f"Días laborables: {', '.join(f'{nombres[p]} a las {hh(apl['inicio_h'] + i * apl['intervalo_min'] / 60)}' for i, p in enumerate(apl['orden']))}",
           f"Enciende el VRF de cada planta en su turno con consigna de {apl['setpoint_c']:g} °C, sin pasillos ni baños; de "
           f"{hh(apl['sin_reglas_temperatura_h'][0])} a {hh(apl['sin_reglas_temperatura_h'][1])} no actúan las reglas de temperatura",
           f"una planta cada {apl['intervalo_min']} min", "Repartir el arranque de la mañana: nunca encienden dos plantas a la vez")
         if apl else
         R("horario", "Pre-enfriamiento con arranque óptimo",
          f"Días laborables antes de la entrada: {e['precool_min']} min como mínimo y {e['precool_min_por_grado']:g} min más por "
          f"cada °C que la zona esté sobre {e['setpoint_ocupado_c'] + e['precool_margen_c']:g} °C (hasta {e['precool_max_min'] / 60:g} h antes)",
          f"Las zonas arrancan por turnos hacia {e['setpoint_ocupado_c']:g} °C; antes de abrir el edificio no pasa de "
          f"{e['limite_precool_kw']:g} kW", f"{e['precool_min']}–{e['precool_max_min']} min · {e['limite_precool_kw']:g} kW",
          "Recibir a la gente en confort sin pico: el lunes, tras el fin de semana apagado, empieza de madrugada")),
        R("horario", "Aire apagado fuera de horario", "Noches, sábados y domingos",
          "Aire apagado: la zona sigue al clima exterior (sube de día y baja de noche)",
          f"Protección a {e['t_proteccion_max_c']:g} °C", "Es donde más energía se ahorra"),
        R("horario", "Consigna por ocupación", "El detector de presencia ve gente",
          f"Consigna {e['setpoint_ocupado_c']:g} °C", f"Banda ±{e['banda_histeresis_c']:g} °C", "Confort donde hay personas"),
        R("horario", "Retardo de vacancia", f"La zona lleva menos de {e['retardo_vacancia_min']} min vacía",
          "Mantiene la consigna de confort", f"{e['retardo_vacancia_min']} min", "No apagar por salidas cortas"),
        R("horario", "Espera sin ocupación", "Horario laboral y zona vacía", f"Consigna {e['setpoint_desocupado_c']:g} °C",
          f"{e['setpoint_desocupado_c']:g} °C", "Ahorrar sin que la zona se recaliente"),
        R("secuencia", "Rampa de consigna", "Cada vez que cambia la consigna",
          f"Cambia como máximo {e['rampa_setpoint_c_h']:g} °C/h ({e['rampa_setpoint_c_h'] * paso / 60:g} °C cada {paso} min); "
          "al arrancar parte de la temperatura medida", f"{e['rampa_setpoint_c_h']:g} °C/h",
          "La temperatura baja de forma gradual"),
        R("secuencia", "Arranque escalonado", "Varias zonas quieren arrancar a la vez",
          f"Arrancan como máximo {e['arranques_max_paso']} terminales cada {paso} min, la más caliente primero",
          f"{e['arranques_max_paso']} por paso", "Que no se sumen los picos de arranque de los compresores (≈ 1,5 × su potencia durante unos segundos)"),
        R("secuencia", "Arranque suave del compresor", "Un compresor recibe más carga",
          f"El inverter sube {comp:g} % de capacidad por minuto", f"{comp:g} %/min", "La potencia sube en rampa"),
        R("secuencia", "Llegada gradual", "Entrada y salida del personal",
          f"Los horarios cambian en rampas de {h.get('transicion_min', 0)} min; cada zona llega ±{o.get('dispersion_llegada_min', 0)} min",
          f"{h.get('transicion_min', 0)} min", "Luces y equipos se encienden a medida que llega la gente"),
        R("iluminacion", "Luz natural", "Zona ocupada con luz del sol",
          f"Atenúa las luces para mantener {e['lux_objetivo']} lux", f"{e['lux_objetivo']} lux", "Aprovechar la fachada de vidrio"),
        R("iluminacion", "Corte de standby", "Zona vacía",
          f"Enchufes al {e['equipos_desocupado_ems'] * 100:g} %, luces al {e['luces_desocupado_ems'] * 100:g} %",
          f"{e['equipos_desocupado_ems'] * 100:g} %", "Eliminar el consumo fantasma"),
        R("demanda", "Rotación de compresores", f"La demanda se acerca a {e['limite_demanda_kw']:g} kW",
          "Reparte la capacidad: primero las zonas con gente cerca del límite de confort, luego los equipos ya en marcha y después por urgencia",
          f"Límite {e['limite_demanda_kw']:g} kW", "Recortar el pico sin perder confort"),
        R("demanda", "Deslastre (DR)", f"La demanda de 15 min supera {e['limite_demanda_kw']:g} kW",
          f"Luces al {e['dr_luces_nivel'] * 100:g} %, enchufes al {e['dr_equipos_nivel'] * 100:g} %; sale con "
          f"{e['dr_histeresis_kw']:g} kW de margen", f"{e['dr_histeresis_kw']:g} kW", "Evitar el cargo por demanda máxima"),
        R("proteccion", "Protección por calor", f"Fuera de horario la zona pasa de {e['t_proteccion_max_c']:g} °C",
          f"Enfría hasta {e['t_proteccion_retorno_c']:g} °C y vuelve a apagar",
          f"{e['t_proteccion_max_c']:g} / {e['t_proteccion_retorno_c']:g} °C", "Proteger materiales y equipos"),
        R("proteccion", "Protección por frío", f"La zona baja de {e['confort_min_c'] + 1:g} °C",
          "Ventila con aire exterior, sin compresor", f"{e['confort_min_c'] + 1:g} °C", "Evitar el sobreenfriamiento"),
        R("proteccion", "Sensores y modo seguro", "Sensor fuera de rango, congelado o con saltos",
          "Capacidad fija (55 %; 100 % en zonas críticas) y alarma", "6 lecturas", "No decidir con un dato falso"),
        R("proteccion", "Modo emergencia (planta de respaldo)", "Corte de red: el edificio pasa a la planta de respaldo",
          f"Luces al {em['luces_nivel'] * 100:g} %, consigna {em['setpoint_c']:g} °C (mínimo {em['setpoint_min_c']:g} °C), pasillos sin "
          f"aire y límite de {gen['potencia_kw'] * gen['carga_max']:g} kW sobre la planta. Toma de carga escalonada: tras la transferencia "
          f"(y al volver la red) todos los terminales paran y vuelven de {e['arranques_max_paso']} en {e['arranques_max_paso']} cada {paso} min; los paneles siguen aportando",
          f"{gen['potencia_kw']:g} kW", "Mantener el edificio operando sin sobrecargar la planta"),
        R("proteccion", "Zonas críticas", "Cuarto de servidores", "Nunca se deslastra ni se apaga; consigna fija",
          "22 °C", "Continuidad del servicio"),
    ]


def tabla_md(rs: list[dict], numerar_desde: int = 1, con_grupo: bool = False) -> str:
    grupos = {"horario": "Horario y confort", "secuencia": "Secuencia", "iluminacion": "Iluminación y enchufes",
              "demanda": "Demanda", "proteccion": "Protección"}
    cab = ("| # | Grupo | Regla | Cuándo | Qué hace | Parámetro |\n|---|---|---|---|---|---|\n" if con_grupo else
           "| # | Regla | Cuándo | Qué hace | Parámetro |\n|---|---|---|---|---|\n")
    filas = []
    for i, r in enumerate(rs, numerar_desde):
        g = f" {grupos[r['grupo']]} |" if con_grupo else ""
        filas.append(f"| {i} |{g} **{r['nombre']}** | {r['cuando']} | {r['accion']} | `{r['param']}` |")
    return cab + "\n".join(filas)


def tarjetas_md(titulo: str, intro: str, rs: list[dict], desde: int) -> str:
    partes = [f"### {titulo}", intro, ""]
    for i, r in enumerate(rs, desde):
        partes += [f"**{i}. {r['nombre']}** &nbsp;·&nbsp; `{r['param']}`",
                   f"- *Cuándo:* {r['cuando']}", f"- *Qué hace:* {r['accion']}", f"- *Para qué:* {r['para']}", ""]
    return "\n".join(partes)


# ------------------------------------------------------------------------------------------- dashboard
def dashboard(cfg: dict) -> dict:
    e = cfg["ems"]
    lim = e["limite_demanda_kw"]
    rs = reglas(cfg)
    por = lambda g: [r for r in rs if r["grupo"] == g]  # noqa: E731
    inicio = {g: 1 + next(i for i, r in enumerate(rs) if r["grupo"] == g)
              for g in ("horario", "secuencia", "iluminacion", "demanda", "proteccion")}
    T = Tablero()
    tabs = []

    # ---------- Resumen
    modo_q = ('from(bucket: "ems")\n  |> range(start: -2h)\n'
              f'  |> filter(fn: (r) => {VIVO} and (r._field == "r_precool" or r._field == "r_fuera_horario"))\n'
              '  |> last()\n  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")\n'
              '  |> map(fn: (r) => ({_time: r._time, _value: if r.r_precool > 0 then 1 else if r.r_fuera_horario > 0 then 0 else 2}))')
    modo = T.stat("Modo ahora", "Qué parte del horario rige en este momento.", modo_q, mappings=[
        {"type": "value", "options": {
            "0": {"text": "Fuera de horario", "color": "#6E7079", "index": 0},
            "1": {"text": "Pre-enfriamiento", "color": "#3274D9", "index": 1},
            "2": {"text": "Horario laboral", "color": "#37872D", "index": 2}}}])
    t_int = T.stat("Interior", "Temperatura media medida en las 25 zonas no críticas.",
                   flux_zonas("mean", "Interior", ultimo=True), unidad="celsius", decimales=1, modo_color="value",
                   pasos=[{"color": "#5794F2", "value": None}, {"color": "#73BF69", "value": e["confort_min_c"]},
                          {"color": "#FF9830", "value": e["confort_max_c"]}, {"color": "#F2495C", "value": e["t_proteccion_max_c"]}])
    t_ext = T.stat("Exterior", "Temperatura exterior (clima de Panamá).",
                   flux_medidor({"t_ext_c": "Exterior"}, ultimo=True), unidad="celsius", decimales=1,
                   modo_color="value", color="#8AB8FF")
    pot = T.stat("Consumo", f"Potencia del edificio frente al límite de {lim:g} kW.",
                 flux_medidor({"p_total_kw": "Consumo"}, ultimo=True), unidad="kwatt", decimales=0, modo_color="value",
                 pasos=[{"color": "#73BF69", "value": None}, {"color": "#FF9830", "value": lim * 0.85}, {"color": "#F2495C", "value": lim}])
    todas = ["r_ocupadas", "r_vacancia", "r_setback", "r_apagadas", "r_rampa_setpoint", "r_arranque_espera",
             "r_luz_natural", "r_standby", "r_rotacion_compresores", "r_proteccion_alta", "r_proteccion_baja",
             "r_modo_seguro", "r_emergencia", "r_manual"]
    numeros = {"r_apagadas": 3, "r_ocupadas": 4, "r_vacancia": 5, "r_setback": 6, "r_rampa_setpoint": 7,
               "r_arranque_espera": 8, "r_luz_natural": 11, "r_standby": 12, "r_rotacion_compresores": 13,
               "r_proteccion_alta": 15, "r_proteccion_baja": 16, "r_modo_seguro": 17, "r_emergencia": 18}
    orden = sorted([c for c in todas if c in numeros], key=numeros.get) + ["r_manual"]
    barras = T.barras("Zonas que maneja cada regla ahora",
                      "Número de zonas (de 25 no críticas) a las que se aplica cada regla en el último paso de 5 min. "
                      "El número es el de la regla en el catálogo.",
                      [(c, f"{numeros[c]}. {CAMPOS[c][0]}" if c in numeros else CAMPOS[c][0]) for c in orden])
    prioridad = T.texto("Cómo decide el EMS", (
        "Cada 5 minutos el EMS lee los sensores de las 26 zonas y el medidor, y decide por zona en este orden "
        "de prioridad:\n\n"
        "1. **Protección y seguridad**: sensores no confiables → modo seguro; cuarto de servidores intocable; "
        "protección por calor y por frío.\n"
        "2. **Control manual** del operador (si lo hay).\n"
        f"3. **Demanda**: si el edificio se acerca a {lim:g} kW, rotación de compresores y deslastre.\n"
        "4. **Secuencia**: rampa de consigna y arranque escalonado, para que nada cambie de golpe.\n"
        "5. **Horario, ocupación e iluminación**: consigna según haya gente, luz natural y standby.\n\n"
        "Cada pestaña explica un grupo de reglas y muestra cómo actúa. Los parámetros salen de "
        "`config/edificio.yaml`; la lógica es la misma en Python (`ems/control.py`) y en Node-RED."))
    modos_campos = ["r_ocupadas", "r_vacancia", "r_setback", "r_apagadas", "r_proteccion_alta", "r_proteccion_baja"]
    modos = T.serie("Zonas por modo de climatización",
                    "Cuántas zonas maneja cada regla de horario y ocupación a lo largo del tiempo.",
                    [flux_serie(modos_campos, "last")], [color(CAMPOS[c][0], CAMPOS[c][1]) for c in modos_campos],
                    apilar=True, escalon=True, extra={"min": 0, "max": 25})
    tabs.append(("Resumen", filas(
        (auto([modo, t_int, t_ext, pot], 4, llenar=False), False),
        (auto([barras, modos, prioridad], 3), True))))

    # ---------- Horario y confort
    txt = T.texto("Reglas de horario y confort", tarjetas_md(
        "Horario y confort", "Deciden si una zona se climatiza y a qué temperatura.", por("horario"), inicio["horario"]))
    modos2 = T.serie("Zonas por modo", "Zonas con gente, en espera, apagadas o en protección.",
                     [flux_serie(modos_campos, "last")], [color(CAMPOS[c][0], CAMPOS[c][1]) for c in modos_campos],
                     apilar=True, escalon=True, extra={"min": 0, "max": 25})
    temps = T.serie("Temperatura interior frente a la exterior",
                    "Con el aire apagado (noches y fines de semana) el interior sigue al exterior con retraso por la "
                    "masa del edificio; en horario se mantiene en la banda de confort.",
                    [flux_zonas("mean", "Interior (promedio)"), flux_zonas("max", "Zona más caliente"),
                     flux_medidor({"t_ext_c": "Exterior"})],
                    [color("Interior (promedio)", "#FF9830"), color("Zona más caliente", "#F2495C", [{"id": "custom.lineWidth", "value": 1}]),
                     color("Exterior", "#8AB8FF", [{"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [8, 6]}}])],
                    unidad="celsius", decimales=1)
    tabs.append(("Horario", auto([txt, modos2, temps], 3)))

    # ---------- Secuencia
    txt = T.texto("Reglas de secuencia", tarjetas_md(
        "Secuencia: nada cambia de golpe", "Reparten en el tiempo los cambios de temperatura y los arranques.",
        por("secuencia"), inicio["secuencia"]))
    arranque = T.serie("Arranque de la mañana: la potencia sube en rampa",
                       "Línea: consumo del edificio. Barras: terminales que arrancan en cada paso y los que esperan turno.",
                       [flux_medidor({"p_total_kw": "Consumo del edificio"}), flux_serie(["r_arranques", "r_arranque_espera"])],
                       [color("Consumo del edificio", "#5794F2", [{"id": "unit", "value": "kwatt"}, {"id": "custom.lineInterpolation", "value": "stepAfter"}]),
                        color(CAMPOS["r_arranques"][0], CAMPOS["r_arranques"][1],
                              [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.axisPlacement", "value": "right"},
                               {"id": "custom.fillOpacity", "value": 80}, {"id": "custom.axisLabel", "value": "terminales"}]),
                        color(CAMPOS["r_arranque_espera"][0], CAMPOS["r_arranque_espera"][1],
                              [{"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.axisPlacement", "value": "right"},
                               {"id": "custom.fillOpacity", "value": 40}, {"id": "custom.axisLabel", "value": "terminales"}])],
                       extra={"min": 0})
    q_sp = ('from(bucket: "ems")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
            '  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.critica == "no")\n'
            '  |> filter(fn: (r) => r._field == "setpoint_c" or r._field == "temp_c")\n  |> group(columns: ["_field"])\n'
            '  |> aggregateWindow(every: if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m, fn: mean, createEmpty: false)\n'
            '  |> map(fn: (r) => ({r with _field: if r._field == "temp_c" then "Temperatura (promedio)" else "Consigna enviada (promedio)"}))\n'
            '  |> keep(columns: ["_time", "_value", "_field"])')
    rampa = T.serie("Consigna y temperatura: rampas sin escalones",
                    "La consigna enviada baja como máximo 3 °C/h y la temperatura la sigue de forma gradual.",
                    [q_sp, flux_serie(["r_rampa_setpoint"])],
                    [color("Temperatura (promedio)", "#FF9830"),
                     color("Consigna enviada (promedio)", "#73BF69", [{"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [8, 6]}}]),
                     color(CAMPOS["r_rampa_setpoint"][0], CAMPOS["r_rampa_setpoint"][1],
                           [{"id": "unit", "value": "none"}, {"id": "decimals", "value": 0}, {"id": "custom.axisPlacement", "value": "right"},
                            {"id": "custom.drawStyle", "value": "bars"}, {"id": "custom.fillOpacity", "value": 35},
                            {"id": "custom.axisLabel", "value": "zonas en rampa"}])],
                    unidad="celsius", decimales=1)
    tabs.append(("Secuencia", auto([txt, arranque, rampa], 3)))

    # ---------- Iluminación y enchufes
    txt = T.texto("Reglas de iluminación y enchufes", tarjetas_md(
        "Iluminación y enchufes", "Apagan lo que no se usa y aprovechan la luz del día.", por("iluminacion"), inicio["iluminacion"]))
    zonas_il = T.serie("Zonas con luz natural y en standby", "Zonas con las luces atenuadas por el sol y zonas vacías en standby.",
                       [flux_serie(["r_luz_natural", "r_standby"], "last")],
                       [color(CAMPOS[c][0], CAMPOS[c][1]) for c in ("r_luz_natural", "r_standby")], escalon=True,
                       extra={"min": 0, "max": 25})
    pot_il = T.serie("Potencia de iluminación y enchufes", "Lo que consumen luces y equipos de las zonas (kW).",
                     [flux_medidor({"p_luces_kw": "Iluminación", "p_equipos_kw": "Enchufes y equipos"})],
                     [color("Iluminación", "#FFB357"), color("Enchufes y equipos", "#A352CC")], unidad="kwatt", decimales=1,
                     extra={"min": 0})
    tabs.append(("Iluminación", auto([txt, zonas_il, pot_il], 3)))

    # ---------- Demanda
    txt = T.texto("Reglas de demanda", tarjetas_md(
        "Demanda máxima", f"Mantienen el edificio por debajo de {lim:g} kW.", por("demanda"), inicio["demanda"]))
    dem = T.serie(f"Consumo frente al límite de {lim:g} kW", "Demanda del edificio (kW) y límite contratado (línea roja).",
                  [flux_medidor({"demanda_15min_kw": "Demanda de 15 min", "p_total_kw": "Consumo"})],
                  [color("Demanda de 15 min", "#5794F2"), color("Consumo", "#8AB8FF", [{"id": "custom.lineWidth", "value": 1}])],
                  unidad="kwatt", extra={"min": 0, "thresholds": {"mode": "absolute", "steps": [
                      {"color": "transparent", "value": None}, {"color": "red", "value": lim}]}}, umbral="dashed")
    act = T.serie("Actuación del limitador", "Compresores frenados por la rotación y etapa de deslastre (0 = inactivo).",
                  [flux_serie(["r_rotacion_compresores", "r_dr_etapa"])],
                  [color(CAMPOS[c][0], CAMPOS[c][1]) for c in ("r_rotacion_compresores", "r_dr_etapa")], escalon=True,
                  extra={"min": 0})
    tabs.append(("Demanda", auto([txt, dem, act], 3)))

    # ---------- Protección y seguridad
    txt = T.texto("Reglas de protección y seguridad", tarjetas_md(
        "Protección y seguridad", "Tienen prioridad sobre todas las demás.", por("proteccion"), inicio["proteccion"]))
    prot = T.serie("Zonas en protección, modo seguro o control manual", "Zonas afectadas por cada regla de protección.",
                   [flux_serie(["r_proteccion_alta", "r_proteccion_baja", "r_modo_seguro", "r_emergencia", "r_manual"])],
                   [color(CAMPOS[c][0], CAMPOS[c][1]) for c in ("r_proteccion_alta", "r_proteccion_baja", "r_modo_seguro", "r_emergencia", "r_manual")],
                   escalon=True, extra={"min": 0})
    extremos = T.serie("Zona más caliente y más fría",
                       f"Temperatura de la zona más caliente y la más fría frente a los límites de protección "
                       f"({e['confort_min_c'] + 1:g} °C y {e['t_proteccion_max_c']:g} °C).",
                       [flux_zonas("max", "Zona más caliente"), flux_zonas("min", "Zona más fría")],
                       [color("Zona más caliente", "#F2495C"), color("Zona más fría", "#5794F2")], unidad="celsius", decimales=1,
                       extra={"thresholds": {"mode": "absolute", "steps": [
                           {"color": "#5794F2", "value": None}, {"color": "transparent", "value": e["confort_min_c"] + 1},
                           {"color": "#F2495C", "value": e["t_proteccion_max_c"]}]}}, umbral="dashed")
    tabs.append(("Protección", auto([txt, prot, extremos], 3)))

    # ---------- Catálogo
    cat = T.texto("Las 19 reglas del EMS", (
        "Reglas con las que se construyó el EMS, con sus parámetros actuales (`config/edificio.yaml`).\n\n"
        + tabla_md(rs, con_grupo=True) +
        "\n\n*Orden de prioridad:* protección y seguridad → control manual → limitador de demanda → secuencia → "
        "horario, ocupación e iluminación."))
    tabs.append(("Catálogo", auto([cat], 1)))

    spec = {
        "annotations": [{"kind": "AnnotationQuery", "spec": {
            "query": {"kind": "DataQuery", "group": "grafana", "version": "v0", "datasource": {"name": "-- Grafana --"}, "spec": {}},
            "enable": True, "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts",
            "builtIn": True, "legacyOptions": {"type": "dashboard"}}}],
        "cursorSync": "Crosshair",
        "description": "Las reglas con las que se construyó el EMS, sus parámetros y cuándo actúa cada una.",
        "editable": True, "elements": T.elementos,
        "layout": {"kind": "TabsLayout", "spec": {"tabs": [
            {"kind": "TabsLayoutTab", "spec": {"title": t, "layout": lay}} for t, lay in tabs]}},
        "links": enlaces(), "liveNow": False, "preload": False, "tags": ["ems"],
        "timeSettings": {"timezone": "America/Panama", "from": "now-24h", "to": "now", "autoRefresh": "1m",
                         "autoRefreshIntervals": ["30s", "1m", "5m", "15m"], "hideTimepicker": False,
                         "weekStart": "monday", "fiscalYearStartMonth": 0},
        "title": "EMS · Reglas del EMS", "variables": [],
    }
    return {"apiVersion": "dashboard.grafana.app/v2beta1", "kind": "Dashboard", "metadata": {"name": "ems-reglas"}, "spec": spec}


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
        destino = x["spec"] if "spec" in x else x  # esquema v2 (recurso Kubernetes) o clásico
        propios = [lk for lk in destino.get("links", []) if lk.get("url", "") not in {f"/d/{u}" for _, u, _ in ENLACES}]
        destino["links"] = enlaces() + propios
        f.write_text(json.dumps(x, ensure_ascii=False, indent=2) + "\n")
    tabs = d["spec"]["layout"]["spec"]["tabs"]
    print(f"ems-reglas.json: {len(d['spec']['elements'])} paneles en {len(tabs)} pestañas "
          f"({', '.join(t['spec']['title'] for t in tabs)})")


if __name__ == "__main__":
    main()
