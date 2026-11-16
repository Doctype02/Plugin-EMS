#!/usr/bin/env python3
"""Genera los 5 dashboards del EMS con un sistema visual común.

Parte de los JSON comprometidos en git (HEAD) para reutilizar sus consultas ya probadas, y escribe el
resultado en deploy/arch/grafana/dashboards/. Idempotente.
"""
import copy
import json
import subprocess
import sys

REPO = "/home/nothing/ems/Plugin-EMS"
DIR = "deploy/arch/grafana/dashboards"
OUT = sys.argv[1] if len(sys.argv) > 1 else f"{REPO}/{DIR}"
DS = {"type": "influxdb", "uid": "ems-influx"}


def orig(name):
    txt = subprocess.check_output(["git", "-C", REPO, "show", f"HEAD:{DIR}/{name}"])
    return json.loads(txt)


# ---------------------------------------------------------------- paleta semántica (fija en los 5)
C = {
    "consumo": "#5794F2",      # consumo del edificio
    "red": "#A352CC",          # importación de red / demanda en la acometida
    "fv": "#E8B10C",           # generación FV
    "limite": "#E02F44",       # potencia máxima 170 kW
    "limite_ems": "#FF9830",   # límite dinámico del EMS
    "alarma": "#F2495C",
    "aviso": "#FF9830",
    "ok": "#73BF69",
    "info": "#4C8DE6",
    "neutro": "#8E949E",
    "hvac": "#36A2B5",
    "luces": "#D6B656",
    "equipos": "#7C8AA5",
    "fija": "#5D6675",
    "critica": "#E87FA9",
    "t_ext": "#E0752D",
    "hr": "#4FA3D9",
    "precio": "#8E949E",
    "fp": "#5794F2",
    "frio": "#36A2B5",
}
LIMITE = 170
THR_POT = [("green", None), ("#EAB839", 136), ("orange", 153), ("red", LIMITE)]
THR_TEMP = [(C["info"], None), ("green", 21), ("orange", 26), ("red", 27)]
THR_ALARM = [("green", None), ("orange", 1), ("red", 5)]


def thr(steps):
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for c, v in steps]}


def fixed(color):
    return {"mode": "fixed", "fixedColor": color}


def tgt(query, ref="A"):
    return {"refId": ref, "datasource": DS, "query": query.strip("\n")}


def ov(name, *props, by="byName"):
    return {"matcher": {"id": by, "options": name},
            "properties": [{"id": k, "value": v} for k, v in props]}


def series(name, label, color, extra=(), by="byName"):
    return ov(name, ("displayName", label), ("color", fixed(color)), *extra, by=by)


DASH_LINE = ("custom.lineStyle", {"fill": "dash", "dash": [10, 6]})


# ---------------------------------------------------------------- constructores de paneles
_ids = {}


def nid(dash):
    _ids[dash] = _ids.get(dash, 0) + 1
    return _ids[dash]


