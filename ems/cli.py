"""Interfaz de línea de comandos: `python -m ems <comando>`.

Comandos:
  auditoria      Línea base y clasificación de cargas
  validar        Compara el gemelo digital con la simulación de EnergyPlus (ASHRAE Guideline 14)
  calibrar       Calibra los parámetros efectivos del modelo RC contra EnergyPlus
  pronostico     Pronóstico día siguiente y métricas MAE/RMSE/MAPE (datos de EnergyPlus y del gemelo)
  escenarios     Línea base vs Reglas vs Reglas+DR vs MPC (KPIs, ROI, costo kWh evitado)
  pruebas        10 perfiles normales/anómalos con criterios de aceptación
  sensibilidad   Tornado de parámetros técnicos y económicos
  paridad        Compara la lógica Python con la de Node-RED (requiere Node.js)
  todo           Ejecuta todo lo anterior y escribe resultados/RESUMEN.md
  live           Gemelo digital en vivo por MQTT (+ InfluxDB si INFLUX_URL)
  exportar       Sube escenarios offline a InfluxDB (comparación en Grafana)
  energyplus     Corre el puente Python–EnergyPlus (requiere EnergyPlus ≥ 23.1)
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd

from . import config as m_config
from . import escenarios, kpi, pronostico, reportes
from .config import RAIZ
from .simulacion import simular


def _out(args) -> Path:
    p = Path(args.salida)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _set(args) -> dict:
    sobrescribir = {}
    for s in args.set or []:
        k, v = s.split("=", 1)
        try:
            v = json.loads(v)
        except json.JSONDecodeError:
            pass
        sobrescribir[k] = v
    return m_config.cargar(args.config, sobrescribir)


def cmd_auditoria(args, cfg=None, res_base=None):
    cfg = cfg or _set(args)
    out = _out(args)
    res_base = res_base or simular(cfg, "baseline", dias=args.dias)
    zonas, usos = reportes.auditoria(res_base, cfg)
    zonas.to_csv(out / "auditoria_zonas.csv", index=False)
    usos.to_csv(out / "auditoria_usos.csv", index=False)
    k = kpi.energeticos(res_base, cfg)
    a = kpi.anualizar(k, cfg)
    area = escenarios.area_total(cfg)
    resumen = {"area_m2": area, "energia_semana_kwh": k["energia_kwh"], "energia_anual_mwh": a["energia_anual_kwh"] / 1000,
               "eui_kwh_m2_anio": a["energia_anual_kwh"] / area, "demanda_max_15min_kw": k["demanda_max_15min_kw"],
               "factor_carga": k["factor_carga"], "fp_medio": k["fp_medio"],
               "costo_anual_usd": a["costo_energia_anual_usd"] + a["costo_demanda_anual_usd"],
               "co2_anual_t": a["co2_anual_t"], "confort_pct": k["confort_pct"]}
    reportes.guardar_json(out / "auditoria_resumen.json", resumen)
    print(usos.to_string(index=False))
    print(json.dumps(resumen, indent=2, default=float))
    return zonas, usos, resumen


def cmd_pronostico(args, cfg=None):
    """Pronóstico día siguiente sobre dos fuentes: el año simulado por EnergyPlus (histórico del medidor,
    validación en las últimas 4 semanas) y 6 semanas del gemelo digital con ocupación estocástica."""
    from .validacion import DATOS

    cfg = cfg or _set(args)
    out = _out(args)
    tablas = []
    serie_ep = None
    if (DATOS / "electricidad_10min.csv").exists():
        h = pronostico.historico_energyplus(cfg)
        serie_ep, met_ep = pronostico.evaluar_horario(h, dias_prueba=28, usar_sarimax=not args.sin_sarimax)
        serie_ep.to_csv(out / "pronostico_serie_energyplus.csv")
        tablas.append(met_ep.assign(fuente="EnergyPlus (año 2006, 4 semanas de validación)"))
        reportes.pronostico_fig(serie_ep.iloc[-24 * 7:], met_ep, out / "fig_pronostico_energyplus.png",
                                titulo="Pronóstico del día siguiente — datos de EnergyPlus (última semana)")
    inicio = (pd.Timestamp("2026-11-02") - pd.Timedelta(days=35)).strftime("%Y-%m-%d %H:%M")
    hist = simular(cfg, args.controlador, dias=42, inicio=inicio)
    serie, met = pronostico.evaluar(hist.medidor, dias_prueba=7, usar_sarimax=not args.sin_sarimax)
    serie.to_csv(out / "pronostico_serie.csv")
    tablas.append(met.assign(fuente=f"Gemelo digital ({args.controlador}, 1 semana de validación)"))
    reportes.pronostico_fig(serie, met, out / "fig_pronostico.png",
                            titulo="Pronóstico del día siguiente — gemelo digital con ocupación estocástica")
    todas = pd.concat(tablas).reset_index().set_index(["fuente", "modelo"])
    todas.to_csv(out / "pronostico_metricas.csv")
    print(todas.round(3).to_string())
    return serie_ep if serie_ep is not None else serie, todas


def cmd_validar(args, cfg=None):
    from . import validacion

    cfg = cfg or _set(args)
    out = _out(args)
    a = validacion.anual(cfg)
    a["usos"].round(1).to_csv(out / "validacion_usos_finales.csv")
    semanas = []
    ref = validacion.cargar_energyplus()
    for ini, dias in validacion.SEMANAS_CALIBRACION:
        c = validacion.comparar(cfg, ini, dias, ref)
        semanas.append({"periodo": c["periodo"], **{f"total_{k}": v for k, v in c["electricidad_total"].items()},
                        **{f"vrf_{k}": v for k, v in c["compresores_vrf"].items() if k != "n"},
                        "pico_energyplus_kw": c["pico_kw"]["energyplus"], "pico_modelo_kw": c["pico_kw"]["modelo"],
                        **{f"rmse_t_{z}": v for z, v in c["rmse_temp_ocupado_c"].items()}})
        if ini == validacion.SEMANAS_CALIBRACION[-1][0]:
            reportes.validacion_fig(c["series"], a["usos"], out / "fig_validacion_energyplus.png")
    tabla = pd.DataFrame(semanas)
    tabla.to_csv(out / "validacion_semanas.csv", index=False)
    resumen = {"anual_horario": a["horario"], "pico_kw": a["pico_kw"],
               "total_anual_kwh": {"energyplus": float(a["usos"].loc["Total End Uses", "energyplus_kwh"]),
                                   "modelo": float(a["usos"].loc["Total End Uses", "modelo_kwh"])}}
    reportes.guardar_json(out / "validacion_resumen.json", resumen)
    print(a["usos"].round(1).to_string())
    print(json.dumps(resumen, indent=2, default=float))
    return a, tabla, resumen


def cmd_calibrar(args, cfg=None):
    from . import validacion

    cfg = cfg or _set(args)
    mejor, tabla = validacion.calibrar(cfg)
    tabla.to_csv(_out(args) / "calibracion_rejilla.csv", index=False)
    print(tabla.head(10).round(3).to_string(index=False))
    print("Mejor combinación (copiar a config/edificio.yaml):", json.dumps(mejor, indent=2))
    return mejor, tabla


def cmd_escenarios(args, cfg=None):
    cfg = cfg or _set(args)
    out = _out(args)
    tabla, res = escenarios.comparar(cfg, dias=args.dias)
    tabla.to_csv(out / "kpi_escenarios.csv")
    cols_eco = ["energia_ahorrada_kwh", "ahorro_pct", "pico_evitado_kw", "pico_evitado_pct", "energia_ahorrada_anual_kwh",
                "ahorro_energia_usd_anio", "ahorro_demanda_usd_anio", "ahorro_total_usd_anio", "co2_evitado_t_anio",
                "capex_usd", "vpn_usd", "tir_pct", "payback_anios", "roi_pct", "costo_kwh_evitado_usd",
                "precio_medio_kwh_usd"]
    eco = tabla.drop(index="baseline")[cols_eco]
    eco.to_csv(out / "economia.csv")
    mejor = eco["vpn_usd"].idxmax()
    esc_pa = kpi.escalamiento_panama(eco.loc[mejor].to_dict(), escenarios.area_total(cfg))
    esc_pa.to_csv(out / "escalamiento_panama.csv", index=False)
    reportes.perfil_escenarios(res, out / "fig_perfil_escenarios.png")
    reportes.desglose(tabla, out / "fig_desglose_usos.png")
    reportes.temperaturas(res["baseline"], out / "fig_temperaturas_baseline.png")
    reportes.temperaturas(res["reglas_dr"], out / "fig_temperaturas_reglas_dr.png")
    if args.series:
        sd = out / "series"
        sd.mkdir(exist_ok=True)
        for n, r in res.items():
            r.medidor.to_csv(sd / f"medidor_{n}.csv")
            r.zonas.to_csv(sd / f"zonas_{n}.csv", index=False)
            r.alarmas.to_csv(sd / f"alarmas_{n}.csv", index=False)
    cols = ["energia_kwh", "demanda_max_15min_kw", "confort_pct", "ahorro_pct", "pico_evitado_kw",
            "ahorro_total_usd_anio", "payback_anios", "vpn_usd", "costo_kwh_evitado_usd"]
    print(tabla[[c for c in cols if c in tabla]].round(2).to_string())
    return tabla, eco, esc_pa, res


def cmd_pruebas(args, cfg=None):
    cfg = cfg or _set(args)
    out = _out(args)
    df, _ = escenarios.pruebas(cfg, args.controlador)
    df.to_csv(out / "pruebas.csv", index=False)
    conf = escenarios.resumen_confiabilidad(df)
    reportes.guardar_json(out / "confiabilidad.json", conf)
    print(df[["id", "prueba", "superada", "confort_pct", "demanda_max_kw", "detalle_checks"]].to_string(index=False))
    print(json.dumps(conf, indent=2))
    return df, conf


def cmd_sensibilidad(args, cfg=None):
    cfg = cfg or _set(args)
    out = _out(args)
    s = escenarios.sensibilidad(cfg, args.controlador, dias=args.dias)
    s.to_csv(out / "sensibilidad.csv", index=False)
    reportes.tornado(s, out / "fig_tornado_vpn.png")
    print(s.round(3).to_string(index=False))
    return s


def cmd_paridad(args, cfg=None):
    from .nodered import ControladorNodeRed, disponible

    cfg = cfg or _set(args)
    if not disponible():
        print("Node.js no está instalado: paridad omitida")
        return None
    c = ControladorNodeRed(cfg)
    rn = simular(cfg, c, dias=args.dias, nombre="nodered")
    c.cerrar()
    rp = simular(cfg, "reglas_dr", dias=args.dias)
    dif = (rn.medidor["p_total_kw"] - rp.medidor["p_total_kw"]).abs()
    r = {"pasos": int(len(dif)), "pasos_distintos": int((dif > 1e-6).sum()), "max_dif_kw": float(dif.max()),
         "alarmas_python": int(len(rp.alarmas)), "alarmas_nodered": int(len(rn.alarmas)),
         "latencia_media_nodered_ms": float(rn.latencia_ms.mean())}
    reportes.guardar_json(_out(args) / "paridad_nodered.json", r)
    print(json.dumps(r, indent=2))
    return r


def cmd_todo(args):
    t0 = time.time()
    cfg = _set(args)
    out = _out(args)
    print("== Escenarios ==")
    tabla, eco, esc_pa, res = cmd_escenarios(args, cfg)
    print("\n== Auditoría ==")
    _, usos, aud = cmd_auditoria(args, cfg, res["baseline"])
    print("\n== Validación contra EnergyPlus ==")
    _, _, val = cmd_validar(args, cfg)
    print("\n== Pronóstico ==")
    _, met = cmd_pronostico(args, cfg)
    print("\n== Pruebas ==")
    pr, conf = cmd_pruebas(args, cfg)
    print("\n== Sensibilidad ==")
    sens = cmd_sensibilidad(args, cfg)
    print("\n== Paridad Node-RED ==")
    par = cmd_paridad(args, cfg)
    sel = ["energia_kwh", "demanda_max_15min_kw", "confort_pct", "ahorro_pct", "energia_ahorrada_kwh",
           "pico_evitado_kw", "ahorro_total_usd_anio", "vpn_usd", "payback_anios", "roi_pct", "costo_kwh_evitado_usd",
           "co2_evitado_t_anio"]
    reportes.escribir_resumen(out / "RESUMEN.md", {
        "Auditoría energética (línea base)": aud,
        "Clasificación de cargas": usos.set_index("uso"),
        "Validación del gemelo digital contra EnergyPlus (año completo)": {
            "NMBE horario (%)": val["anual_horario"]["nmbe_pct"], "CV(RMSE) horario (%)": val["anual_horario"]["cvrmse_pct"],
            "Cumple ASHRAE Guideline 14": val["anual_horario"]["cumple_g14"],
            "Energía anual E+ (kWh)": val["total_anual_kwh"]["energyplus"], "Energía anual modelo (kWh)": val["total_anual_kwh"]["modelo"]},
        "Escenarios (4 semanas tipo con el EPW de Panamá, mismo clima y ocupación)": tabla[[c for c in sel if c in tabla]],
        "Pronóstico día siguiente": met,
        "Pruebas normales y anómalas": pr[["id", "prueba", "superada", "confort_pct", "demanda_max_kw",
                                           "detalle_checks"]].set_index("id"),
        "Confiabilidad, disponibilidad y latencia": conf,
        "Paridad Python ⇄ Node-RED": par or "omitida",
        "Escalamiento en Panamá (mejor escenario por VPN)": esc_pa.set_index("adopcion_pct"),
        "Sensibilidad": sens.set_index("parametro"),
    })
    print(f"\nListo en {time.time() - t0:.0f} s → {out}/RESUMEN.md")


def cmd_live(args):
    from .live import Puente

    Puente(_set(args), control=args.control, velocidad=args.velocidad, inicio=args.inicio, dias=args.dias_live).correr()


def cmd_exportar(args):
    from .influx import Escritor, exportar_resultado

    cfg = _set(args)
    esc = Escritor()
    if not esc.habilitado:
        raise SystemExit("Defina INFLUX_URL, INFLUX_TOKEN (y opcionalmente INFLUX_ORG, INFLUX_BUCKET)")
    tabla, res = escenarios.comparar(cfg, dias=args.dias)
    for n, r in res.items():
        print(f"exportando {n} …")
        exportar_resultado(esc, r, n)
        esc.kpi(r.medidor.index[-1], n, tabla.loc[n].to_dict())
    esc.flush(forzar=True)
    hist = simular(cfg, "reglas_dr", dias=42, inicio="2026-09-28 00:00")
    serie, _ = pronostico.evaluar(hist.medidor, 7, usar_sarimax=False)
    esc.pronostico(serie["regresion"], "regresion", serie["real"])
    esc.cerrar()
    print("Exportación completa")


def cmd_energyplus(args):
    from .energyplus_bridge import ejecutar

    ejecutar(_set(args), args.idf, args.epw, control=args.controlador, salida=args.salida, mapa=args.mapa)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ems", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(m_config.CONFIG_DEFECTO))
    ap.add_argument("--salida", default=str(RAIZ / "resultados"))
    ap.add_argument("--set", action="append", help="sobrescribe parámetros, p. ej. --set ems.limite_demanda_kw=140")
    ap.add_argument("--dias", type=float, default=7)
    ap.add_argument("--controlador", default="reglas_dr", choices=["baseline", "reglas", "reglas_dr", "mpc"])
    ap.add_argument("--sin-sarimax", action="store_true")
    ap.add_argument("--series", action="store_true", help="guarda series completas en resultados/series")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("auditoria", "validar", "calibrar", "pronostico", "escenarios", "pruebas", "sensibilidad", "paridad",
              "todo", "exportar"):
        sub.add_parser(n)
    lv = sub.add_parser("live")
    lv.add_argument("--control", choices=["externo", "interno", "baseline"], default=None)
    lv.add_argument("--velocidad", type=float, default=None)
    lv.add_argument("--inicio", default=None)
    lv.add_argument("--dias-live", type=float, default=None)
    ep = sub.add_parser("energyplus")
    ep.add_argument("--idf", required=True)
    ep.add_argument("--epw", required=True)
    ep.add_argument("--mapa", default=None, help="YAML zona→objetos del IDF (defecto config/energyplus_mapa.yaml)")
    args = ap.parse_args(argv)
    {"auditoria": cmd_auditoria, "validar": cmd_validar, "calibrar": cmd_calibrar, "pronostico": cmd_pronostico, "escenarios": cmd_escenarios, "pruebas": cmd_pruebas,
     "sensibilidad": cmd_sensibilidad, "paridad": cmd_paridad, "todo": cmd_todo, "live": cmd_live,
     "exportar": cmd_exportar, "energyplus": cmd_energyplus}[args.cmd](args)


if __name__ == "__main__":
    main()
