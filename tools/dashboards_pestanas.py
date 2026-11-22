"""Genera los dashboards con pestañas (esquema v2 de Grafana 13) desde las fuentes clásicas.

    GRAFANA_URL=http://host:3000 GRAFANA_USER=admin GRAFANA_PASSWORD=… python tools/dashboards_pestanas.py

Fuentes: deploy/arch/grafana/dashboards-src/ems-*.json (JSON clásico con filas; ahí se editan los paneles).
Salida:  deploy/arch/grafana/dashboards/ems-*.json (lo que provisiona Grafana).

Para cada fuente crea un dashboard temporal en Grafana, pide su conversión oficial v1 → v2 (API
dashboard.grafana.app/v2beta1), lo borra y reorganiza el resultado: las filas visibles forman la pestaña
«Resumen» y cada fila colapsada (detalle) pasa a su propia pestaña. La cuadrícula de cada fila se conserva tal
cual (posiciones y proporciones de los paneles), así que el diseño no cambia: sólo hay menos desplazamiento.
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SRC = RAIZ / "deploy" / "arch" / "grafana" / "dashboards-src"
OUT = RAIZ / "deploy" / "arch" / "grafana" / "dashboards"

# nombres cortos de las pestañas de detalle (título de la fila → pestaña)
PESTANAS = {
    "Detalle técnico · energía y estado del EMS": "Energía y EMS",
    "Detalle técnico · equipos de climatización (VRF/PTAC)": "Climatización",
    "Detalle por zona": "Por zona",
    "Sensores, consumo y entorno": "Sensores y entorno",
    "Detalle técnico · estado del EMS": "Estado del EMS",
    "Detalle · comparativa completa de KPI (28 días)": "Indicadores",
    "Detalle · semana elegida (usa los enlaces «Semana …» de la cabecera)": "Semana tipo",
}


def api(metodo: str, ruta: str, cuerpo: dict | None = None) -> dict:
    base = os.environ.get("GRAFANA_URL", "http://127.0.0.1:3000").rstrip("/")
    cred = base64.b64encode(f"{os.environ['GRAFANA_USER']}:{os.environ['GRAFANA_PASSWORD']}".encode()).decode()
    req = urllib.request.Request(base + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo else None,
                                 headers={"Authorization": f"Basic {cred}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def convertir_v2(clasico: dict) -> dict:
    """Conversión oficial de Grafana: sube una copia temporal, la lee en v2 y la borra."""
    tmp = dict(clasico, uid="tmp-conv-" + clasico["uid"][:24], title=clasico["title"] + " (conversión temporal)", id=None)
    tmp.pop("version", None)
    api("POST", "/api/dashboards/db", {"dashboard": tmp, "overwrite": True})
    try:
        d = api("GET", f"/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/{tmp['uid']}")
    finally:
        api("DELETE", f"/api/dashboards/uid/{tmp['uid']}")
    if d.get("status", {}).get("conversion", {}).get("failed"):
        raise SystemExit(f"{clasico['uid']}: Grafana no pudo convertirlo: {d['status']}")
    return d


def apilar(grids: list[dict]) -> dict:
    """Une varias cuadrículas una debajo de otra."""
    items, y0 = [], 0
    for g in grids:
        alto = 0
        for it in g["spec"]["items"]:
            s = dict(it["spec"], y=it["spec"]["y"] + y0)
            items.append({"kind": "GridLayoutItem", "spec": s})
            alto = max(alto, it["spec"]["y"] + it["spec"]["height"])
        y0 += alto
    return {"kind": "GridLayout", "spec": {"items": items}}


def a_pestanas(layout: dict) -> dict:
    if layout["kind"] != "RowsLayout":
        return layout
    visibles, tabs = [], []
    for row in layout["spec"]["rows"]:
        s = row["spec"]
        if s.get("collapse"):
            titulo = PESTANAS.get(s.get("title", ""), s.get("title", "Detalle"))
            tabs.append({"kind": "TabsLayoutTab", "spec": {"title": titulo, "layout": s["layout"]}})
        else:
            visibles.append(s["layout"])
    resumen = {"kind": "TabsLayoutTab", "spec": {"title": "Resumen", "layout": apilar(visibles)}}
    return {"kind": "TabsLayout", "spec": {"tabs": [resumen] + tabs}}


def main():
    for f in sorted(SRC.glob("ems-*.json")):
        clasico = json.loads(f.read_text())
        d = convertir_v2(clasico)
        spec = d["spec"]
        spec["title"] = clasico["title"]
        spec["layout"] = a_pestanas(spec["layout"])
        out = {"apiVersion": d["apiVersion"], "kind": "Dashboard", "metadata": {"name": clasico["uid"]}, "spec": spec}
        (OUT / f.name).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
        tabs = [t["spec"]["title"] for t in spec["layout"]["spec"].get("tabs", [])]
        print(f"{f.name}: {len(spec['elements'])} paneles, pestañas: {', '.join(tabs)}")


if __name__ == "__main__":
    main()