def row(title, y):
    return {"type": "row", "title": title, "collapsed": False, "panels": [],
            "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}}


def stat(title, desc, queries, unit=None, decimals=None, color=None, thresholds=None, spark=False,
         mappings=None, noValue="Sin datos", overrides=None, textMode="auto", calc="lastNotNull",
         fields="", min_=None, max_=None, status=False):
    d = {"noValue": noValue, "color": {"mode": "thresholds"} if thresholds else fixed(color or C["neutro"])}
    if unit:
        d["unit"] = unit
    if decimals is not None:
        d["decimals"] = decimals
    if thresholds:
        d["thresholds"] = thr(thresholds)
    else:
        d["thresholds"] = thr([(color or C["neutro"], None)])
    if mappings:
        d["mappings"] = mappings
    if min_ is not None:
        d["min"] = min_
    if max_ is not None:
        d["max"] = max_
    return {
        "type": "stat", "title": title, "description": desc, "datasource": DS,
        "targets": [tgt(q, chr(65 + i)) for i, q in enumerate(queries)],
        "fieldConfig": {"defaults": d, "overrides": overrides or []},
        "options": {
            "reduceOptions": {"calcs": [calc], "fields": fields, "values": False},
            "colorMode": "value", "graphMode": "area" if spark else "none",
            "justifyMode": "center", "orientation": "auto", "textMode": textMode,
            "wideLayout": True, "showPercentChange": False, "percentChangeColorMode": "standard",
            "text": {"titleSize": 13, "valueSize": 22 if status else 30},
        },
    }


TS_CUSTOM = {
    "drawStyle": "line", "lineInterpolation": "smooth", "lineWidth": 2, "fillOpacity": 8,
    "gradientMode": "opacity", "showPoints": "never", "pointSize": 4, "spanNulls": 900000,
    "axisPlacement": "auto", "axisLabel": "", "axisBorderShow": False, "axisCenteredZero": False,
    "axisColorMode": "text", "barAlignment": 0, "insertNulls": False,
    "stacking": {"mode": "none", "group": "A"}, "thresholdsStyle": {"mode": "off"},
    "scaleDistribution": {"type": "linear"},
    "hideFrom": {"legend": False, "tooltip": False, "viz": False}, "lineStyle": {"fill": "solid"},
}


def ts(title, desc, queries, unit, decimals=1, overrides=None, legend=("lastNotNull", "max", "mean"),
       legend_place="bottom", custom=None, thresholds=None, min_=None, max_=None, noValue="Sin datos en el rango",
       color=None, sort="desc"):
    cu = copy.deepcopy(TS_CUSTOM)
    cu.update(custom or {})
    d = {"unit": unit, "decimals": decimals, "custom": cu, "noValue": noValue,
         "color": color or {"mode": "palette-classic"}}
    if thresholds:
        d["thresholds"] = thr(thresholds)
        cu["thresholdsStyle"] = {"mode": "dashed"}
    else:
        d["thresholds"] = thr([("green", None)])
    if min_ is not None:
        d["min"] = min_
    if max_ is not None:
        d["max"] = max_
    return {
        "type": "timeseries", "title": title, "description": desc, "datasource": DS,
        "targets": [tgt(q, chr(65 + i)) for i, q in enumerate(queries)],
        "fieldConfig": {"defaults": d, "overrides": overrides or []},
        "options": {
            "legend": {"displayMode": "table" if legend else "list", "placement": legend_place,
                       "showLegend": True, "calcs": list(legend or [])},
            "tooltip": {"mode": "multi", "sort": sort},
        },
    }


def place(p, dash, x, y, w, h):
    p = copy.deepcopy(p)
    p["id"] = nid(dash)
    p["gridPos"] = {"h": h, "w": w, "x": x, "y": y}
    p["datasource"] = DS if p["type"] not in ("row", "text") else p.get("datasource")
    if p["type"] == "row":
        p.pop("datasource", None)
    if p["type"] == "text":
        p.pop("datasource", None)
    for t in p.get("targets", []):
        t["datasource"] = DS
    return p


def from_orig(d, pid, title=None, desc=None):
    p = copy.deepcopy(next(x for x in d["panels"] if x["id"] == pid))
    if title:
        p["title"] = title
    if desc:
        p["description"] = desc
    return p


def tune_ts(p, legend=("lastNotNull", "max", "mean"), place_="bottom", sort="desc"):
    """Estilo común para series ya existentes."""
    fc = p["fieldConfig"]["defaults"]
    cu = fc.setdefault("custom", {})
    cu.update({"lineWidth": cu.get("lineWidth", 2) if cu.get("drawStyle") == "bars" else 2,
               "showPoints": "never", "gradientMode": "opacity"})
    if cu.get("drawStyle", "line") == "line" and cu.get("fillOpacity", 0) > 10 and cu.get("stacking", {}).get("mode", "none") == "none":
        cu["fillOpacity"] = 8
    fc.setdefault("noValue", "Sin datos en el rango")
    p["options"]["legend"] = {"displayMode": "table" if legend else "list", "placement": place_,
                              "showLegend": True, "calcs": list(legend or [])}
    p["options"]["tooltip"] = {"mode": "multi", "sort": sort}
    return p


# ---------------------------------------------------------------- consultas comunes
def q_last(meas, field, start="-1h"):
    return f'''from(bucket: "ems")
  |> range(start: {start})
  |> filter(fn: (r) => r._measurement == "{meas}" and r.escenario == "live" and r._field == "{field}")
  |> last()
  |> keep(columns: ["_time", "_value"])'''


def q_spark(meas, field, fn="last"):
    # Serie de las últimas 6 h (ventanas de 5 min) para el sparkline; el valor mostrado es el último.
    return f'''from(bucket: "ems")
  |> range(start: -6h)
  |> filter(fn: (r) => r._measurement == "{meas}" and r.escenario == "live" and r._field == "{field}")
  |> aggregateWindow(every: 5m, fn: {fn}, createEmpty: false)
  |> keep(columns: ["_time", "_value"])'''


WIN5 = "if int(v: v.windowPeriod) > int(v: 5m) then v.windowPeriod else 5m"

ANNOT = {
    "datasource": DS, "enable": True, "hide": False, "iconColor": C["alarma"], "name": "Alarmas críticas",
    "target": {"refId": "Anno", "query": '''from(bucket: "ems")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "alarma" and r.escenario == "live" and r._field == "mensaje" and r.nivel == "crit")
  |> group()
  |> map(fn: (r) => ({_time: r._time, text: r.codigo + " · " + r.zona + ": " + r._value, tags: r.nivel}))'''},
}
BUILTIN_ANNOT = {"builtIn": 1, "datasource": {"type": "grafana", "uid": "-- Grafana --"}, "enable": True,
                 "hide": True, "iconColor": "rgba(0, 211, 255, 1)", "name": "Annotations & Alerts",
                 "type": "dashboard"}

MAP_RED = [{"type": "value", "options": {"1": {"text": "Normal", "color": C["ok"], "index": 0},
                                          "0": {"text": "Corte · UPS", "color": C["alarma"], "index": 1}}}]
MAP_DR = [{"type": "value", "options": {"0": {"text": "En espera", "color": C["ok"], "index": 0},
                                         "1": {"text": "Activa", "color": C["aviso"], "index": 1}}}]
MAP_SIN_ALARMAS = [{"type": "value", "options": {"0": {"text": "Sin alarmas", "color": C["ok"], "index": 0}}}]
MAP_MODO = [{"type": "value", "options": {
    "reglas": {"text": "Reglas", "index": 0}, "reglas_dr": {"text": "Reglas + DR", "index": 1},
    "mpc": {"text": "MPC predictivo", "index": 2}, "baseline": {"text": "Sin EMS", "index": 3},
    "manual": {"text": "Manual", "index": 4}, "seguro": {"text": "Modo seguro", "color": C["aviso"], "index": 5},
    "externo": {"text": "Node-RED", "index": 6}}}]


def kpi_power_row(dash, y):
    """Los 4 KPI de potencia comunes (3D y Tiempo real), con sparkline de 6 h."""
    out = []
    specs = [
        ("Potencia actual", "Consumo instantáneo del edificio; sparkline de las últimas 6 h. Amarillo ≥ 80 %, naranja ≥ 90 % y rojo al llegar al límite de 170 kW.",
         "p_total_kw", None, THR_POT, "Sin datos"),
        ("Demanda 15 min", "Demanda media de 15 min en la acometida (con FV, importación neta): la magnitud que se factura y que el EMS mantiene bajo 170 kW.",
         "demanda_15min_kw", None, THR_POT, "Sin datos"),
        ("Generación FV", "Potencia de los paneles fotovoltaicos (≈ 55 kWp). Cero de noche o si el edificio corre sin la variante FV.",
         "p_fv_kw", C["fv"], None, "Sin FV"),
        ("Importación de red", "Potencia neta tomada de la red: consumo menos FV. Negativa = excedente FV inyectado a la red.",
         "p_red_kw", C["red"], None, "Sin datos"),
    ]
    for i, (t, ds, f, col, th, nv) in enumerate(specs):
        out.append(place(stat(t, ds, [q_spark("medidor", f)], unit="kwatt", decimals=1, color=col, thresholds=th,
                              spark=True, noValue=nv, min_=0), dash, i * 4, y, 4, 4))
    return out


def dash_base(d, refresh, time=None, graph_tooltip=2):
    d = copy.deepcopy(d)
    d["editable"] = True
    d["timezone"] = "America/Panama"
    d["graphTooltip"] = graph_tooltip
    d["weekStart"] = "monday"
    d["fiscalYearStartMonth"] = 0
    d["liveNow"] = False
    d["refresh"] = refresh
    if time:
        d["time"] = time
    if refresh:
        d["timepicker"] = {"refresh_intervals": ["30s", "1m", "5m", "15m"]}
    d.pop("id", None)
    return d


# ================================================================= 1. Edificio 3D
def build_3d():
    o = orig("ems-edificio-3d.json")
    D = "3d"
    d = dash_base(o, "30s")
    d["description"] = "Gemelo digital del edificio en vivo: vista 3D por planta y zona con potencia, demanda, FV, red y alarmas."
    plugin = from_orig(o, 1, title="Gemelo digital del edificio")
    plugin["description"] = "Vista 3D del edificio de 5 plantas con el estado de cada zona, las unidades VRF/PTAC y los controles del EMS. Haz clic en una planta o zona para ver su detalle."
    panels = [place(row("Resumen", 0), D, 0, 0, 24, 1)]
    panels += kpi_power_row(D, 1)
    panels.append(place(stat("Red eléctrica", "Estado de la acometida. Durante un corte las cargas críticas siguen con el UPS.",
                             [q_last("medidor", "red_ok")], mappings=MAP_RED, thresholds=[(C["alarma"], None), (C["ok"], 1)]),
                        D, 16, 1, 4, 4))
    panels.append(place(stat("Alarmas activas", "Alarmas activas que informa el EMS. Detalle en el tablero Alarmas.",
                             [q_last("ems", "n_alarmas")], decimals=0, thresholds=THR_ALARM, mappings=MAP_SIN_ALARMAS,
                             noValue="Sin datos"), D, 20, 1, 4, 4))
    panels.append(place(row("Gemelo digital", 5), D, 0, 5, 24, 1))
    panels.append(place(plugin, D, 0, 6, 24, 25))
    d["panels"] = panels
    d["annotations"] = {"list": [BUILTIN_ANNOT]}
    d["templating"] = {"list": []}
    return d


# ================================================================= 2. Tiempo real
UNIDAD_PIVOT = '''from(bucket: "ems")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live")
  |> last()
  |> pivot(rowKey: ["_time", "unidad", "tipo"], columnKey: ["_field"], valueColumn: "_value")
  |> group(columns: ["unidad"])
  |> sort(columns: ["_time"])
  |> tail(n: 1)
  |> group()'''


def uq(cond, tail):
    return f'''from(bucket: "ems")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live" and ({cond}))
  |> last()
{tail}'''


def unidad_kpi(expr_map, reducer):
    return UNIDAD_PIVOT + f"\n  |> map(fn: (r) => ({{_value: {expr_map}}}))\n  |> {reducer}"


def build_tiempo_real():
    o = orig("ems-tiempo-real.json")
    D = "tr"
    d = dash_base(o, "30s", time={"from": "now-12h", "to": "now"})
    d["description"] = "Operación en vivo: potencia, demanda frente a 170 kW, FV, energía y costo del día, estado del EMS y de las 11 unidades VRF/PTAC."
    P = []
    y = 0
    P.append(place(row("Resumen", y), D, 0, y, 24, 1))
    P += kpi_power_row(D, 1)
    # energía y costo de hoy
    e = from_orig(o, 5)
    P.append(place(stat("Energía de hoy", "Energía consumida por el edificio desde las 00:00 (hora de Panamá).",
                        [e["targets"][0]["query"]], unit="kwatth", decimals=0, color=C["consumo"], noValue="0 kWh"),
                   D, 16, 1, 4, 4))
    c = from_orig(o, 6)
    P.append(place(stat("Costo de hoy", "Costo estimado desde las 00:00: importación × tarifa vigente (punta 0.245 / fuera de punta 0.185 USD/kWh) menos el excedente FV a 0.10 USD/kWh. Sin cargo por demanda.",
                        [c["targets"][0]["query"]], unit="currencyUSD", decimals=2, color=C["neutro"], noValue="0 USD"),
                   D, 20, 1, 4, 4))
    # fila de estado
    modo_q = from_orig(o, 10)["targets"][0]["query"]
    P.append(place(stat("Red eléctrica", "Estado de la acometida. Durante un corte las cargas críticas siguen con el UPS.",
                        [q_last("medidor", "red_ok")], mappings=MAP_RED, thresholds=[(C["alarma"], None), (C["ok"], 1)],
                        status=True), D, 0, 5, 4, 3))
    P.append(place(stat("Respuesta demanda", "Respuesta a la demanda (DR). Activa: el EMS recorta cargas no críticas para respetar el límite de demanda.",
                        [q_last("ems", "dr_activo")], mappings=MAP_DR, thresholds=[(C["ok"], None), (C["aviso"], 1)],
                        status=True), D, 4, 5, 4, 3))
    P.append(place(stat("Estrategia del EMS", "Estrategia de control activa en el EMS.", [modo_q], color=C["consumo"],
                        mappings=MAP_MODO, status=True, fields="/.*/"), D, 8, 5, 4, 3))
    P.append(place(stat("Límite EMS", "Límite dinámico que aplica ahora el EMS. El límite contractual del edificio es 170 kW.",
                        [q_last("ems", "limite_kw")], unit="kwatt", decimals=0, color=C["limite_ems"], status=True),
                   D, 12, 5, 4, 3))
    P.append(place(stat("Alarmas activas", "Alarmas activas que informa el EMS. Detalle en el tablero Alarmas.",
                        [q_last("ems", "n_alarmas")], decimals=0, thresholds=THR_ALARM, mappings=MAP_SIN_ALARMAS,
                        status=True), D, 16, 5, 4, 3))
    P.append(place(stat("Latencia de control", "Tiempo entre la orden del EMS y la confirmación del gemelo. Naranja ≥ 500 ms, rojo ≥ 2 s.",
                        [q_last("ems", "latencia_ms")], unit="ms", decimals=0,
                        thresholds=[("green", None), ("orange", 500), ("red", 2000)], status=True), D, 20, 5, 4, 3))

    # ---- Energía
    y = 8
    P.append(place(row("Energía", y), D, 0, y, 24, 1))
    pot = from_orig(o, 11, desc="Consumo del edificio, importación de red y generación FV (medias de 5 min). Línea roja discontinua: potencia máxima de 170 kW.")
    pot["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    pot["fieldConfig"]["defaults"]["custom"]["axisSoftMax"] = 180
    pot["fieldConfig"]["overrides"] = [
        series("p_total_kw", "Consumo del edificio", C["consumo"]),
        series("p_red_kw", "Importación de red", C["red"]),
        series("p_fv_kw", "Generación FV", C["fv"]),
    ]
    P.append(place(tune_ts(pot), D, 0, y + 1, 16, 10))
    dem = from_orig(o, 12, title="Demanda 15 min frente al límite",
                    desc="Demanda de 15 min en la acometida frente al límite dinámico del EMS (escalonado) y a la potencia máxima de 170 kW (línea roja).")
    dem["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    dem["fieldConfig"]["defaults"]["custom"]["fillOpacity"] = 8
    dem["fieldConfig"]["overrides"] = [
        series("demanda_15min_kw", "Demanda 15 min", C["red"]),
        series("limite_kw", "Límite EMS", C["limite_ems"], [DASH_LINE, ("custom.fillOpacity", 0),
                                                            ("custom.lineInterpolation", "stepAfter"), ("custom.lineWidth", 1)]),
    ]
    P.append(place(tune_ts(dem, legend=("lastNotNull", "max")), D, 16, y + 1, 8, 10))

    uso = from_orig(o, 13, desc="Desglose apilado del consumo: climatización (6 VRF + 5 PTAC), iluminación, equipos y cargas fijas (ascensor, extractores). La línea rosa discontinua es la carga crítica de TI (Z06), ya incluida.")
    uso["fieldConfig"]["defaults"]["custom"]["lineInterpolation"] = "smooth"
    uso["fieldConfig"]["overrides"] = [
        series("p_hvac_kw", "Climatización", C["hvac"]),
        series("p_luces_kw", "Iluminación", C["luces"]),
        series("p_equipos_kw", "Equipos y enchufes", C["equipos"]),
        series("p_fija_kw", "Cargas fijas", C["fija"]),
        series("p_critica_kw", "TI crítica (Z06)", C["critica"], [DASH_LINE, ("custom.fillOpacity", 0),
                                                                   ("custom.stacking", {"mode": "none", "group": "B"})]),
    ]
    P.append(place(tune_ts(uso, legend=("lastNotNull", "max", "mean"), place_="right"), D, 0, y + 11, 12, 9))

    # balance de hoy (barra horizontal)
    bal = {
        "type": "bargauge", "title": "Balance energético de hoy",
        "description": "Energía integrada desde las 00:00 (hora de Panamá): consumo del edificio, generación FV y energía neta importada de la red.",
        "datasource": DS, "targets": [tgt(t["query"], t["refId"]) for t in e["targets"]],
        "fieldConfig": {"defaults": {"unit": "kwatth", "decimals": 0, "min": 0, "noValue": "0 kWh",
                                     "color": fixed(C["consumo"]), "thresholds": thr([("green", None)])},
                        "overrides": [series("A", "Consumo", C["consumo"], by="byFrameRefID"),
                                      series("B", "Generación FV", C["fv"], by="byFrameRefID"),
                                      series("C", "Importación de red", C["red"], by="byFrameRefID")]},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "orientation": "horizontal", "displayMode": "basic", "valueMode": "color",
                    "namePlacement": "top", "showUnfilled": True, "sizing": "auto", "minVizHeight": 16,
                    "minVizWidth": 8, "maxVizHeight": 36, "legend": {"showLegend": False},
                    "text": {"titleSize": 13, "valueSize": 18}},
    }
    P.append(place(bal, D, 12, y + 11, 6, 9))
    fv = from_orig(o, 14, desc="Generación FV (kW, eje izquierdo) e irradiancia global horizontal (W/m², eje derecho).")
    fv["fieldConfig"]["defaults"]["decimals"] = 1
    for x in fv["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "p_fv_kw":
            props.update({"displayName": "Generación FV", "color": fixed(C["fv"])})
        else:
            props.update({"displayName": "Irradiancia", "color": fixed(C["neutro"]), "decimals": 0})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(fv, legend=("lastNotNull", "max")), D, 18, y + 11, 6, 9))

    tar = from_orig(o, 16, desc="Precio de la energía vigente (USD/kWh, escalonado: punta lun–vie 09:00–17:00) y factor de potencia del edificio (eje derecho).")
    for x in tar["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "precio_usd_kwh":
            props.update({"displayName": "Precio de la energía", "color": fixed(C["precio"])})
        else:
            props.update({"displayName": "Factor de potencia", "color": fixed(C["fp"])})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(tar, legend=("lastNotNull", "min", "max")), D, 0, y + 20, 12, 8))
    cli = from_orig(o, 15, desc="Temperatura exterior de bulbo seco (°C, eje izquierdo) y humedad relativa exterior (%, eje derecho) del archivo climático de Panamá.")
    for x in cli["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "t_ext_c":
            props.update({"displayName": "Temperatura exterior", "color": fixed(C["t_ext"])})
        else:
            props.update({"displayName": "Humedad relativa exterior", "color": fixed(C["hr"]), "decimals": 0})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(cli, legend=("lastNotNull", "min", "max")), D, 12, y + 20, 12, 8))

    # ---- Controladores
    y = 37
    P.append(place(row("Controladores VRF/PTAC", y), D, 0, y, 24, 1))
    P.append(place(stat("Unidades en marcha", "Unidades VRF/PTAC con el compresor trabajando (carga > 0) de las 11 del edificio.",
                        [uq('r._field == "carga_pct"', '  |> group()\n  |> map(fn: (r) => ({r with _value: if r._value > 0.0 then 1 else 0}))\n  |> sum()')],
                        unit="suffix: de 11", decimals=0, color=C["hvac"]), D, 0, y + 1, 4, 4))
    P.append(place(stat("Climatización", "Potencia eléctrica total de las 11 unidades VRF/PTAC; sparkline de las últimas 6 h.",
                        ['''from(bucket: "ems")
  |> range(start: -6h)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live" and r._field == "p_kw")
  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)
  |> group()
  |> aggregateWindow(every: 5m, fn: sum, createEmpty: false)
  |> keep(columns: ["_time", "_value"])'''],
                        unit="kwatt", decimals=1, color=C["hvac"], spark=True, min_=0), D, 4, y + 1, 4, 4))
    P.append(place(stat("Frío entregado", "Capacidad frigorífica total que entregan ahora las unidades.",
                        [uq('r._field == "q_frio_kw"', '  |> group()\n  |> sum()')],
                        unit="kwatt", decimals=1, color=C["frio"]), D, 8, y + 1, 4, 4))
    P.append(place(stat("COP del sistema", "Eficiencia global: frío entregado / potencia eléctrica de las unidades en marcha. Sin unidades en marcha no hay valor.",
                        [uq('r._field == "p_kw" or r._field == "q_frio_kw"', '''  |> pivot(rowKey: ["unidad"], columnKey: ["_field"], valueColumn: "_value")
  |> group()
  |> filter(fn: (r) => r.p_kw > 0.0)
  |> reduce(identity: {p: 0.0, q: 0.0}, fn: (r, accumulator) => ({p: accumulator.p + r.p_kw, q: accumulator.q + r.q_frio_kw}))
  |> map(fn: (r) => ({r with _value: r.q / r.p}))
  |> keep(columns: ["_value"])''')],
                        decimals=2, color=C["ok"], noValue="Sin compresores en marcha",
                        thresholds=[(C["aviso"], None), (C["ok"], 2.5)]), D, 12, y + 1, 4, 4))
    P.append(place(stat("Unidades en manual", "Unidades con un ajuste local (forzado desde el panel 3D) que tiene prioridad sobre el EMS.",
                        [uq('r._field == "forzado"', '  |> group()\n  |> sum()')], decimals=0,
                        thresholds=[(C["ok"], None), (C["aviso"], 1)],
                        mappings=[{"type": "value", "options": {"0": {"text": "Sin forzados", "color": C["ok"], "index": 0}}}]),
                   D, 16, y + 1, 4, 4))
    P.append(place(stat("Unidades en falla", "Unidades con falla activa (evento falla_vrf) o sin energía por un corte.",
                        [uq('r._field == "falla" or r._field == "sin_energia"', '  |> pivot(rowKey: ["unidad"], columnKey: ["_field"], valueColumn: "_value")\n  |> group()\n  |> map(fn: (r) => ({r with _value: if r.falla > 0 or r.sin_energia > 0 then 1 else 0}))\n  |> sum()')],
                        decimals=0, thresholds=[(C["ok"], None), (C["alarma"], 1)],
                        mappings=[{"type": "value", "options": {"0": {"text": "Sin fallas", "color": C["ok"], "index": 0}}}]),
                   D, 20, y + 1, 4, 4))

    tabla_q = UNIDAD_PIVOT + '''
  |> map(fn: (r) => ({
      unidad: r.unidad,
      tipo: if r.tipo == "vrf" then "VRF" else "PTAC",
      servicio: if r.unidad == "VRF-SRV" then "Servidores (Z06)" else if r.tipo == "ptac" then "Baños " + strings.trimPrefix(v: r.unidad, prefix: "PTAC-") else "Planta " + strings.trimPrefix(v: r.unidad, prefix: "VRF-"),
      estado: if exists r.falla and r.falla > 0 then 4 else if exists r.sin_energia and r.sin_energia > 0 then 3 else if exists r.encendido and r.encendido < 1 then 0 else if exists r.carga_pct and r.carga_pct > 0.0 then 2 else 1,
      modo: r.modo,
      control: if exists r.forzado and r.forzado > 0 then (if exists r.restante_min and r.restante_min >= 0.0 then "Manual · " + string(v: int(v: r.restante_min)) + " min" else "Manual") else "EMS",
      p_kw: r.p_kw, q_frio_kw: r.q_frio_kw, carga_pct: r.carga_pct, cop: r.cop,
      capacidad_pct: r.capacidad_pct, setpoint_c: r.setpoint_c
  }))
  |> sort(columns: ["unidad"])'''
    tabla_q = 'import "strings"\n\n' + tabla_q
    W = lambda n: ("custom.width", n)
    tabla = {
        "type": "table", "title": "Estado de las unidades",
        "description": "Último estado de cada unidad VRF (plantas y servidores) y PTAC (baños): potencia eléctrica, frío entregado, carga del compresor, COP, modo y si está en control manual o con falla. COP «—» = compresor parado.",
        "datasource": DS, "targets": [tgt(tabla_q)],
        "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}, "inspect": False,
                                                "filterable": False}, "noValue": "Sin datos de las unidades"},
                        "overrides": [
                            ov("unidad", ("displayName", "Unidad"), W(100)),
                            ov("tipo", ("displayName", "Tipo"), W(70)),
                            ov("servicio", ("displayName", "Da servicio a"), W(150)),
                            ov("estado", ("displayName", "Estado"), W(120), ("custom.cellOptions", {"type": "color-text"}),
                               ("mappings", [{"type": "value", "options": {
                                   "0": {"text": "Apagada", "color": C["neutro"], "index": 0},
                                   "1": {"text": "En espera", "color": C["info"], "index": 1},
                                   "2": {"text": "En marcha", "color": C["ok"], "index": 2},
                                   "3": {"text": "Sin energía", "color": "#C4162A", "index": 3},
                                   "4": {"text": "FALLA", "color": C["alarma"], "index": 4}}}])),
                            ov("modo", ("displayName", "Modo"), W(120), ("mappings", [{"type": "value", "options": {
                                "auto": {"text": "Automático", "index": 0}, "frio": {"text": "Frío local", "color": C["aviso"], "index": 1},
                                "ventilacion": {"text": "Ventilación", "color": C["info"], "index": 2},
                                "apagado": {"text": "Apagado", "color": C["neutro"], "index": 3}}}])),
                            ov("control", ("displayName", "Control"), W(130), ("custom.cellOptions", {"type": "color-text"}),
                               ("mappings", [{"type": "value", "options": {"EMS": {"text": "EMS", "color": C["ok"], "index": 0}}},
                                             {"type": "regex", "options": {"pattern": "^Manual.*", "result": {"color": C["aviso"], "index": 1}}}])),
                            ov("p_kw", ("displayName", "Potencia"), ("unit", "kwatt"), ("decimals", 1), W(95)),
                            ov("q_frio_kw", ("displayName", "Frío"), ("unit", "kwatt"), ("decimals", 1), W(95)),
                            ov("carga_pct", ("displayName", "Carga"), ("unit", "percent"), ("decimals", 0), ("min", 0), ("max", 100),
                               ("color", {"mode": "thresholds"}), ("thresholds", thr([(C["hvac"], None), (C["aviso"], 90)])),
                               ("custom.cellOptions", {"type": "gauge", "mode": "basic", "valueDisplayMode": "text"})),
                            ov("cop", ("displayName", "COP"), ("decimals", 2), W(70), ("noValue", "—")),
                            ov("capacidad_pct", ("displayName", "Tope"), ("unit", "percent"), ("decimals", 0), W(70)),
                            ov("setpoint_c", ("displayName", "Consigna local"), ("unit", "celsius"), ("decimals", 1), W(120), ("noValue", "—")),
                        ]},
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False, "reducer": ["sum"], "fields": ""}},
        "transformations": [{"id": "organize", "options": {"indexByName": {
            "unidad": 0, "tipo": 1, "servicio": 2, "estado": 3, "modo": 4, "control": 5, "p_kw": 6, "q_frio_kw": 7,
            "carga_pct": 8, "cop": 9, "capacidad_pct": 10, "setpoint_c": 11}}}],
    }
    P.append(place(tabla, D, 0, y + 5, 24, 13))

    tl_q = '''from(bucket: "ems")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live")
  |> filter(fn: (r) => r._field == "carga_pct" or r._field == "encendido" or r._field == "falla" or r._field == "sin_energia" or r._field == "forzado")
  |> map(fn: (r) => ({r with _value: float(v: r._value)}))
  |> aggregateWindow(every: ''' + WIN5 + ''', fn: last, createEmpty: false)
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> map(fn: (r) => ({_time: r._time, unidad: r.unidad,
      _value: if r.falla > 0.0 then 4 else if r.sin_energia > 0.0 then 3 else if r.encendido < 1.0 then 0
              else if r.forzado > 0.0 then 5 else if r.carga_pct > 0.0 then 2 else 1}))
  |> group(columns: ["unidad"])'''
    tl = {
        "type": "state-timeline", "title": "Estado de las unidades en el tiempo",
        "description": "Estado de cada unidad: en marcha (verde), en espera (azul), manual (naranja), apagada (gris), sin energía o en falla (rojo).",
        "datasource": DS, "targets": [tgt(tl_q)],
        "fieldConfig": {"defaults": {"custom": {"lineWidth": 0, "fillOpacity": 80},
                                     "displayName": "${__field.labels.unidad}", "color": fixed(C["neutro"]),
                                     "noValue": "Sin datos en el rango",
                                     "mappings": [{"type": "value", "options": {
                                         "0": {"text": "Apagada", "color": C["neutro"], "index": 0},
                                         "1": {"text": "En espera", "color": C["info"], "index": 1},
                                         "2": {"text": "En marcha", "color": C["ok"], "index": 2},
                                         "3": {"text": "Sin energía", "color": "#C4162A", "index": 3},
                                         "4": {"text": "Falla", "color": C["alarma"], "index": 4},
                                         "5": {"text": "Manual", "color": C["aviso"], "index": 5}}}]},
                        "overrides": []},
        "options": {"showValue": "never", "rowHeight": 0.8, "mergeValues": True, "alignValue": "left",
                    "legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"},
                    "tooltip": {"mode": "single", "sort": "none"}},
    }
    P.append(place(tl, D, 0, y + 18, 12, 10))
    pu = ts("Potencia por unidad", "Potencia eléctrica de cada unidad VRF/PTAC (apilada, medias de 5 min).",
            ['''from(bucket: "ems")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live" and r._field == "p_kw")
  |> aggregateWindow(every: ''' + WIN5 + ''', fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "unidad"])
  |> group(columns: ["unidad"])'''], "kwatt", 1,
            overrides=[ov("/.*/", ("displayName", "${__field.labels.unidad}"), by="byRegexp")],
            legend=("lastNotNull", "max", "mean"), legend_place="right",
            custom={"stacking": {"mode": "normal", "group": "A"}, "fillOpacity": 30, "lineWidth": 1}, min_=0)
    P.append(place(pu, D, 12, y + 18, 12, 10))

    # ---- Alarmas
    y = 66
    P.append(place(row("Alarmas", y), D, 0, y, 24, 1))
    al = from_orig(o, 17, desc="Últimas 50 alarmas del rango, de la más reciente a la más antigua. Detalle completo en el tablero Alarmas.")
    al["fieldConfig"]["defaults"]["noValue"] = "Sin alarmas en el rango"
    style_alarm_table(al)
    P.append(place(al, D, 0, y + 1, 24, 8))

    d["panels"] = P
    d["annotations"] = {"list": [BUILTIN_ANNOT, ANNOT]}
    return d


