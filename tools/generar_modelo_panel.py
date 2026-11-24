"""Genera el modelo del edificio para el panel de Grafana a partir de config/edificio.yaml.

    python tools/generar_modelo_panel.py [--config config/edificio.yaml] [--salida grafana-ems-panel/src/building]

Escribe:
- grafana-ems-panel/src/building/modelData.ts           edificio, plantas, zonas, sistemas, FV, horarios…
- grafana-ems-panel/src/building/__fixtures__/thermal_ref.json
      parámetros térmicos derivados por ems/config.py::zonas (ua, g_inf, ua_arriba, ua_abajo, ua_suelo, c, cop)
      para comprobar en Jest que model.ts::thermal replica al gemelo en Python.

El núcleo del elevador sale de data/energyplus/modelo_parametros.json (si existe). Las unidades exteriores
VRF se ubican en una franja de mantenimiento junto al borde norte de la azotea (el resto es fotovoltaica).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

try:  # parámetros derivados idénticos a los del gemelo (opcional: sin el paquete se omite la referencia)
    from ems import config as ems_config  # noqa: E402
except Exception:  # pragma: no cover - entorno sin el paquete ems
    ems_config = None

ENCABEZADO = """// Generado por tools/generar_modelo_panel.py — no editar.
// Fuente: config/edificio.yaml (modelo OpenStudio/EnergyPlus) y data/energyplus/modelo_parametros.json.
import type { FixedLoad, Floor, HvacSystem, PtacUnit, PvSpec, Schedule, SurfaceSpec, VrfUnit, ZoneData } from './model';
"""

ORIENT = {"N": "n", "S": "s", "E": "e", "W": "w"}
DIAS = {"laborable": "weekday", "sabado": "saturday", "domingo": "sunday"}


def rect(r) -> dict:
    x, y, w, d = (float(v) for v in r)
    return {"x": x, "y": y, "w": w, "d": d}


def num(v: float, nd: int = 4) -> float:
    v = round(float(v), nd)
    return int(v) if v == int(v) else v


def nombre_planta(corto: str, nivel: int) -> str:
    return "Planta baja" if nivel == 0 else f"Planta {corto[1:] if corto.startswith('P') and corto[1:].isdigit() else nivel}"


def ts(obj, indent: int = 0) -> str:
    """Literal TypeScript legible (JSON con claves sin comillas cuando es posible)."""
    pad = "  " * indent
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        items = []
        for k, v in obj.items():
            key = k if k.replace("_", "").isalnum() and not k[0].isdigit() else ts(k)
            items.append(f"{pad}  {key}: {ts(v, indent + 1)}")
        one = "{ " + ", ".join(i.strip() for i in items) + " }"
        if len(one) + len(pad) <= 110 and "\n" not in one:
            return one
        return "{\n" + ",\n".join(items) + f",\n{pad}}}"
    if isinstance(obj, list):
        if not obj:
            return "[]"
        parts = [ts(v, indent + 1) for v in obj]
        one = "[" + ", ".join(parts) + "]"
        if len(one) + len(pad) <= 110 and "\n" not in one:
            return one
        return "[\n" + ",\n".join(f"{pad}  {p}" for p in parts) + f",\n{pad}]"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if obj is None:
        return "undefined"
    if isinstance(obj, float):
        return repr(num(obj, 8))
    if isinstance(obj, int):
        return str(obj)
    return "'" + str(obj).replace("\\", "\\\\").replace("'", "\\'") + "'"


def nucleo_elevador(n_plantas: int) -> list[list[float]]:
    p = RAIZ / "data" / "energyplus" / "modelo_parametros.json"
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        rects = list(d.get("nucleo_elevador", {}).values())
        if len(rects) >= n_plantas:
            return [list(map(float, r)) for r in rects[:n_plantas]]
    except (OSError, ValueError):
        pass
    return [[9.0, 0.0, 2.0, 2.0]] * n_plantas


def unidades_azotea(vrf: list[dict], ancho: float, fondo: float) -> list[dict]:
    """Franja norte de la azotea: unidades en fila a lo largo de x, separación ≥ 3.1 m para que los
    rótulos no se encimen en ninguna orientación."""
    n = len(vrf)
    paso = (ancho - 0.8) / max(n, 1)
    out = []
    for i, s in enumerate(vrf):
        grande = s["capacidad_kw"] > 10
        w, d = (min(2.4, paso - 0.7), 1.4) if grande else (1.2, 1.0)
        cx = 0.4 + paso * (i + 0.5)
        out.append({"x": round(cx - w / 2, 2), "y": round(fondo - 0.55 - d, 2), "w": round(w, 2), "d": d})
    return out


def limites_controladores() -> dict:
    """Rangos de ems/controladores.py (con valores por defecto si el paquete no está disponible)."""
    try:
        from ems import controladores as c
        r = {"capPct": c.RANGO_CAPACIDAD, "unitSetpoint": c.RANGO_SETPOINT, "copFactor": c.RANGO_COP,
             "tempOffset": c.RANGO_OFFSET, "tempValue": c.RANGO_TEMP, "rh": c.RANGO_HR}
        dur = c.DURACION_MAX_MIN
    except Exception:  # pragma: no cover
        r = {"capPct": (0, 100), "unitSetpoint": (18, 30), "copFactor": (0.5, 1.2), "tempOffset": (-10, 10),
             "tempValue": (5, 50), "rh": (0, 100)}
        dur = 10080
    out = {k: [num(a), num(b)] for k, (a, b) in r.items()}
    out["maxDurationMin"] = dur
    return out


def generar(cfg: dict) -> tuple[str, dict]:
    e = cfg["edificio"]
    n = int(e.get("plantas", 1 + max(int(z["planta"]) for z in cfg["zonas"])))
    cortos = list(e.get("nombres_plantas") or [f"P{i}" for i in range(n)])
    ancho = max(z["rect"][0] + z["rect"][2] for z in cfg["zonas"])
    fondo = max(z["rect"][1] + z["rect"][3] for z in cfg["zonas"])
    elev = nucleo_elevador(n)
    sistemas = cfg.get("sistemas_vrf", [])
    tipo_sis = {s["id"]: s.get("tipo", "vrf") for s in sistemas}
    f_cop = float(e.get("factor_cop", 1.0))
    cop_sis = {s["id"]: s["cop"] for s in sistemas}

    building = {
        "name": "Edificio de oficinas — Ciudad de Panamá",
        "width": num(ancho),
        "depth": num(fondo),
        "floorHeight": num(e["altura_piso_m"]),
        "floors": n,
        "vll": num(e.get("v_ll", 480)),
        "latitude": num(e.get("latitud", 8.97)),
        "longitude": num(e.get("longitud", -79.5)),
        "timeZone": e.get("zona_horaria", "America/Panama"),
    }
    floors = [
        {"level": i, "name": nombre_planta(cortos[i], i), "short": cortos[i],
         "extras": [{"rect": rect(elev[i]), "label": "Elevador"}]}
        for i in range(n)
    ]
    zones, surfaces = [], {}
    for z in cfg["zonas"]:
        partes = z.get("rects") or [z["rect"]]
        d = {
            "id": z["id"], "name": z["nombre"], "type": z["tipo"], "critical": bool(z.get("critica")),
            "floor": int(z["planta"]), "rect": rect(z["rect"]), "rects": [rect(r) for r in partes],
            "area": num(z["area"]), "occupants": int(z["ocupantes"]), "lpd": num(z["lpd"]), "epd": num(z["epd"]),
            "hvacKw": num(z["hvac_kw"]), "cop": num(cop_sis.get(z["sistema"], 3.0) * f_cop),
            "fanKw": num(z["fan_w"] / 1000.0), "system": z["sistema"], "systemKind": tipo_sis.get(z["sistema"], "vrf"),
        }
        if z.get("it_kw"):
            d["itKw"] = num(z["it_kw"])
        if z.get("setpoint_fijo") is not None:
            d["fixedSetpoint"] = num(z["setpoint_fijo"])
        d["glazing"] = {ORIENT[o]: num(a) for o, a in (z.get("ventanas") or {}).items() if a}
        d["schedules"] = {
            "occupancy": z.get("horario_ocupacion", "ocupacion"),
            "lights": z.get("horario_luces", "iluminacion"),
            "equipment": z["horario_equipos"],
            "ac": z["horario_ac"],
        }
        d["fanMode"] = z.get("ventilador", "continuo")
        zones.append(d)
        surfaces[z["id"]] = {
            "walls": {ORIENT[o]: num(a) for o, a in (z.get("muros") or {}).items() if a},
            "roof": num(z.get("techo", 0)), "ground": num(z.get("suelo", 0)),
        }

    zona_planta = {z["id"]: int(z["planta"]) for z in cfg["zonas"]}
    criticas_set = {z["id"] for z in cfg["zonas"] if z.get("critica")}
    hvac = [{"id": s["id"], "kind": s.get("tipo", "vrf"), "capacityKw": num(s["capacidad_kw"]),
             "cop": num(s["cop"] * f_cop), "zones": list(s["zonas"]),
             "critical": any(z in criticas_set for z in s["zonas"])} for s in sistemas]
    vrf = [h for h in hvac if h["kind"] != "ptac"]
    rects_vrf = unidades_azotea([s for s in sistemas if s.get("tipo", "vrf") != "ptac"], ancho, fondo)
    vrf_units = [{**h, "rect": r} for h, r in zip(vrf, rects_vrf)]
    ptac_units = []
    for h in hvac:
        if h["kind"] != "ptac":
            continue
        zid = h["zones"][0]
        muros = next(z for z in cfg["zonas"] if z["id"] == zid).get("muros") or {}
        fachada = ORIENT[max(muros, key=muros.get)] if muros else "s"
        ptac_units.append({**h, "zone": zid, "floor": zona_planta[zid], "facade": fachada})

    fv = cfg.get("fv") or {}
    rect_zona = {z["id"]: z["rect"] for z in cfg["zonas"]}
    campos = []
    for c in fv.get("campos", []):
        r = elev[-1] if c["sobre"] == "elevador" else rect_zona[c["sobre"]]
        campos.append({"id": c["id"], "areaM2": num(c["area_m2"]), "over": c["sobre"], "rect": rect(r)})
    area_fv = sum(c["area_m2"] for c in fv.get("campos", []))
    pv = {
        "enabledDefault": bool(fv.get("habilitado", bool(fv))),
        "fractionActive": num(fv.get("fraccion_activa", 0.6)),
        "efficiency": num(fv.get("eficiencia", 0.24)),
        "inverter": num(fv.get("inversor", 0.96)),
        "areaM2": num(area_fv),
        "peakKw": num(area_fv * fv.get("fraccion_activa", 0.6) * fv.get("eficiencia", 0.24) * fv.get("inversor", 0.96), 2),
        "fields": campos,
    }

    envelope = {
        "uWall": num(e["u_muro"]), "uRoof": num(e["u_techo"]), "uGround": num(e["u_suelo"]),
        "uGlass": num(e["u_ventana"]), "shgc": num(e["shgc"]), "vt": num(e.get("vt", 0.45)),
        "infiltration": num(e["infiltracion_m3s_m2"], 8), "uInterfloor": num(e.get("u_entrepiso", 0.0)),
        "rhoCp": 1.2 * 1.006, "tGround": num(e["t_suelo_c"]),
        # capacitancia total (nodo de masa + nodo de aire del gemelo 2R2C)
        "capacitancePerM2": num(e["capacitancia_kwh_k_m2"] + e.get("capacitancia_aire_kwh_k_m2", 0.0), 4), "solarFactor": num(e["factor_solar"]),
        "skyDeltaT": num(e.get("delta_t_cielo_c", 0.0)), "ventilationPerPerson": num(e.get("ventilacion_m3s_persona", 0), 6),
        "copFactor": num(f_cop), "latentFraction": num(e.get("fraccion_latente_serpentin", 0.1)),
        "standbyFraction": num(e.get("fraccion_standby_equipos", 0.1)),
    }

    schedules = {nombre: {DIAS[k]: [[num(a), num(b)] for a, b in perfil] for k, perfil in h.items()}
                 for nombre, h in cfg["horarios"].items() if isinstance(h, dict)}
    fixed = [{"name": c["nombre"], "kw": num(c["kw"]), "schedule": c.get("horario"), "pf": num(c.get("fp", 0.9)),
              "critical": bool(c.get("critica", False)), "backup": bool(c.get("respaldo", False))}
             for c in cfg.get("cargas_fijas") or [] if "horario" in c]
    m = cfg["ems"]
    o = cfg["ocupacion"]
    t = cfg["tarifa"]
    lim = m["limite_demanda_kw"]
    rules = {
        "band": num(m["banda_histeresis_c"]), "spOccupied": num(m["setpoint_ocupado_c"]),
        "spUnoccupied": num(m["setpoint_desocupado_c"]), "spBaseline": num(m.get("setpoint_baseline_c", 22)),
        "tProtMax": num(m.get("t_proteccion_max_c", 32)), "tProtReturn": num(m.get("t_proteccion_retorno_c", 30)),
        "setpointRampCh": num(m.get("rampa_setpoint_c_h", 0)), "startsPerStep": num(m.get("arranques_max_paso", 0)),
        "scheduleTransitionMin": num(cfg["horarios"].get("transicion_min", 0)),
        "precoolMin": num(m["precool_min"]), "entry": num(o["hora_entrada"]), "exit": num(o["hora_salida"]),
        "luxTarget": num(m["lux_objetivo"]), "comfortMax": num(m["confort_max_c"]), "comfortMin": num(m["confort_min_c"]),
        "serverAlarm": num(m["alarma_servidor_c"]), "drMarginC": num(m["dr_margen_confort_c"]),
        "drHysteresisKw": num(m["dr_histeresis_kw"]), "plugsUnoccupied": num(m["equipos_desocupado_ems"]),
        "absenteeism": num(o.get("ausentismo", 0.08)), "noise": num(o.get("ruido", 0.1)),
    }
    tariff = {
        "peakUsdKwh": num(t["precio_punta_usd_kwh"], 5), "offPeakUsdKwh": num(t["precio_fuera_punta_usd_kwh"], 5),
        "peakHours": [num(h) for h in t["hora_punta"]], "demandUsdKwMonth": num(t["cargo_demanda_usd_kw_mes"]),
        "co2KgKwh": num(t["factor_co2_kg_kwh"]), "exportUsdKwh": num(t.get("precio_excedente_usd_kwh", 0)),
    }
    criticas = [z["id"] for z in cfg["zonas"] if z.get("critica")]

    out = [ENCABEZADO]
    out.append(f"export const BUILDING = {ts(building)} as const;\n")
    out.append(f"export const FLOORS: Floor[] = {ts(floors)};\n")
    out.append(f"export const ZONE_DATA: ZoneData[] = {ts(zones)};\n")
    out.append("/** Muros exteriores brutos por fachada (m²), techo exterior y losa sobre terreno (E+ Surfaces). */")
    out.append(f"export const SURFACES: Record<string, SurfaceSpec> = {ts(surfaces)};\n")
    out.append("/** Constantes de la envolvente y de la calibración del gemelo (config/edificio.yaml → edificio). */")
    out.append(f"export const ENVELOPE = {ts(envelope)};\n")
    out.append("/** Sistemas de climatización: unidades exteriores VRF y PTAC de pared (config/edificio.yaml → sistemas_vrf). */")
    out.append(f"export const HVAC_SYSTEMS: HvacSystem[] = {ts(hvac)};\n")
    out.append("/** Unidades exteriores VRF en la franja de mantenimiento norte de la azotea. */")
    out.append(f"export const VRF_UNITS: VrfUnit[] = {ts(vrf_units)};\n")
    out.append("/** PTAC: equipo de pared en la fachada indicada de cada baño. */")
    out.append(f"export const PTAC_UNITS: PtacUnit[] = {ts(ptac_units)};\n")
    out.append("/** Fotovoltaica de la variante «ConPV»: campos sobre la losa de la última planta. */")
    out.append(f"export const PV: PvSpec = {ts(pv)};\n")
    out.append(f"export const LIMIT_KW = {num(lim)};")
    out.append("/** Rango que acepta Node-RED para el límite de demanda (0.25× – 3.3× el de diseño). */")
    out.append(f"export const LIMIT_RANGE: [number, number] = [{round(lim * 0.25)}, {round(lim * 3.3)}];")
    out.append(f"export const CRITICAL_ZONES: string[] = {ts(criticas)};\n")
    out.append("/** Horarios del modelo E+ (Schedule:Day:Interval): [hora de inicio, valor]. */")
    out.append(f"export const SCHEDULES: Record<string, Schedule> = {ts(schedules)};\n")
    out.append("/** Cargas sin zona acondicionada (kW × horario). */")
    out.append(f"export const FIXED_LOADS: FixedLoad[] = {ts(fixed)};\n")
    r = cfg.get("respaldo") or {}
    g, u, em = r.get("generador") or {}, r.get("ups") or {}, r.get("emergencia") or {}
    backup = {
        "enabled": bool(g.get("habilitado", False)), "genKw": num(g.get("potencia_kw", 0)),
        "loadMax": num(g.get("carga_max", 0.8)), "loadMin": num(g.get("carga_min", 0.3)),
        "startSeconds": num(g.get("arranque_s", 15)), "idleLPerHKw": num(g.get("consumo_vacio_l_h_kw", 0.03)),
        "lPerKwh": num(g.get("consumo_l_kwh", 0.24)), "tankL": num(g.get("tanque_l", 0)),
        "upsKw": num(u.get("potencia_kw", 0)), "upsMinutes": num(u.get("autonomia_min", 30)),
        "pvReconnectMin": num(r.get("fv_reconexion_min", 5)), "restartMin": num(r.get("rearranque_min", 3)), "setpoint": num(em.get("setpoint_c", 25)),
        "setpointMin": num(em.get("setpoint_min_c", 24)), "lights": num(em.get("luces_nivel", 0.7)),
        "noHvacTypes": list(em.get("tipos_sin_hvac") or []),
    }
    out.append("/** Planta de respaldo: generador, UPS y reglas de emergencia (config/edificio.yaml → respaldo). */")
    out.append(f"export const BACKUP = {ts(backup)};\n")
    out.append("/** Parámetros del EMS por reglas (config/edificio.yaml → ems, ocupacion). */")
    out.append(f"export const EMS_RULES = {ts(rules)};\n")
    out.append(f"export const TARIFF = {ts(tariff)};\n")
    out.append("/** Rangos de los ajustes de controladores que aceptan Node-RED y el gemelo (ems/controladores.py). */")
    out.append(f"export const CONTROLLER_LIMITS = {ts(limites_controladores())} as const;\n")

    ref = {}
    if ems_config is not None:
        ref["zonas"] = {
            z.id: {"ua": z.ua, "g_inf": z.g_inf, "ua_arriba": z.ua_arriba, "ua_abajo": z.ua_abajo,
                   "ua_suelo": z.ua_suelo, "c": z.c, "cop": z.cop}
            for z in ems_config.zonas(cfg)
        }
        ref["fv_kw_1000"] = ems_config.potencia_fv_kw(cfg, 1000.0)
    return "\n".join(out), ref


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=str(RAIZ / "config" / "edificio.yaml"))
    ap.add_argument("--salida", default=str(RAIZ / "grafana-ems-panel" / "src" / "building"))
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    codigo, ref = generar(cfg)
    salida = Path(a.salida)
    (salida / "modelData.ts").write_text(codigo, encoding="utf-8")
    print(f"escrito {salida / 'modelData.ts'}")
    if ref:
        fx = salida / "__fixtures__"
        fx.mkdir(exist_ok=True)
        (fx / "thermal_ref.json").write_text(json.dumps(ref, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"escrito {fx / 'thermal_ref.json'}")
    formatear([salida / "modelData.ts", salida / "__fixtures__" / "thermal_ref.json"])


def formatear(rutas: list[Path]) -> None:
    """Aplica el prettier del panel (si node_modules está instalado) para que el diff quede limpio."""
    prettier = RAIZ / "grafana-ems-panel" / "node_modules" / ".bin" / "prettier"
    existentes = [str(r) for r in rutas if r.exists()]
    if not prettier.exists() or not existentes:
        return
    try:
        subprocess.run([str(prettier), "--write", "--log-level", "warn", *existentes],
                       cwd=RAIZ / "grafana-ems-panel", check=False, timeout=120)
    except (OSError, subprocess.SubprocessError):
        pass


if __name__ == "__main__":
    main()
