"""Generación de tablas (CSV) y figuras (PNG) para el informe y el artículo."""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

# Paleta categórica de referencia (orden fijo) y tokens de texto/superficie
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
TXT, TXT2, GRID, SURF = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
COLOR_ESC = {"baseline": "#8a8985", "reglas": SERIES[0], "reglas_dr": SERIES[1], "mpc": SERIES[2]}
ETIQ = {"baseline": "Línea base", "reglas": "Reglas", "reglas_dr": "Reglas + DR", "mpc": "MPC"}

plt.rcParams.update({
    "figure.facecolor": SURF, "axes.facecolor": SURF, "axes.edgecolor": GRID, "axes.labelcolor": TXT2,
    "xtick.color": TXT2, "ytick.color": TXT2, "text.color": TXT, "axes.grid": True, "grid.color": GRID,
    "grid.linewidth": 0.6, "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 2,
    "font.size": 10, "axes.titlesize": 11, "axes.titleweight": "bold", "legend.frameon": False,
    "savefig.dpi": 160, "savefig.bbox": "tight",
})


def _guardar(fig, ruta: Path):
    fig.savefig(ruta)
    plt.close(fig)


def perfil_escenarios(resultados: dict, ruta: Path, dia: str | None = None):
    fig, ax = plt.subplots(figsize=(9, 4))
    for esc, r in resultados.items():
        m = r.medidor
        d = dia or str(m.index[0].date() + pd.Timedelta(days=1))
        s = m.loc[d, "p_total_kw"]
        ax.plot(s.index.hour + s.index.minute / 60, s.values, color=COLOR_ESC.get(esc, SERIES[4]),
                label=ETIQ.get(esc, esc), lw=2 if esc != "baseline" else 1.6)
    lim = next(iter(resultados.values())).cfg["ems"]["limite_demanda_kw"]
    ax.axhline(lim, color=TXT2, ls="--", lw=1)
    ax.text(0.3, lim + 2, f"límite de demanda {lim} kW", color=TXT2, fontsize=8)
    ax.set(xlabel="Hora del día", ylabel="Potencia total (kW)", xlim=(0, 24), xticks=range(0, 25, 3),
           title=f"Perfil de potencia por escenario — {d}")
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.32), ncol=4)
    _guardar(fig, ruta)


def desglose(tabla: pd.DataFrame, ruta: Path):
    usos = [("e_hvac_kwh", "HVAC"), ("e_luces_kwh", "Iluminación"), ("e_equipos_kwh", "Equipos + TI")]
    fig, ax = plt.subplots(figsize=(7, 3.6))
    izq = np.zeros(len(tabla))
    y = np.arange(len(tabla))
    for i, (col, nom) in enumerate(usos):
        v = tabla[col].values
        ax.barh(y, v, left=izq, color=SERIES[i], label=nom, height=0.55, edgecolor=SURF, linewidth=2)
        izq += v
    resto = tabla["energia_kwh"].values - izq
    ax.barh(y, resto, left=izq, color=SERIES[3], label="Cargas fijas", height=0.55, edgecolor=SURF, linewidth=2)
    for yi, tot in zip(y, tabla["energia_kwh"].values):
        ax.text(tot + 150, yi, f"{tot:,.0f} kWh", va="center", color=TXT2, fontsize=8)
    ax.set_yticks(y, [ETIQ.get(e, e) for e in tabla.index])
    ax.invert_yaxis()
    ax.set(xlabel="Energía semanal (kWh)", title="Desglose de energía por uso final (1 semana)")
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, -0.42), ncol=4)
    ax.grid(axis="y", visible=False)
    _guardar(fig, ruta)


def temperaturas(res, ruta: Path, dia: str | None = None):
    z = res.zonas.copy()
    z["ts"] = pd.to_datetime(z["ts"])
    d = dia or str(z["ts"].iloc[0].date() + pd.Timedelta(days=1))
    z = z[z["ts"].dt.strftime("%Y-%m-%d") == d]
    ids = sorted(z["zona"].unique())
    fig, axs = plt.subplots(2, 5, figsize=(12, 4.6), sharex=True, sharey=True)
    cfg = res.cfg["ems"]
    for ax, zid in zip(axs.flat, ids):
        s = z[z["zona"] == zid]
        h = s["ts"].dt.hour + s["ts"].dt.minute / 60
        ax.axhspan(cfg["confort_min_c"], cfg["confort_max_c"], color=SERIES[2], alpha=0.08, lw=0)
        ax.plot(h, s["temp_real_c"], color=SERIES[0], lw=1.6)
        ax.plot(h, s["setpoint_c"], color=TXT2, lw=1, ls="--")
        ax.set_title(f"{zid} · {s['nombre'].iloc[0][:18]}", fontsize=8.5)
        ax.set_xticks(range(0, 25, 6))
    fig.supxlabel("Hora", color=TXT2, fontsize=9)
    fig.supylabel("Temperatura (°C)", color=TXT2, fontsize=9)
    fig.suptitle(f"Temperatura real por zona (azul) y setpoint (gris) — {res.nombre}, {d}", fontsize=11,
                 fontweight="bold")
    _guardar(fig, ruta)


def pronostico_fig(serie: pd.DataFrame, met: pd.DataFrame, ruta: Path):
    fig, ax = plt.subplots(figsize=(10, 3.8))
    ax.plot(serie.index, serie["real"], color=TXT, lw=1.6, label="Real")
    for i, m in enumerate([c for c in serie.columns if c != "real"]):
        ax.plot(serie.index, serie[m], color=SERIES[i], lw=1.4, alpha=0.95,
                label=f"{m} (MAE {met.loc[m, 'mae_kw']:.1f} kW, RMSE {met.loc[m, 'rmse_kw']:.1f} kW)")
    ax.set(ylabel="Potencia horaria (kW)", title="Pronóstico del día siguiente — semana de validación")
    ax.legend(loc="upper left", ncol=2, fontsize=8)
    fig.autofmt_xdate()
    _guardar(fig, ruta)