def style_alarm_table(p):
    for x in p["fieldConfig"]["overrides"]:
        if x["matcher"]["options"] == "nivel":
            for pr in x["properties"]:
                if pr["id"] == "custom.cellOptions":
                    pr["value"] = {"type": "color-text"}
                if pr["id"] == "mappings":
                    pr["value"] = [{"type": "value", "options": {
                        "crit": {"text": "● Crítica", "color": C["alarma"], "index": 0},
                        "warn": {"text": "● Aviso", "color": C["aviso"], "index": 1},
                        "info": {"text": "● Info", "color": C["info"], "index": 2}}}]
                if pr["id"] == "custom.width":
                    pr["value"] = 100
        if x["matcher"]["options"] == "_time":
            x["properties"] = [{"id": "displayName", "value": "Hora"}, {"id": "unit", "value": "time:DD/MM HH:mm:ss"},
                               {"id": "custom.width", "value": 140}]
        if x["matcher"]["options"] == "zona":
            x["properties"] = [{"id": "displayName", "value": "Zona / equipo"}, {"id": "custom.width", "value": 120}]
    # orden de columnas
    p["transformations"] = [{"id": "organize", "options": {"indexByName": {
        "_time": 0, "nivel": 1, "codigo": 2, "zona": 3, "_value": 4, "mensaje": 4, "valor": 5}}}]
    p["options"]["cellHeight"] = "sm"


