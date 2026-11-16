"""Importa el modelo OpenStudio/EnergyPlus del edificio de 5 plantas a `data/` y extrae sus parámetros.

    python tools/importar_energyplus.py \
        --proyecto <carpeta Edificio_Sin_EMS>  [--proyecto-fv <carpeta Edificio_Sin_EMS_ConPaneles>]

Cada carpeta de proyecto es la que exporta OpenStudio (Edificio_Sin_EMS.osm + floorplan.json + una
subcarpeta con run/in.idf y run/eplusout.sql). Se usa la corrida más reciente que haya dentro.

Genera (calendario de la simulación de EnergyPlus; cada registro con el INICIO del intervalo):
- data/energyplus/electricidad_10min.csv   ts, p_total_kw     (Electricity:Facility, paso de zona)
- data/energyplus/zonas_horario.csv        ts, zona, temp_c, hr_pct, p_equipos_kw
- data/energyplus/fv_horario.csv           ts, p_fv_dc_kw     (sólo con --proyecto-fv)
- data/energyplus/resumen_anual.json       usos finales, pico, FV, horas fuera de setpoint, áreas
- data/energyplus/modelo_parametros.json   zonas, envolvente, terminales, VRF, PTAC, FV, horarios
- data/energyplus/modelo/                  in.idf (sin y con FV) y floorplan.json para trazabilidad
- data/clima/<epw>                          archivo climático

`modelo_parametros.json` es la fuente de config/edificio.yaml (zonas, sistemas_vrf, fv): se copia a mano
con sus comentarios para que la configuración siga siendo legible.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sqlite3
from pathlib import Path

import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent

# Desplazamiento de floorplan.json para dejar el origen en la esquina suroeste del edificio de 20 × 20 m
DX, DY = 26.0, -9.0

# Zonas térmicas de EnergyPlus → zonas del EMS (las 26 acondicionadas; los 5 elevadores no se controlan)
PLANTAS = ["PB", "P1", "P2", "P3", "P4"]
MAPA_ZONAS: dict[str, tuple[str, str, str, int]] = {
    # nombre E+ (mayúsculas): (id, nombre, tipo, planta)
    "ZT_RECEPCION PB": ("Z01", "Recepción", "recepcion", 0),
    "ZT_CUBICULOS PB": ("Z02", "Cubículos", "cubiculos", 0),
    "ZT_CONFERENCIAS PB": ("Z03", "Sala de conferencias", "conferencia", 0),
    "ZT_PASILLO PB": ("Z04", "Pasillo PB", "pasillo", 0),
    "ZT_BANO_PB": ("Z05", "Baños PB", "bano", 0),
    "ZT_SERVIDORES PB": ("Z06", "Cuarto de servidores", "servidores", 0),
}
for _i, _p in enumerate(PLANTAS[1:], start=1):
    _base = 7 + (_i - 1) * 5
    _pp = f"P{_i}"
    MAPA_ZONAS[f"ZT_OFICINA1_{_pp}"] = (f"Z{_base:02d}", f"Oficina 1 {_pp}", "oficina", _i)
    MAPA_ZONAS[f"ZT_OFICINA2_{_pp}"] = (f"Z{_base + 1:02d}", f"Oficina 2 {_pp}", "oficina", _i)
    MAPA_ZONAS[f"ZT_OFICINAGRANDE_{_pp}"] = (f"Z{_base + 2:02d}", f"Oficina abierta {_pp}", "oficina_abierta", _i)
    MAPA_ZONAS[f"ZT_PASILLO {_pp}"] = (f"Z{_base + 3:02d}", f"Pasillo {_pp}", "pasillo", _i)
    MAPA_ZONAS[f"ZT_BANO_{_pp}"] = (f"Z{_base + 4:02d}", f"Baños {_pp}", "bano", _i)

# Espacio de floorplan.json → zona E+ (para la huella en planta)
ESPACIO_A_ZONA = {
    "Recepcion": "ZT_RECEPCION PB", "Cubiculos": "ZT_CUBICULOS PB", "Conferencia": "ZT_CONFERENCIAS PB",
    "Pasillo PB": "ZT_PASILLO PB", "Bano Pb": "ZT_BANO_PB", "Servidores": "ZT_SERVIDORES PB",
}
for _i in range(1, 5):
    for _sep in ("-", " "):
        ESPACIO_A_ZONA[f"Oficina 1-P{_i}"] = f"ZT_OFICINA1_P{_i}"
        ESPACIO_A_ZONA[f"Oficina 2-P{_i}"] = f"ZT_OFICINA2_P{_i}"
        ESPACIO_A_ZONA[f"Office Grande P{_i}"] = f"ZT_OFICINAGRANDE_P{_i}"
        ESPACIO_A_ZONA[f"Pasillo{_sep}P{_i}"] = f"ZT_PASILLO P{_i}"
        ESPACIO_A_ZONA[f"Bano P{_i}"] = f"ZT_BANO_P{_i}"
# Sistemas VRF del modelo → id del EMS
MAPA_VRF = {"VRF PB": "VRF-PB", "VRF P1": "VRF-P1", "VRF P2": "VRF-P2", "VRF P3": "VRF-P3", "VRF P4": "VRF-P4",
            "VRF_SERVIDORES": "VRF-SRV"}


# ------------------------------------------------------------------------------------------- IDF
def leer_idf(ruta: Path) -> list[list[str]]:
    texto = re.sub(r"!.*", "", ruta.read_text(encoding="latin-1"))
    return [[c.strip() for c in o.split(",")] for o in texto.split(";") if o.strip()]


def _num(v) -> float:
    try:
        return float(str(v).strip())
    except ValueError:
        return float("nan")


def _vertices(campos: list[str]) -> list[tuple[float, float, float]]:
    """Últimos 3·n campos numéricos de una superficie."""
    nums = []
    for c in reversed(campos):
        try:
            nums.append(float(c))
        except ValueError:
            break
    nums.reverse()
    nums = nums[len(nums) % 3:]
    return [tuple(nums[i:i + 3]) for i in range(0, len(nums), 3)]


def _area_normal(p):
    cx = cy = cz = 0.0
    for i in range(1, len(p) - 1):
        a = [p[i][k] - p[0][k] for k in range(3)]
        b = [p[i + 1][k] - p[0][k] for k in range(3)]
        cx += a[1] * b[2] - a[2] * b[1]
        cy += a[2] * b[0] - a[0] * b[2]
        cz += a[0] * b[1] - a[1] * b[0]
    n = math.sqrt(cx * cx + cy * cy + cz * cz)
    return n / 2, (cx / n, cy / n, cz / n) if n else (0, 0, 0)


def _orientacion(normal, norte_deg: float = 0.0) -> str:
    az = (math.degrees(math.atan2(normal[0], normal[1])) + norte_deg) % 360
    return ["N", "E", "S", "W"][int(((az + 45) % 360) // 90)]


def envolvente(objs) -> dict[str, dict]:
    """Muros, ventanas, techo y suelo exteriores por zona E+ (m², por orientación)."""
    norte = next((_num(o[2]) for o in objs if o[0] == "Building"), 0.0)
    norte = 0.0 if math.isnan(norte) else norte
    sup_zona, sup_ori = {}, {}
    out: dict[str, dict] = {}
    for o in objs:
        if o[0] != "BuildingSurface:Detailed":
            continue
        nombre, tipo, zona, obc = o[1], o[2].lower(), o[4].upper(), o[6].lower()
        area, n = _area_normal(_vertices(o))
        d = out.setdefault(zona, {"muros": {}, "ventanas": {}, "techo": 0.0, "suelo": 0.0, "interior_techo": 0.0,
                                  "interior_piso": 0.0})
        sup_zona[nombre.upper()] = zona
        if tipo == "wall" and obc == "outdoors":
            ori = _orientacion(n, norte)
            sup_ori[nombre.upper()] = ori
            d["muros"][ori] = d["muros"].get(ori, 0.0) + area
        elif tipo in ("roof", "ceiling") and obc == "outdoors":
            d["techo"] += area
        elif tipo == "floor" and obc in ("ground", "foundation", "groundfcfactormethod", "groundslabpreprocessoraverage"):
            d["suelo"] += area
        elif tipo in ("roof", "ceiling") and obc == "surface":
            d["interior_techo"] += area
        elif tipo == "floor" and obc == "surface":
            d["interior_piso"] += area
    for o in objs:
        if o[0] != "FenestrationSurface:Detailed":
            continue
        base = o[4].upper()
        if base in sup_ori:
            area, _ = _area_normal(_vertices(o))
            d = out[sup_zona[base]]
            d["ventanas"][sup_ori[base]] = d["ventanas"].get(sup_ori[base], 0.0) + area
    return out


def equipos(objs) -> dict:
    """Terminales VRF/PTAC por zona, sistemas VRF con sus terminales y campos FV."""
    por_nombre = {o[1].upper(): o for o in objs if len(o) > 1}
    lista_zona = {}
    for o in objs:
        if o[0] == "ZoneHVAC:EquipmentConnections":
            lista_zona[o[2].upper()] = o[1].upper()      # lista de equipos → zona
    term_zona, ptac_zona, extractor_zona = {}, {}, {}
    for o in objs:
        if o[0] != "ZoneHVAC:EquipmentList":
            continue
        zona = lista_zona.get(o[1].upper())
        for i, c in enumerate(o):
            if c == "ZoneHVAC:TerminalUnit:VariableRefrigerantFlow":
                term_zona[o[i + 1].upper()] = zona
            elif c == "ZoneHVAC:PackagedTerminalAirConditioner":
                ptac_zona[o[i + 1].upper()] = zona
            elif c == "Fan:ZoneExhaust":
                extractor_zona[o[i + 1].upper()] = zona
    sistemas = {}
    for o in objs:
        if o[0] == "AirConditioner:VariableRefrigerantFlow":
            lista = next(c for c in o if c.upper().endswith("TERMINAL LIST"))
            terms = [t.upper() for t in por_nombre[lista.upper()][2:] if t]
            sistemas[o[1].upper()] = {"terminales": terms, "cop_nominal": _num(o[4]) if not math.isnan(_num(o[4])) else None}
    # componentes de cada terminal (ventilador y serpentín)
    comp = {}
    for nombre in list(term_zona) + list(ptac_zona):
        o = por_nombre[nombre]
        comp[nombre] = {
            "fan": next((o[i + 1].upper() for i, c in enumerate(o) if c.startswith("Fan:")), None),
            "coil": next((o[i + 1].upper() for i, c in enumerate(o) if c.startswith("Coil:Cooling")), None),
        }
    fv = []
    for o in objs:
        if o[0] == "Generator:Photovoltaic":
            perf = por_nombre[o[4].upper()]
            sup = por_nombre[o[2].upper()]
            area, _ = _area_normal(_vertices(sup))
            fv.append({"nombre": o[1], "superficie": o[2], "area_m2": round(area, 2), "fraccion_activa": _num(perf[2]),
                       "eficiencia": _num(perf[4]), "altura_m": round(_vertices(sup)[0][2], 2)})
    inversor = next((_num(o[5]) for o in objs if o[0] == "ElectricLoadCenter:Inverter:Simple"), None)
    return {"term_zona": term_zona, "ptac_zona": ptac_zona, "extractor_zona": extractor_zona, "sistemas": sistemas,
            "comp": comp, "fv": fv, "inversor_eficiencia": inversor}


def horarios(objs, nombres: list[str]) -> dict:
    """Schedule:Compact / Schedule:Day:Interval → {nombre: texto} para documentar."""
    out = {}
    for o in objs:
        if o[0] in ("Schedule:Compact", "Schedule:Day:Interval", "Schedule:Week:Daily", "Schedule:Year",
                    "Schedule:Ruleset") and any(o[1].upper().startswith(n.upper()) for n in nombres):
            out[o[1]] = o[2:]
    return out


# ------------------------------------------------------------------------------------------- floorplan
def huellas(floorplan: dict) -> dict[str, list]:
    """Rectángulos de cada zona E+ en planta (m, origen SO). Los polígonos del modelo son rectilíneos."""
    out = {}
    for s in floorplan["stories"]:
        g = s["geometry"]
        V = {v["id"]: (v["x"] + DX, v["y"] + DY) for v in g["vertices"]}
        E = {e["id"]: e["vertex_ids"] for e in g["edges"]}
        for sp in s["spaces"]:
            zona = ESPACIO_A_ZONA.get(sp["name"])
            if not zona:
                continue
            cara = next(f for f in g["faces"] if f["id"] == sp["face_id"])
            pts = []
            for eid, d in zip(cara["edge_ids"], cara["edge_order"]):
                a, b = E[eid]
                pts.append(V[a] if d == 1 else V[b])
            out[zona] = _rectangulos(pts)
    return out


def _rectangulos(pts) -> list[list[float]]:
    """Descompone un polígono rectilíneo en rectángulos [x, y, w, d] (barrido por franjas en y)."""
    xs = sorted({round(p[0], 3) for p in pts})
    ys = sorted({round(p[1], 3) for p in pts})

    def dentro(x, y):
        c = False
        n = len(pts)
        for i in range(n):
            (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % n]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    celdas = {(i, j) for i in range(len(xs) - 1) for j in range(len(ys) - 1)
              if dentro((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)}
    rects = []
    while celdas:
        i, j = min(celdas, key=lambda c: (c[1], c[0]))
        i2 = i
        while (i2 + 1, j) in celdas:
            i2 += 1
        j2 = j
        while all((k, j2 + 1) in celdas for k in range(i, i2 + 1)):
            j2 += 1
        for k in range(i, i2 + 1):
            for m in range(j, j2 + 1):
                celdas.discard((k, m))
        rects.append([xs[i], ys[j], round(xs[i2 + 1] - xs[i], 3), round(ys[j2 + 1] - ys[j], 3)])
    rects.sort(key=lambda r: -r[2] * r[3])
    return rects


# ------------------------------------------------------------------------------------------- SQL
def _serie(db: sqlite3.Connection, nombre: str, frecuencia: str) -> pd.DataFrame:
    q = """
        SELECT t.Year, t.Month, t.Day, t.Hour, t.Minute, t.Interval, d.KeyValue, r.Value
        FROM ReportData r
        JOIN ReportDataDictionary d ON r.ReportDataDictionaryIndex = d.ReportDataDictionaryIndex
        JOIN Time t ON r.TimeIndex = t.TimeIndex
        JOIN EnvironmentPeriods e ON t.EnvironmentPeriodIndex = e.EnvironmentPeriodIndex
        WHERE d.Name = ? AND d.ReportingFrequency = ? AND e.EnvironmentType = 3
    """
    df = pd.DataFrame(db.execute(q, (nombre, frecuencia)).fetchall(),
                      columns=["year", "month", "day", "hour", "minute", "interval", "clave", "valor"])
    año = int(df["year"].replace(0, pd.NA).dropna().mode().iloc[0]) if (df["year"] > 0).any() else 2006
    fin = pd.to_datetime(dict(year=año, month=df.month, day=df.day)) + pd.to_timedelta(df.hour * 60 + df.minute, unit="min")
    df["ts"] = fin - pd.to_timedelta(df["interval"], unit="min")
    return df


def _tabla(db, reporte, tabla) -> pd.DataFrame:
    q = """SELECT RowName, ColumnName, Value, Units FROM TabularDataWithStrings WHERE ReportName = ? AND TableName = ?"""
    return pd.DataFrame(db.execute(q, (reporte, tabla)).fetchall(), columns=["fila", "columna", "valor", "unidad"])


def _valor(db, reporte, tabla, fila, columna) -> float:
    r = db.execute("""SELECT Value FROM TabularDataWithStrings WHERE ReportName=? AND TableName=? AND upper(RowName)=?
                      AND ColumnName=?""", (reporte, tabla, fila.upper(), columna)).fetchone()
    return _num(r[0]) if r else float("nan")


def tamaños(db) -> dict:
    """Capacidad dimensionada de serpentines y sistemas, potencia de ventiladores (W)."""
    cap = {n.upper(): v for n, v in db.execute(
        """SELECT CompName, Value FROM ComponentSizes WHERE Description LIKE 'Design Size%Total Cooling Capacity%'""")}
    fans = {}
    for (fila,) in db.execute("""SELECT DISTINCT RowName FROM TabularDataWithStrings
                                 WHERE ReportName='EquipmentSummary' AND TableName='Fans'"""):
        fans[fila.upper()] = _valor(db, "EquipmentSummary", "Fans", fila, "Rated Electricity Rate")
    return {"cap": cap, "fan_w": fans}


# ------------------------------------------------------------------------------------------- principal
def _corrida(proyecto: Path) -> tuple[Path, Path]:
    """(in.idf, eplusout.sql) de la corrida más reciente dentro de la carpeta del proyecto."""
    sqls = sorted(proyecto.rglob("run/eplusout.sql"), key=lambda p: p.stat().st_mtime)
    if not sqls:
        raise SystemExit(f"No hay run/eplusout.sql en {proyecto}")
    run = sqls[-1].parent
    return run / "in.idf", run / "eplusout.sql"


def parametros(idf: Path, sql: Path, floorplan: Path) -> dict:
    objs = leer_idf(idf)
    db = sqlite3.connect(sql)
    env = envolvente(objs)
    eq = equipos(objs)
    tam = tamaños(db)
    rects = huellas(json.loads(floorplan.read_text(encoding="utf-8")))
    nominal = {}
    for zona, area, luces, equip, pers in db.execute("""
            SELECT upper(z.ZoneName), z.FloorArea,
                   (SELECT sum(DesignLevel) FROM NominalLighting WHERE ZoneIndex = z.ZoneIndex),
                   (SELECT sum(DesignLevel) FROM NominalElectricEquipment WHERE ZoneIndex = z.ZoneIndex),
                   (SELECT sum(NumberOfPeople) FROM NominalPeople WHERE ZoneIndex = z.ZoneIndex)
            FROM Zones z"""):
        nominal[zona] = {"area": area, "luces_w": luces or 0.0, "equipos_w": equip or 0.0, "personas": pers or 0.0}
    sistema_de = {}
    for s, d in eq["sistemas"].items():
        for t in d["terminales"]:
            sistema_de[t] = MAPA_VRF.get(s, s)
    zonas = []
    for ep, (zid, nombre, tipo, planta) in sorted(MAPA_ZONAS.items(), key=lambda kv: kv[1][0]):
        n = nominal[ep]
        e = env.get(ep, {})
        term = next((t for t, z in eq["term_zona"].items() if z == ep), None)
        ptac = next((t for t, z in eq["ptac_zona"].items() if z == ep), None)
        unidad = term or ptac
        c = eq["comp"].get(unidad, {})
        zonas.append({
            "id": zid, "nombre": nombre, "tipo": tipo, "planta": planta, "zona_ep": ep,
            "rects": rects.get(ep, []),
            "area": round(n["area"], 1), "ocupantes": int(round(n["personas"])),
            "lpd": round(n["luces_w"] / n["area"], 2), "epd": round(n["equipos_w"] / n["area"], 2),
            "equipos_w": round(n["equipos_w"], 1),
            "terminal": unidad, "sistema": sistema_de.get(term) if term else f"PTAC-{PLANTAS[planta]}",
            "hvac_kw": round(tam["cap"].get(c.get("coil"), float("nan")) / 1000, 2),
            "fan_w": round(tam["fan_w"].get(c.get("fan"), float("nan")), 0),
            "extractor_w": round(sum(tam["fan_w"].get(f, 0.0) for f, z in eq["extractor_zona"].items() if z == ep), 0),
            "ventanas": {k: round(v, 2) for k, v in sorted(e.get("ventanas", {}).items())},
            "muros": {k: round(v, 2) for k, v in sorted(e.get("muros", {}).items())},
            "techo": round(e.get("techo", 0.0), 2), "suelo": round(e.get("suelo", 0.0), 2),
        })
    vrf = []
    for s, d in eq["sistemas"].items():
        sid = MAPA_VRF.get(s, s)
        vrf.append({"id": sid, "nombre_ep": s, "capacidad_kw": round(tam["cap"].get(s, float("nan")) / 1000, 2),
                    "zonas": [z["id"] for z in zonas if z["sistema"] == sid]})
    ptac = [{"id": z["sistema"], "zona": z["id"], "capacidad_kw": z["hvac_kw"]} for z in zonas if z["sistema"].startswith("PTAC")]
    nucleo = {}
    for s in json.loads(floorplan.read_text(encoding="utf-8"))["stories"]:
        for sp in s["spaces"]:
            if sp["name"].lower().startswith("elevador"):
                g = s["geometry"]
                V = {v["id"]: (v["x"] + DX, v["y"] + DY) for v in g["vertices"]}
                E = {e["id"]: e["vertex_ids"] for e in g["edges"]}
                cara = next(f for f in g["faces"] if f["id"] == sp["face_id"])
                pts = [V[E[eid][0] if d == 1 else E[eid][1]] for eid, d in zip(cara["edge_ids"], cara["edge_order"])]
                nucleo[s["name"]] = _rectangulos(pts)[0]
    elevador = {z: v for z, v in nominal.items() if z.startswith("ZT_ELEVADOR")}
    return {"zonas": zonas, "sistemas_vrf": vrf, "ptac": ptac, "fv": eq["fv"], "inversor_eficiencia": eq["inversor_eficiencia"],
            "nucleo_elevador": nucleo, "elevadores_w": {k: v["equipos_w"] for k, v in sorted(elevador.items())},
            "horarios": horarios(objs, ["BASE_", "TEMP_"])}


def importar(proyecto: Path, proyecto_fv: Path | None, salida: Path) -> dict:
    idf, sql = _corrida(proyecto)
    floorplan = proyecto / "floorplan.json"
    out = salida / "energyplus"
    (out / "modelo").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(sql)
    par = parametros(idf, sql, floorplan)
    ep_a_id = {ep: v[0] for ep, v in MAPA_ZONAS.items()}

    el = _serie(db, "Electricity:Facility", "Zone Timestep")
    el["p_total_kw"] = el["valor"] / 3.6e6 / (el["interval"] / 60)  # J por intervalo → kW
    el[["ts", "p_total_kw"]].sort_values("ts").to_csv(out / "electricidad_10min.csv", index=False, float_format="%.4f")

    partes = []
    for var, col, f in [("Zone Mean Air Temperature", "temp_c", 1.0), ("Zone Air Relative Humidity", "hr_pct", 1.0),
                        ("Zone Electric Equipment Electricity Energy", "p_equipos_kw", 1 / 3.6e6)]:
        d = _serie(db, var, "Hourly")
        d["zona"] = d["clave"].str.upper().map(ep_a_id)
        d = d.dropna(subset=["zona"])
        partes.append(d.set_index(["ts", "zona"])["valor"].mul(f).rename(col))
    pd.concat(partes, axis=1).reset_index().sort_values(["ts", "zona"]).to_csv(
        out / "zonas_horario.csv", index=False, float_format="%.3f")

    usos = _tabla(db, "AnnualBuildingUtilityPerformanceSummary", "End Uses")
    usos = usos[usos.columna == "Electricity"]
    pico = _tabla(db, "DemandEndUseComponentsSummary", "End Uses")
    pico = pico[pico.columna == "Electricity"]
    no_sat = _tabla(db, "SystemSummary", "Time Setpoint Not Met")
    area = _valor(db, "AnnualBuildingUtilityPerformanceSummary", "Building Area", "Total Building Area", "Area")
    resumen = {
        "fuente": f"OpenStudio/EnergyPlus — {proyecto.name} ({idf.parent.parent.name})",
        "area_m2": area,
        "energia_anual_kwh": {r.fila: round(_num(r.valor) / 0.0036, 1) for r in usos.itertuples() if _num(r.valor) > 0},
        "pico_kw": {r.fila: round(_num(r.valor) / 1000, 3) for r in pico.itertuples()
                    if r.fila != "Time of Peak" and _num(r.valor) > 0},
        "hora_pico": pico.loc[pico.fila == "Time of Peak", "valor"].iloc[0].strip(),
        "horas_no_satisfechas_ocupado": {ep_a_id.get(r.fila.upper(), r.fila): _num(r.valor)
                                         for r in no_sat.itertuples() if r.columna == "During Occupied Cooling"},
        "electricidad_10min_kwh": round(float((el["p_total_kw"] * el["interval"] / 60).sum()), 1),
    }
    shutil.copy(idf, out / "modelo" / "in.idf")
    shutil.copy(floorplan, out / "modelo" / "floorplan.json")

    if proyecto_fv:
        idf_fv, sql_fv = _corrida(proyecto_fv)
        dbf = sqlite3.connect(sql_fv)
        par_fv = parametros(idf_fv, sql_fv, proyecto_fv / "floorplan.json")
        par["fv"], par["inversor_eficiencia"] = par_fv["fv"], par_fv["inversor_eficiencia"]
        fv = _serie(dbf, "Generator Produced DC Electricity Rate", "Hourly")
        fv = fv.groupby("ts")["valor"].sum().div(1000).rename("p_fv_dc_kw").reset_index()
        fv.to_csv(out / "fv_horario.csv", index=False, float_format="%.4f")
        sat = _tabla(dbf, "AnnualBuildingUtilityPerformanceSummary", "Electric Loads Satisfied")
        resumen["fv"] = {r.fila: round(_num(r.valor) / 0.0036, 1) for r in sat.itertuples()
                         if r.columna == "Electricity" and r.fila in ("Photovoltaic Power", "Power Conversion",
                                                                       "Electricity Coming From Utility",
                                                                       "Surplus Electricity Going To Utility",
                                                                       "Net Electricity From Utility")}
        resumen["fv"]["fuente"] = f"{proyecto_fv.name} ({idf_fv.parent.parent.name})"
        shutil.copy(idf_fv, out / "modelo" / "in_fv.idf")

    (out / "resumen_anual.json").write_text(json.dumps(resumen, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "modelo_parametros.json").write_text(json.dumps(par, indent=1, ensure_ascii=False), encoding="utf-8")
    epw = next(iter(sorted((proyecto / "files").glob("*.epw"))), None)
    if epw:
        (salida / "clima").mkdir(parents=True, exist_ok=True)
        shutil.copy(epw, salida / "clima" / epw.name)
    return resumen


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--proyecto", required=True, type=Path)
    ap.add_argument("--proyecto-fv", type=Path)
    ap.add_argument("--salida", type=Path, default=RAIZ / "data")
    a = ap.parse_args()
    print(json.dumps(importar(a.proyecto, a.proyecto_fv, a.salida), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