def tornado(sens: pd.DataFrame, ruta: Path, metrica: str = "vpn_usd"):
    """Barra naranja = valor bajo del parámetro, azul = valor alto (orden de la tabla)."""
    ref = sens.loc[sens.parametro == "referencia", metrica].iloc[0]
    filas = []
    for p, g in sens[sens.parametro != "referencia"].groupby("parametro", sort=False):
        v = g[metrica].values - ref
        filas.append((p, v[0], v[-1], " → ".join(str(x) for x in g["valor"])))
    filas.sort(key=lambda f: max(abs(f[1]), abs(f[2])))
    fig, ax = plt.subplots(figsize=(8, 3.8))
    for i, (p, bajo, alto, vals) in enumerate(filas):
        ax.barh(i, bajo, color=SERIES[1], height=0.55, label="valor bajo" if i == 0 else None)
        ax.barh(i, alto, color=SERIES[0], height=0.55, label="valor alto" if i == 0 else None)
    ax.set_yticks(range(len(filas)), [f"{p}\n({v})" for p, _, _, v in filas], fontsize=8)
    ax.axvline(0, color=TXT2, lw=1)
    ax.set(xlabel=f"Variación del VPN respecto a la referencia ({ref:,.0f} USD)",
           title="Análisis de sensibilidad — VPN a 10 años")
    ax.legend(loc="lower right")
    ax.grid(axis="y", visible=False)
    _guardar(fig, ruta)


def auditoria(res_base, cfg: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Línea base por zona y uso, con clasificación crítica / no crítica."""
    paso_h = cfg["edificio"]["paso_min"] / 60
    z = res_base.zonas
    g = z.groupby(["zona", "nombre", "tipo", "critica"])[["p_hvac_kw", "p_luces_kw", "p_equipos_kw", "p_total_kw"]] \
        .sum().mul(paso_h).reset_index()
    g.columns = ["zona", "nombre", "tipo", "critica", "e_hvac_kwh", "e_luces_kwh", "e_equipos_kwh", "e_total_kwh"]
    area = {zz["id"]: zz["area"] for zz in cfg["zonas"]}
    dias = len(res_base.medidor) * paso_h / 24
    g["area_m2"] = g["zona"].map(area)
    g["eui_kwh_m2_anio"] = g["e_total_kwh"] / dias * 365 / g["area_m2"]
    g["participacion_pct"] = g["e_total_kwh"] / res_base.medidor["p_total_kw"].sum() / paso_h * 100
    g["clasificacion"] = np.where(g["critica"], "crítica", "no crítica (gestionable)")
    pico = z.groupby("zona")["p_total_kw"].max()
    g["p_max_kw"] = g["zona"].map(pico)
    # cargas del edificio (fijas)
    m = res_base.medidor
    e_fija = m["p_fija_kw"].sum() * paso_h
    cargas = []
    for cf in cfg.get("cargas_fijas", []):
        cargas.append({"carga": cf["nombre"], "clasificacion": "crítica" if cf.get("critica") else "no crítica"})
    uso = pd.DataFrame([
        {"uso": "HVAC (zonas no críticas)", "clasificacion": "no crítica / diferible",
         "e_kwh": g.loc[~g.critica, "e_hvac_kwh"].sum()},
        {"uso": "Iluminación (zonas no críticas)", "clasificacion": "no crítica / atenuable",
         "e_kwh": g.loc[~g.critica, "e_luces_kwh"].sum()},
        {"uso": "Enchufes y equipos (zonas no críticas)", "clasificacion": "no crítica / deslastrable",
         "e_kwh": g.loc[~g.critica, "e_equipos_kwh"].sum()},
        {"uso": "Servidores, seguridad, UPS (Z09, Z10)", "clasificacion": "crítica", "e_kwh": g.loc[g.critica, "e_total_kwh"].sum()},
        {"uso": "Ascensores, bombas, iluminación exterior", "clasificacion": "crítica / mixta", "e_kwh": e_fija},
    ])
    uso["participacion_pct"] = uso["e_kwh"] / uso["e_kwh"].sum() * 100
    uso["e_anual_mwh"] = uso["e_kwh"] / dias * 365 / 1000
    return g.round(3), uso.round(3)


def tabla_md(df: pd.DataFrame, dec: int = 2) -> str:
    df = df.reset_index() if df.index.name else df
    fmt = lambda v: f"{v:,.{dec}f}" if isinstance(v, (float, np.floating)) else str(v)
    filas = ["| " + " | ".join(map(str, df.columns)) + " |", "|" + "---|" * len(df.columns)]
    filas += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in df.itertuples(index=False)]
    return "\n".join(filas)


def escribir_resumen(ruta: Path, datos: dict):
    lineas = ["# Resumen de resultados (generado automáticamente)", ""]
    for seccion, contenido in datos.items():
        lineas.append(f"## {seccion}")
        lineas.append("")
        if isinstance(contenido, pd.DataFrame):
            lineas.append(tabla_md(contenido))
        elif isinstance(contenido, dict):
            for k, v in contenido.items():
                lineas.append(f"- **{k}**: {v:,.3f}" if isinstance(v, float) else f"- **{k}**: {v}")
        else:
            lineas.append(str(contenido))
        lineas.append("")
    ruta.write_text("\n".join(lineas), encoding="utf-8")


def guardar_json(ruta: Path, obj):
    ruta.write_text(json.dumps(obj, indent=2, ensure_ascii=False, default=float), encoding="utf-8")