# ================================================================= 3. Zonas
def build_zonas():
    o = orig("ems-zonas.json")
    D = "zo"
    d = dash_base(o, "30s", time={"from": "now-12h", "to": "now"})
    d["description"] = "Confort, ocupación, climatización y sensores de las 26 zonas (filtrables por planta y zona); Z06 es la zona crítica."
    P = []
    P.append(place(row("Resumen", 0), D, 0, 0, 24, 1))
    tm = from_orig(o, 1, desc="Temperatura media actual de las zonas seleccionadas, sin el cuarto de servidores. Verde = banda de confort 21–26 °C.")
    tm["fieldConfig"]["defaults"]["thresholds"] = thr(THR_TEMP)
    P.append(place(restat(tm), D, 0, 1, 4, 4))
    fc = from_orig(o, 2, desc="Zonas seleccionadas (sin Z06) con la temperatura fuera de la banda de confort 21–26 °C.")
    fc["title"] = "Fuera de confort"
    fc["fieldConfig"]["defaults"]["mappings"] = [{"type": "value", "options": {"0": {"text": "Ninguna", "color": C["ok"], "index": 0}}}]
    fc["fieldConfig"]["defaults"]["noValue"] = "Sin datos"
    P.append(place(restat(fc), D, 4, 1, 4, 4))
    oc = from_orig(o, 3, desc="Personas presentes ahora en las zonas seleccionadas.")
    oc["fieldConfig"]["defaults"]["unit"] = "suffix: personas"
    P.append(place(restat(oc, color=C["consumo"]), D, 8, 1, 4, 4))
    pz = from_orig(o, 5, title="Potencia zonas", desc="Potencia actual (climatización + luces + equipos) de las zonas seleccionadas.")
    P.append(place(restat(pz, color=C["consumo"]), D, 12, 1, 4, 4))
    z6 = from_orig(o, 6, title="Servidores Z06",
                   desc="Temperatura del cuarto de servidores, la zona crítica (consigna fija). Alarma SERVIDOR_TEMP a 27 °C. Se muestra aunque no esté seleccionada.")
    z6["targets"][0]["query"] = q_spark("zona", "temp_c", "mean").replace('r._measurement == "zona" and', 'r._measurement == "zona" and r.zona == "Z06" and')
    z6["options"]["graphMode"] = "area"
    P.append(place(restat(z6), D, 16, 1, 4, 4))
    sf_q = '''from(bucket: "ems")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.zona =~ /^(${zona:pipe})$/ and r._field == "sensor_forzado")
  |> last()
  |> group()
  |> map(fn: (r) => ({r with _value: int(v: r._value)}))
  |> sum()'''
    P.append(place(stat("Sensores forzados", "Zonas seleccionadas cuyo sensor está forzado desde el panel 3D (desfase, valor fijo o congelado): el EMS lee un valor distinto del real.",
                        [sf_q], decimals=0, thresholds=[(C["ok"], None), (C["aviso"], 1)],
                        mappings=[{"type": "value", "options": {"0": {"text": "Sin forzados", "color": C["ok"], "index": 0}}}]),
                   D, 20, 1, 4, 4))

    # ---- Zonas
    y = 5
    P.append(place(row("Zonas", y), D, 0, y, 24, 1))
    tb = from_orig(o, 7, desc="Último valor de cada zona seleccionada. Temperatura coloreada por confort (azul < 21 °C, verde 21–26, naranja 26–27, rojo ≥ 27). Δ = temperatura − consigna. «Sensor forzado» = el EMS lee un valor simulado.")
    q = tb["targets"][0]["query"]
    q = q.replace('r._field == "p_total_kw"))', 'r._field == "p_total_kw" or r._field == "sensor_forzado"))')
    q = q.replace("critica: r.critica\n", 'critica: r.critica,\n      unidad: if r.zona == "Z06" then "VRF-SRV" else if r.tipo == "bano" then "PTAC-" + planta(z: r.zona) else "VRF-" + planta(z: r.zona),\n      sensor: if exists r.sensor_forzado then r.sensor_forzado else 0.0\n')
    q = q.replace('rowKey: ["zona", "nombre", "critica"]', 'rowKey: ["zona", "nombre", "critica", "tipo"]')
    assert "sensor_forzado" in q and "unidad:" in q, "no se pudo extender la consulta de la tabla de zonas"
    tb["targets"][0]["query"] = q
    tb["fieldConfig"]["overrides"] += [
        ov("unidad", ("displayName", "Unidad"), ("custom.width", 90)),
        ov("sensor", ("displayName", "Sensor"), ("custom.width", 90), ("custom.cellOptions", {"type": "color-text"}),
           ("mappings", [{"type": "value", "options": {"0": {"text": "Real", "color": C["neutro"], "index": 0},
                                                        "1": {"text": "Forzado", "color": C["aviso"], "index": 1}}}])),
    ]
    for x in tb["fieldConfig"]["overrides"]:
        if x["matcher"]["options"] == "temp":
            for pr in x["properties"]:
                if pr["id"] == "thresholds":
                    pr["value"] = thr(THR_TEMP)
                if pr["id"] == "custom.cellOptions":
                    pr["value"] = {"type": "color-text"}
        if x["matcher"]["options"] == "estado":
            for pr in x["properties"]:
                if pr["id"] == "mappings":
                    pr["value"] = [{"type": "value", "options": {
                        "0": {"text": "Deshabilitado", "color": C["neutro"], "index": 0},
                        "1": {"text": "En espera", "color": C["info"], "index": 1},
                        "2": {"text": "Enfriando", "color": C["ok"], "index": 2}}}]
        if x["matcher"]["options"] == "luces":
            for pr in x["properties"]:
                if pr["id"] == "color":
                    pr["value"] = fixed(C["luces"])
        if x["matcher"]["options"] == "critica":
            for pr in x["properties"]:
                if pr["id"] == "custom.cellOptions":
                    pr["value"] = {"type": "color-text"}
                if pr["id"] == "mappings":
                    pr["value"] = [{"type": "value", "options": {"si": {"text": "Crítica", "color": C["alarma"], "index": 0},
                                                                  "no": {"text": "—", "color": C["neutro"], "index": 1}}}]
    tb["transformations"] = [{"id": "organize", "options": {"excludeByName": {}, "renameByName": {}, "indexByName": {
        "zona": 0, "planta": 1, "nombre": 2, "temp": 3, "sp": 4, "delta": 5, "ocupantes": 6, "estado": 7,
        "unidad": 8, "luces": 9, "p_hvac": 10, "p_total": 11, "sensor": 12, "critica": 13}}}]
    tb["options"]["cellHeight"] = "sm"
    P.append(place(tb, D, 0, y + 1, 16, 20))
    mc = from_orig(o, 8, desc="Temperatura media de 15 min de cada zona, coloreada por confort (azul < 21, verde 21–26, naranja 26–27, rojo ≥ 27 °C).")
    mc["fieldConfig"]["defaults"]["thresholds"] = thr(THR_TEMP)
    mc["fieldConfig"]["defaults"]["noValue"] = "Sin datos en el rango"
    mc["options"]["tooltip"] = {"mode": "single", "sort": "none"}
    P.append(place(mc, D, 16, y + 1, 8, 20))

    # ---- Climatización
    y = 26
    P.append(place(row("Climatización", y), D, 0, y, 24, 1))
    tz = from_orig(o, 9, desc="Temperatura de las zonas seleccionadas. Línea roja discontinua: 27 °C; naranja: límite superior de confort 26 °C.")
    tz["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("orange", 26), ("red", 27)])
    tz["fieldConfig"]["defaults"]["custom"]["thresholdsStyle"] = {"mode": "dashed"}
    P.append(place(tune_ts(tz, legend=("lastNotNull", "max", "mean"), place_="right"), D, 0, y + 1, 12, 10))
    dv = from_orig(o, 10, desc="Temperatura − consigna de cada zona. Positivo = más caliente que la consigna; líneas discontinuas: banda aceptable ±1 °C.")
    dv["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), (C["ok"], -1), (C["aviso"], 1)])
    dv["fieldConfig"]["defaults"]["custom"]["thresholdsStyle"] = {"mode": "dashed"}
    P.append(place(tune_ts(dv, legend=("lastNotNull", "max", "mean"), place_="right"), D, 12, y + 1, 12, 10))
    et = from_orig(o, 12, desc="Verde = enfriando; azul = habilitado en espera (termostato satisfecho); gris = deshabilitado por el EMS. Z06 ignora el deshabilitado.")
    et["fieldConfig"]["defaults"]["mappings"] = [{"type": "value", "options": {
        "0": {"text": "Deshabilitado", "color": C["neutro"], "index": 0},
        "1": {"text": "En espera", "color": C["info"], "index": 1},
        "2": {"text": "Enfriando", "color": C["ok"], "index": 2}}}]
    et["fieldConfig"]["defaults"]["noValue"] = "Sin datos en el rango"
    P.append(place(et, D, 0, y + 11, 12, 13))
    ocp = from_orig(o, 11, desc="Personas por zona (apilado). Sigue el horario del modelo salvo que se fuerce desde el panel 3D.")
    P.append(place(tune_ts(ocp, legend=("lastNotNull", "max"), place_="right"), D, 12, y + 11, 12, 13))

    # ---- Sensores
    y = 51
    P.append(place(row("Sensores", y), D, 0, y, 24, 1))
    sens_q = '''from(bucket: "ems")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.zona =~ /^(${zona:pipe})$/)
  |> filter(fn: (r) => r._field == "sensor_forzado" or r._field == "temp_c" or r._field == "temp_real_c" or r._field == "hr_pct" or r._field == "hr_real_pct" or r._field == "ocupado" or r._field == "ocupado_real" or r._field == "sensor_temp_offset_c" or r._field == "sensor_temp_fijo_c" or r._field == "sensor_hr_fijo_pct" or r._field == "sensor_presencia" or r._field == "sensor_congelado" or r._field == "sensor_restante_min")
  |> last()
  |> map(fn: (r) => ({r with _value: float(v: r._value)}))
  |> pivot(rowKey: ["_time", "zona", "nombre"], columnKey: ["_field"], valueColumn: "_value")
  |> group(columns: ["zona"])
  |> sort(columns: ["_time"])
  |> tail(n: 1)
  |> group()
  |> filter(fn: (r) => exists r.sensor_forzado and r.sensor_forzado > 0.5)
  |> map(fn: (r) => ({
      zona: r.zona, nombre: r.nombre,
      ajuste: if exists r.sensor_congelado and r.sensor_congelado > 0.5 then "Congelado"
              else if exists r.sensor_temp_fijo_c then "T fija " + string(v: r.sensor_temp_fijo_c) + " °C"
              else if exists r.sensor_temp_offset_c then "Desfase " + string(v: r.sensor_temp_offset_c) + " °C"
              else if exists r.sensor_hr_fijo_pct then "HR fija " + string(v: r.sensor_hr_fijo_pct) + " %"
              else if exists r.sensor_presencia then (if r.sensor_presencia > 0.5 then "Presencia forzada" else "Ausencia forzada")
              else "Forzado",
      t_leida: r.temp_c, t_real: r.temp_real_c, dt: r.temp_c - r.temp_real_c,
      hr_leida: r.hr_pct, hr_real: r.hr_real_pct,
      ocup_leida: r.ocupado, ocup_real: r.ocupado_real,
      restante: if exists r.sensor_restante_min then r.sensor_restante_min else -1.0
  }))
  |> sort(columns: ["zona"])'''
    MAP_OCUP = [{"type": "value", "options": {"0": {"text": "Libre", "index": 0}, "1": {"text": "Ocupada", "index": 1}}}]
    sens = {
        "type": "table", "title": "Sensores forzados: lectura frente a real",
        "description": "Zonas cuyo sensor está forzado ahora: lo que leen el termostato y el EMS frente al estado real de la zona. Δ T = leída − real.",
        "datasource": DS, "targets": [tgt(sens_q)],
        "fieldConfig": {"defaults": {"custom": {"align": "auto", "cellOptions": {"type": "auto"}, "inspect": False},
                                     "noValue": "Sin forzados: todos los sensores leen el valor real"},
                        "overrides": [
                            ov("zona", ("displayName", "Zona"), ("custom.width", 60)),
                            ov("nombre", ("displayName", "Nombre"), ("custom.width", 150)),
                            ov("ajuste", ("displayName", "Ajuste"), ("custom.width", 150), ("color", fixed(C["aviso"])),
                               ("custom.cellOptions", {"type": "color-text"})),
                            ov("t_leida", ("displayName", "T leída"), ("unit", "celsius"), ("decimals", 1)),
                            ov("t_real", ("displayName", "T real"), ("unit", "celsius"), ("decimals", 1)),
                            ov("dt", ("displayName", "Δ T"), ("unit", "celsius"), ("decimals", 1), ("color", {"mode": "thresholds"}),
                               ("thresholds", thr([(C["alarma"], None), (C["aviso"], -1), (C["ok"], -0.3), (C["aviso"], 0.3), (C["alarma"], 1)])),
                               ("custom.cellOptions", {"type": "color-text"})),
                            ov("hr_leida", ("displayName", "HR leída"), ("unit", "percent"), ("decimals", 0)),
                            ov("hr_real", ("displayName", "HR real"), ("unit", "percent"), ("decimals", 0)),
                            ov("ocup_leida", ("displayName", "Presencia leída"), ("mappings", MAP_OCUP)),
                            ov("ocup_real", ("displayName", "Presencia real"), ("mappings", MAP_OCUP)),
                            ov("restante", ("displayName", "Vence en"), ("unit", "m"), ("decimals", 0),
                               ("mappings", [{"type": "value", "options": {"-1": {"text": "Sin vencimiento", "index": 0}}}])),
                        ]},
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False, "reducer": ["sum"], "fields": ""}},
        "transformations": [{"id": "organize", "options": {"indexByName": {
            "zona": 0, "nombre": 1, "ajuste": 2, "t_leida": 3, "t_real": 4, "dt": 5, "hr_leida": 6, "hr_real": 7,
            "ocup_leida": 8, "ocup_real": 9, "restante": 10}}}],
    }
    P.append(place(sens, D, 0, y + 1, 14, 9))
    err_q = '''import "join"

base = from(bucket: "ems")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "zona" and r.escenario == "live" and r.zona =~ /^(${zona:pipe})$/ and (r._field == "temp_c" or r._field == "temp_real_c"))
  |> aggregateWindow(every: ''' + WIN5 + ''', fn: mean, createEmpty: false)
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> filter(fn: (r) => exists r.temp_real_c)
  |> map(fn: (r) => ({_time: r._time, etiqueta: r.zona + " · " + r.nombre, _value: r.temp_c - r.temp_real_c}))
  |> group(columns: ["etiqueta"])

forzadas = base
  |> map(fn: (r) => ({r with _value: if r._value < 0.0 then -r._value else r._value}))
  |> max()
  |> filter(fn: (r) => r._value > 0.3)
  |> keep(columns: ["etiqueta"])

join.inner(left: base, right: forzadas, on: (l, r) => l.etiqueta == r.etiqueta, as: (l, r) => l)'''
    err = ts("Error de lectura de los sensores", "Diferencia entre la temperatura que lee el sensor y la real, sólo en las zonas donde supera 0.3 °C en el rango (el ruido normal es ±0.1 °C).",
             [err_q], "celsius", 1, legend=("lastNotNull", "max"), legend_place="bottom",
             overrides=[], noValue="Sin forzados en el rango", custom={"lineInterpolation": "stepAfter"},
             thresholds=[("transparent", None)])
    err["fieldConfig"]["defaults"]["custom"]["thresholdsStyle"] = {"mode": "off"}
    P.append(place(err, D, 14, y + 1, 10, 9))

    # ---- Zona crítica y entorno
    y = 61
    P.append(place(row("Zona crítica y entorno", y), D, 0, y, 24, 1))
    z = from_orig(o, 13, title="Z06 · Cuarto de servidores (zona crítica)",
                  desc="Temperatura y consigna fija del cuarto de servidores (VRF-SRV) y su potencia de TI + climatización (eje derecho). Rojo ≥ 27 °C = alarma SERVIDOR_TEMP.")
    z["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", 27)])
    z["fieldConfig"]["defaults"]["custom"]["thresholdsStyle"] = {"mode": "dashed"}
    for x in z["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "temp_c":
            props.update({"displayName": "Temperatura", "color": fixed(C["t_ext"])})
        elif nm == "setpoint_c":
            props.update({"displayName": "Consigna", "color": fixed(C["neutro"])})
        else:
            props.update({"displayName": "Potencia", "color": fixed(C["critica"])})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(z, legend=("lastNotNull", "max", "mean")), D, 0, y + 1, 12, 9))
    bz = from_orig(o, 14, desc="Potencia actual (climatización + luces + equipos) de cada zona seleccionada, de mayor a menor.")
    bz["fieldConfig"]["defaults"]["color"] = fixed(C["consumo"])
    bz["options"]["displayMode"] = "basic"
    bz["options"]["valueMode"] = "color"
    P.append(place(bz, D, 12, y + 1, 6, 9))
    ce = from_orig(o, 15, title="Clima exterior", desc="Temperatura y humedad relativa exteriores del medidor general: referencia de la carga térmica y latente.")
    for x in ce["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "t_ext_c":
            props.update({"displayName": "Temperatura exterior", "color": fixed(C["t_ext"])})
        else:
            props.update({"displayName": "HR exterior", "color": fixed(C["hr"]), "decimals": 0})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(ce, legend=("lastNotNull", "max")), D, 18, y + 1, 6, 9))

    d["panels"] = P
    d["annotations"] = {"list": [BUILTIN_ANNOT, ANNOT]}
    return d


