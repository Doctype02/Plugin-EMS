"""Importa los resultados del modelo OpenStudio/EnergyPlus del edificio a `data/`.

    python tools/importar_energyplus.py --sql run/eplusout.sql --epw files/PAN_...epw

Genera (calendario de la simulación de EnergyPlus, año 2006: 1 de enero = domingo):
- data/energyplus/electricidad_10min.csv   ts, p_total_kw            (Electricity:Facility, paso de zona)
- data/energyplus/zonas_horario.csv        ts, zona, temp_c, hr_pct, ocupantes, q_frio_kw
- data/energyplus/vrf_horario.csv          ts, sistema, p_kw          (electricidad de cada sistema VRF)
- data/energyplus/resumen_anual.json       usos finales, pico, horas no satisfechas, áreas
- data/clima/<epw>                          copia del archivo climático usado

Convención de tiempo: cada registro se etiqueta con el INICIO del intervalo (EnergyPlus reporta el final).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path

import pandas as pd

RAIZ = Path(__file__).resolve().parent.parent

# Nombres de zona de EnergyPlus → identificadores del EMS (config/edificio.yaml)
MAPA_ZONAS = {
    "ZT RECEPCION": "Z01",
    "ZT CUBICULOS": "Z02",
    "ZT SALA DE CONFERENCIA": "Z03",
    "ZT OFFICE 1": "Z04",
    "ZT OFFICE 2": "Z05",
    "ZT OFFICE 3": "Z06",
    "ZT OFFICE 4": "Z07",
    "ZT PASILLO": "Z08",
    "ZT SERVO": "Z09",
    "CUARTO ELECTRICO 1": "Z10",
}
MAPA_VRF = {"VRF SYSTEM": "VRF-A", "VRF SYSTEM 1": "VRF-B", "VRF SYSTEM 2": "VRF-C"}


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


def _tabla(db: sqlite3.Connection, reporte: str, tabla: str) -> pd.DataFrame:
    q = """SELECT RowName, ColumnName, Value, Units FROM TabularDataWithStrings
           WHERE ReportName = ? AND TableName = ?"""
    return pd.DataFrame(db.execute(q, (reporte, tabla)).fetchall(), columns=["fila", "columna", "valor", "unidad"])


def _num(v: str) -> float:
    try:
        return float(str(v).strip())
    except ValueError:
        return float("nan")


def importar(sql: Path, epw: Path | None, salida: Path) -> dict:
    db = sqlite3.connect(f"file:{sql}?mode=ro", uri=True)
    out = salida / "energyplus"
    out.mkdir(parents=True, exist_ok=True)

    el = _serie(db, "Electricity:Facility", "Zone Timestep")
    el["p_total_kw"] = el["valor"] / (el["interval"] * 60) / 1000
    el[["ts", "p_total_kw"]].sort_values("ts").to_csv(out / "electricidad_10min.csv", index=False, float_format="%.4f")

    piezas = []
    for var, col in [("Zone Mean Air Temperature", "temp_c"), ("Zone Air Relative Humidity", "hr_pct"),
                     ("Zone People Occupant Count", "ocupantes"), ("Zone VRF Air Terminal Total Cooling Rate", "q_frio_kw")]:
        s = _serie(db, var, "Hourly")
        s["zona"] = s["clave"].str.upper().map(MAPA_ZONAS)
        if col == "q_frio_kw":
            # la clave es el terminal; se asigna a la zona por el orden de la tabla de equipos
            s["zona"] = s["clave"].str.upper().map(_terminal_a_zona())
            s["valor"] = s["valor"] / 1000
        piezas.append(s.set_index(["ts", "zona"])["valor"].rename(col))
    zonas = pd.concat(piezas, axis=1).reset_index().sort_values(["ts", "zona"])
    zonas.to_csv(out / "zonas_horario.csv", index=False, float_format="%.3f")

    vrf = _serie(db, "VRF Heat Pump Cooling Electricity Rate", "Hourly")
    vrf["sistema"] = vrf["clave"].str.upper().map(MAPA_VRF)
    vrf["p_kw"] = vrf["valor"] / 1000
    vrf[["ts", "sistema", "p_kw"]].sort_values(["ts", "sistema"]).to_csv(out / "vrf_horario.csv", index=False, float_format="%.4f")

    usos = _tabla(db, "AnnualBuildingUtilityPerformanceSummary", "End Uses")
    usos = usos[(usos.columna == "Electricity")]
    pico = _tabla(db, "DemandEndUseComponentsSummary", "End Uses")
    pico = pico[pico.columna == "Electricity"]
    no_sat = _tabla(db, "SystemSummary", "Time Setpoint Not Met")
    resumen = {
        "fuente": "OpenStudio/EnergyPlus — EMS_Edificio_Ultima simulacion",
        "clima": epw.name if epw else None,
        "area_m2": 800.0,
        "energia_anual_kwh": {r.fila: round(_num(r.valor) / 0.0036, 1) for r in usos.itertuples() if _num(r.valor) > 0},
        "pico_kw": {r.fila: round(_num(r.valor) / 1000, 3) for r in pico.itertuples() if r.fila != "Time of Peak" and _num(r.valor) > 0},
        "hora_pico": pico.loc[pico.fila == "Time of Peak", "valor"].iloc[0].strip(),
        "horas_no_satisfechas_ocupado": {
            MAPA_ZONAS.get(r.fila.upper(), r.fila): _num(r.valor)
            for r in no_sat.itertuples() if r.columna == "During Occupied Cooling"
        },
        "electricidad_10min_kwh": round(float((el["p_total_kw"] * el["interval"] / 60).sum()), 1),
    }
    (out / "resumen_anual.json").write_text(json.dumps(resumen, indent=2, ensure_ascii=False), encoding="utf-8")

    if epw:
        (salida / "clima").mkdir(parents=True, exist_ok=True)
        shutil.copy(epw, salida / "clima" / epw.name)
    return resumen


def _terminal_a_zona() -> dict[str, str]:
    """Terminales VRF del modelo → zona (según ZoneHVAC:EquipmentList del IDF)."""
    return {
        "VRF ZONE TERMINAL": "Z04", "VRF ZONE TERMINAL 1": "Z05", "VRF ZONE TERMINAL 2": "Z06",
        "VRF ZONE TERMINAL 3": "Z07", "VRF ZONE TERMINAL 4": "Z08", "VRF ZONE TERMINAL 5": "Z02",
        "VRF ZONE TERMINAL 6": "Z10", "VRF ZONE TERMINAL 7": "Z01", "VRF ZONE TERMINAL 8": "Z03",
        "VRF ZONE TERMINAL 9": "Z09",
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sql", required=True, type=Path)
    ap.add_argument("--epw", type=Path)
    ap.add_argument("--salida", type=Path, default=RAIZ / "data")
    a = ap.parse_args()
    r = importar(a.sql, a.epw, a.salida)
    print(json.dumps(r, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