def restat(p, color=None):
    """Aplica el estilo común de KPI a un stat existente."""
    o = p["options"]
    o.update({"colorMode": "value", "justifyMode": "center", "wideLayout": True,
              "text": {"titleSize": 13, "valueSize": 30}})
    if color:
        p["fieldConfig"]["defaults"]["color"] = fixed(color)
    return p


# ================================================================= 4. Alarmas
def build_alarmas():
    o = orig("ems-alarmas.json")
    D = "al"
    d = dash_base(o, "30s", time={"from": "now-24h", "to": "now"})
    d["description"] = "Registro y análisis de alarmas y eventos del EMS y del gemelo, y estado del control (modo, DR, red, límite, latencia)."
    P = []
    P.append(place(row("Resumen", 0), D, 0, 0, 24, 1))
    P.append(place(stat("Activas ahora", "Alarmas activas según el último estado del EMS.", [q_last("ems", "n_alarmas")],
                        decimals=0, thresholds=THR_ALARM, mappings=MAP_SIN_ALARMAS), D, 0, 1, 4, 4))
    specs = [(1, "Alarmas en el rango", "Total de alarmas registradas en el rango de tiempo.", C["consumo"]),
             (2, "Críticas", "Alarmas de nivel crítico en el rango.", C["alarma"]),
             (3, "Avisos", "Alarmas de nivel aviso en el rango.", C["aviso"]),
             (4, "Informativas", "Alarmas informativas en el rango.", C["info"])]
    for i, (pid, t, ds, col) in enumerate(specs):
        q = from_orig(o, pid)["targets"][0]["query"]
        P.append(place(stat(t, ds, [q], decimals=0, color=col, noValue="Sin alarmas",
                            mappings=[{"type": "value", "options": {"0": {"text": "Sin alarmas", "index": 0}}}]),
                       D, 4 + i * 4, 1, 4, 4))
    P.append(place(stat("Latencia de control", "Tiempo entre la orden del EMS y la confirmación del gemelo; sparkline de 6 h. Naranja ≥ 500 ms, rojo ≥ 2 s.",
                        [q_spark("ems", "latencia_ms")], unit="ms", decimals=0, spark=True,
                        thresholds=[("green", None), ("orange", 500), ("red", 2000)]), D, 20, 1, 4, 4))

    y = 5
    P.append(place(row("Registro de alarmas", y), D, 0, y, 24, 1))
    tb = from_orig(o, 9, title="Alarmas y eventos", desc="Alarmas del EMS (Node-RED o supervisor del gemelo) en el rango, de la más reciente a la más antigua. Los eventos simulados (incendio, corte, falla VRF…) aparecen por las alarmas que provocan. Filtra por columna.")
    style_alarm_table(tb)
    tb["fieldConfig"]["defaults"]["noValue"] = "Sin alarmas en el rango"
    P.append(place(tb, D, 0, y + 1, 16, 14))
    bc = from_orig(o, 10, desc="Número de alarmas de cada tipo en el rango.")
    bc["fieldConfig"]["defaults"]["color"] = fixed(C["aviso"])
    bc["fieldConfig"]["defaults"]["noValue"] = "Sin alarmas"
    bc["options"]["orientation"] = "horizontal"
    bc["options"]["showValue"] = "always"
    bc["options"]["barWidth"] = 0.6
    bc["fieldConfig"]["defaults"].setdefault("custom", {})["fillOpacity"] = 70
    bc["options"]["tooltip"] = {"mode": "single", "sort": "none"}
    for x in bc["fieldConfig"]["overrides"]:
        if x["matcher"]["options"] == "_value":
            x["properties"] = [pp for pp in x["properties"] if pp["id"] != "color"] + [{"id": "displayName", "value": "Alarmas"}]
    P.append(place(bc, D, 16, y + 1, 8, 14))

    y = 20
    P.append(place(row("Tendencia", y), D, 0, y, 24, 1))
    at = from_orig(o, 12, desc="Alarmas por hora y código (barras apiladas).")
    at["fieldConfig"]["defaults"]["noValue"] = "Sin alarmas en el rango"
    at["fieldConfig"]["defaults"].setdefault("custom", {})
    at["fieldConfig"]["overrides"] = [ov("/.*/", ("displayName", "${__field.labels.codigo}"), by="byRegexp")]
    at["options"]["legend"] = {"displayMode": "table", "placement": "right", "showLegend": True, "calcs": ["sum", "max"]}
    at["options"]["tooltip"] = {"mode": "multi", "sort": "desc"}
    P.append(place(at, D, 0, y + 1, 16, 8))
    pn = from_orig(o, 11, title="Reparto por nivel", desc="Reparto de las alarmas del rango por nivel.")
    pn["options"]["pieType"] = "donut"
    pn["options"]["legend"] = {"showLegend": True, "displayMode": "table", "placement": "right", "values": ["value", "percent"]}
    pn["options"]["displayLabels"] = []
    pn["fieldConfig"]["defaults"]["noValue"] = "Sin alarmas"
    pn["fieldConfig"]["overrides"] = [series("crit", "Crítica", C["alarma"]), series("warn", "Aviso", C["aviso"]),
                                      series("info", "Info", C["info"])]
    P.append(place(pn, D, 16, y + 1, 8, 8))

    y = 29
    P.append(place(row("Estado del EMS", y), D, 0, y, 24, 1))
    st = from_orig(o, 14, title="Estrategia, respuesta a la demanda y red",
                   desc="Línea de tiempo de la estrategia de control del EMS, de la respuesta a la demanda y del estado de la red eléctrica (un corte deja las cargas críticas en el UPS).")
    st["fieldConfig"]["defaults"]["noValue"] = "Sin datos en el rango"
    st["fieldConfig"]["defaults"].setdefault("mappings", []).append(MAP_MODO[0])
    for m in st["fieldConfig"]["defaults"].get("mappings", []):
        for k, v in m.get("options", {}).items():
            if k == "10":
                v.update({"text": "DR en espera", "color": C["ok"]})
            elif k == "11":
                v.update({"text": "DR activa", "color": C["aviso"]})
            elif k == "21":
                v.update({"text": "Red normal", "color": C["ok"]})
            elif k == "20":
                v.update({"text": "Corte · UPS", "color": C["alarma"]})
    P.append(place(st, D, 0, y + 1, 24, 6))
    lim = from_orig(o, 15, title="Límite del EMS frente a la demanda",
                    desc="Límite dinámico del EMS (escalonado) frente a la demanda de 15 min. Línea roja: potencia máxima de 170 kW.")
    lim["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    lim["fieldConfig"]["defaults"]["custom"]["fillOpacity"] = 8
    lim["fieldConfig"]["overrides"] = [
        series("demanda_15min_kw", "Demanda 15 min", C["red"]),
        series("limite_kw", "Límite EMS", C["limite_ems"], [DASH_LINE, ("custom.fillOpacity", 0),
                                                            ("custom.lineInterpolation", "stepAfter"), ("custom.lineWidth", 1)]),
    ]
    P.append(place(tune_ts(lim, legend=("lastNotNull", "max")), D, 0, y + 7, 12, 8))
    la = from_orig(o, 16, desc="Latencia orden → confirmación (ms) informada por el EMS. Naranja ≥ 500 ms, rojo ≥ 2 s.")
    la["fieldConfig"]["overrides"] = [series("latencia_ms", "Latencia", C["consumo"])]
    P.append(place(tune_ts(la, legend=("lastNotNull", "max", "mean")), D, 12, y + 7, 6, 8))
    up = from_orig(o, 17, desc="Alarmas activas y, durante un corte de red, potencia que entrega el UPS y su autonomía restante. Sin cortes en el rango no hay serie de UPS.")
    for x in up["fieldConfig"]["overrides"]:
        nm = x["matcher"]["options"]
        props = {p["id"]: p["value"] for p in x["properties"]}
        if nm == "n_alarmas":
            props.update({"displayName": "Alarmas activas", "color": fixed(C["alarma"])})
        elif nm == "ups_kw":
            props.update({"displayName": "Potencia del UPS", "color": fixed(C["critica"])})
        else:
            props.update({"displayName": "Autonomía del UPS", "color": fixed(C["neutro"])})
        x["properties"] = [{"id": k, "value": v} for k, v in props.items()]
    P.append(place(tune_ts(up, legend=("lastNotNull", "max")), D, 18, y + 7, 6, 8))

    d["panels"] = P
    d["annotations"] = {"list": [BUILTIN_ANNOT, ANNOT]}
    return d


# ================================================================= 5. Resultados
SCEN = {"baseline": "#8E949E", "reglas": "#5794F2", "reglas_dr": "#A352CC", "mpc": "#73BF69",
        "baseline_fv": "#C3C7CD", "reglas_fv": "#8AB8FF", "reglas_dr_fv": "#CA95E5", "mpc_fv": "#A8DDA0"}
SCEN_NAME = {"baseline": "Sin EMS", "reglas": "Reglas", "reglas_dr": "Reglas + DR", "mpc": "MPC",
             "baseline_fv": "Sin EMS + FV", "reglas_fv": "Reglas + FV", "reglas_dr_fv": "Reglas + DR + FV", "mpc_fv": "MPC + FV"}


def scen_overrides(dashed=True):
    return [series(k, SCEN_NAME[k], v, [DASH_LINE] if (dashed and k.endswith("_fv")) else []) for k, v in SCEN.items()]


def build_resultados():
    o = orig("ems-resultados.json")
    D = "re"
    d = dash_base(o, "", time=o["time"], graph_tooltip=2)
    d["refresh"] = ""
    d["description"] = "Comparación de las estrategias offline (sin EMS, reglas, reglas + DR, MPC; con y sin FV) en 4 semanas tipo de 2026."
    P = []
    P.append(place(row("Resumen", 0), D, 0, 0, 24, 1))
    tx = from_orig(o, 1, title="Cómo leer este tablero", desc="Contexto de los escenarios offline.")
    tx["options"]["content"] = (
        "**Escenarios offline** · 28 días en 4 semanas tipo de 2026 (9 feb, 11 may, 10 ago y 2 nov). "
        "**Sin EMS** = baseline · **Reglas** = reglas del EMS · **Reglas + DR** = con respuesta a la demanda · "
        "**MPC** = control predictivo. Las variantes **+ FV** añaden ≈ 55 kWp de paneles. "
        "Los paneles de las filas *Resumen*, *Energía y costo* y *Comparativa* cubren los 28 días; "
        "la fila *Semana elegida* sigue el rango de tiempo: cámbialo con los enlaces **Semana …** de la cabecera. "
        "Límite de demanda: **170 kW**.")
    P.append(place(tx, D, 0, 1, 24, 4))
    for i, pid in enumerate((2, 3, 4)):
        p = from_orig(o, pid)
        p["options"]["displayMode"] = "basic"
        p["options"]["valueMode"] = "color"
        p["options"]["namePlacement"] = "left"
        p["options"]["showUnfilled"] = True
        p["fieldConfig"]["overrides"] = [ov(k, ("displayName", SCEN_NAME[k])) for k in SCEN]
        if pid == 2:
            p["description"] = "Reducción de la energía tomada de la red frente al edificio sin EMS ni FV. Sin EMS no tiene valor: es la referencia."
            p["fieldConfig"]["defaults"]["noValue"] = "—"
        if pid == 3:
            p["description"] = "Demanda máxima de 15 min en los 28 días frente a la potencia máxima de 170 kW (amarillo ≥ 80 %, naranja ≥ 90 %, rojo ≥ 100 %)."
            p["fieldConfig"]["defaults"]["max"] = 200
            p["fieldConfig"]["defaults"]["min"] = 0
        if pid == 4:
            p["description"] = "Porcentaje de horas ocupadas dentro de la banda de confort 21–26 °C."
        P.append(place(p, D, i * 8, 5, 8, 9))

    y = 14
    P.append(place(row("Energía y costo (28 días)", y), D, 0, y, 24, 1))
    layout = [(5, 0, y + 1, 9), (6, 8, y + 1, 9), (7, 16, y + 1, 9), (8, 0, y + 10, 9), (9, 8, y + 10, 9), (10, 16, y + 10, 9)]
    for pid, x, yy, h in layout:
        p = from_orig(o, pid)
        p["title"] = p["title"].replace(" (28 días)", "")
        if pid != 10:
            p["fieldConfig"]["overrides"] = [series("Sin FV", "Sin FV", C["red"]), series("Con FV", "Con FV", C["fv"])]
        else:
            p["fieldConfig"]["overrides"] = [series("e_hvac_kwh", "Climatización", C["hvac"]),
                                             series("e_luces_kwh", "Iluminación", C["luces"]),
                                             series("e_equipos_kwh", "Equipos", C["equipos"])]
        if pid == 7:
            p["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
            p["fieldConfig"]["defaults"].setdefault("custom", {})["thresholdsStyle"] = {"mode": "dashed"}
        p["options"]["showValue"] = "auto"
        p["options"]["tooltip"] = {"mode": "multi", "sort": "none"}
        p["options"]["legend"] = {"showLegend": True, "displayMode": "list", "placement": "bottom", "calcs": []}
        P.append(place(p, D, x, yy, 8, h))

    y = 33
    P.append(place(row("Comparativa de KPI (28 días)", y), D, 0, y, 24, 1))
    tb = from_orig(o, 11)
    for x in tb["fieldConfig"]["overrides"]:
        if x["matcher"]["options"] == "escenario":
            for pr in x["properties"]:
                if pr["id"] == "mappings":
                    pr["value"] = [{"type": "value", "options": {k: {"text": SCEN_NAME[k], "index": i}
                                                                  for i, k in enumerate(SCEN)}}]
            if not any(pr["id"] == "mappings" for pr in x["properties"]):
                x["properties"].append({"id": "mappings", "value": [{"type": "value", "options": {
                    k: {"text": SCEN_NAME[k], "index": i} for i, k in enumerate(SCEN)}}]})
            x["properties"] = [pr for pr in x["properties"] if pr["id"] != "custom.width"] + [{"id": "custom.width", "value": 150}]
    tb["options"]["cellHeight"] = "sm"
    P.append(place(tb, D, 0, y + 1, 24, 10))

    y = 44
    P.append(place(row("Semana elegida (rango de tiempo)", y), D, 0, y, 24, 1))
    p13 = from_orig(o, 13, desc="Potencia tomada de la red (media de 15 min): consumo en los escenarios sin FV e importación neta en las variantes + FV (línea discontinua). Línea roja: 170 kW.")
    p13["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    p13["fieldConfig"]["overrides"] = scen_overrides()
    P.append(place(tune_ts(p13, legend=("max", "mean"), place_="right"), D, 0, y + 1, 24, 9))
    p14 = from_orig(o, 14, desc="Demanda de 15 min en la acometida (máximo por intervalo). Línea roja: 170 kW.")
    p14["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    p14["fieldConfig"]["overrides"] = scen_overrides()
    P.append(place(tune_ts(p14, legend=("max", "mean"), place_="right"), D, 0, y + 10, 12, 9))
    p15 = from_orig(o, 15, desc="Temperatura máxima entre las 25 zonas no críticas (cada 30 min); línea naranja: límite de confort 26 °C. Sólo escenarios sin FV (el confort es el mismo con FV).")
    p15["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("orange", 26), ("red", 27)])
    p15["fieldConfig"]["defaults"].setdefault("custom", {})["thresholdsStyle"] = {"mode": "dashed"}
    p15["fieldConfig"]["overrides"] = scen_overrides()
    P.append(place(tune_ts(p15, legend=("max", "mean"), place_="right"), D, 12, y + 10, 12, 9))
    p16 = from_orig(o, 16, desc="Alarmas generadas por el supervisor en cada escenario en los 28 días (no depende del rango). Las variantes + FV no exportan alarmas.")
    p16["options"]["stacking"] = "normal"
    p16["fieldConfig"]["overrides"] = [series("PICO_DEMANDA", "Pico de demanda", C["red"]),
                                       series("TEMP_ALTA", "Temperatura alta", C["aviso"]),
                                       series("TEMP_BAJA", "Temperatura baja", C["info"])]
    p16["fieldConfig"]["defaults"].pop("mappings", None)
    nombre_fn = "nombre = (e) => " + " else ".join(f'if e == "{k}" then "{v}"' for k, v in SCEN_NAME.items()) + " else e\n\n"
    q16 = p16["targets"][0]["query"]
    assert 'rename(columns: {escenario: "estrategia"})' in q16
    p16["targets"][0]["query"] = nombre_fn + q16 + "\n  |> map(fn: (r) => ({r with estrategia: nombre(e: r.estrategia)}))"
    p16["options"]["legend"] = {"showLegend": True, "displayMode": "list", "placement": "bottom", "calcs": []}
    P.append(place(p16, D, 0, y + 19, 12, 8))
    p17 = from_orig(o, 17, desc="Generación fotovoltaica de la semana (idéntica en todas las variantes + FV; media de 15 min).")
    p17["fieldConfig"]["defaults"]["color"] = fixed(C["fv"])
    p17["fieldConfig"]["defaults"]["displayName"] = "Generación FV"
    p17["fieldConfig"]["defaults"]["noValue"] = "Elige algún escenario con FV"
    P.append(place(tune_ts(p17, legend=("max", "mean")), D, 12, y + 19, 12, 8))
    p18 = from_orig(o, 18, title="Pronóstico de demanda frente a la real",
                    desc="Validación del modelo de regresión del día siguiente frente a la potencia simulada (escenario Reglas + DR). Exportado para la semana del 3 al 10 nov 2026. Línea roja: 170 kW.")
    p18["fieldConfig"]["defaults"]["thresholds"] = thr([("transparent", None), ("red", LIMITE)])
    p18["fieldConfig"]["overrides"] = [series("p_kw_pred", "Pronóstico", C["aviso"], [DASH_LINE]),
                                       series("p_kw_real", "Real", C["consumo"])]
    P.append(place(tune_ts(p18, legend=("mean", "max")), D, 0, y + 27, 24, 8))

    d["panels"] = P
    return d


def main():
    builds = {
        "ems-edificio-3d.json": build_3d,
        "ems-tiempo-real.json": build_tiempo_real,
        "ems-zonas.json": build_zonas,
        "ems-alarmas.json": build_alarmas,
        "ems-resultados.json": build_resultados,
    }
    for name, fn in builds.items():
        d = fn()
        with open(f"{OUT}/{name}", "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print("escrito", name, len(d["panels"]), "paneles")


if __name__ == "__main__":
    main()
