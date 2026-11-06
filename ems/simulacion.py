"""Ejecutor de simulaciones: une clima + ocupación + edificio + controlador + anomalías."""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import clima as m_clima
from . import ocupacion as m_ocup
from .config import zonas
from .control import Controlador, crear, precio
from .edificio import Edificio

INICIO_DEFECTO = "2026-11-02 00:00"  # lunes


@dataclass
class Anomalia:
    """Perturbación con ventana temporal [inicio, fin) en horas desde el inicio de la simulación."""
    tipo: str            # ola_calor | ocupacion_extra | sensor | falla_hvac | carga_extra | perdida_comandos
    inicio_h: float = 0.0
    fin_h: float = 1e9
    zona: str | None = None
    params: dict = field(default_factory=dict)

    def activa(self, h: float) -> bool:
        return self.inicio_h <= h < self.fin_h


@dataclass
class Resultado:
    nombre: str
    zonas: pd.DataFrame
    medidor: pd.DataFrame
    alarmas: pd.DataFrame
    estado: pd.DataFrame
    latencia_ms: np.ndarray
    cfg: dict


def simular(cfg: dict, controlador: str | Controlador, dias: float = 7, inicio: str = INICIO_DEFECTO,
            anomalias: list[Anomalia] | None = None, nombre: str | None = None,
            factor_ocupacion: float = 1.0, semilla: int = 3, callback=None,
            calentamiento_h: float = 24.0) -> Resultado:
    """Simula `dias` desde `inicio`. Antes se simulan `calentamiento_h` horas que se descartan (como los
    días de warmup de EnergyPlus) para que las temperaturas y los actuadores partan de un estado real."""
    anomalias = anomalias or []
    ctrl = crear(controlador, cfg) if isinstance(controlador, str) else controlador
    nombre = nombre or ctrl.nombre
    paso = cfg["edificio"]["paso_min"]
    t_inicio = pd.Timestamp(inicio)
    t_inicio = t_inicio.tz_localize(cfg["edificio"]["zona_horaria"]) if t_inicio.tzinfo is None else t_inicio
    idx = m_clima.indice(t_inicio - pd.Timedelta(hours=calentamiento_h), dias + calentamiento_h / 24, paso,
                         cfg["edificio"]["zona_horaria"])
    n_cal = int(round(calentamiento_h * 60 / paso))
    dt_ext = sum(a.params.get("delta_c", 3.0) for a in anomalias if a.tipo == "ola_calor")
    cl = m_clima.generar(cfg, idx)
    if dt_ext:
        h_arr = (idx - idx[0]).total_seconds().values / 3600
        mask = np.zeros(len(idx), bool)
        for a in anomalias:
            if a.tipo == "ola_calor":
                mask |= (h_arr >= a.inicio_h) & (h_arr < a.fin_h)
        cl.loc[mask, "t_ext_c"] += dt_ext
        cl.loc[mask, "irr_wm2"] *= 1.10
    oc = m_ocup.generar(zonas(cfg), idx, cfg["ocupacion"], factor_ocupacion, cfg=cfg)

    ed = Edificio(cfg, rng_semilla=semilla)
    rng = np.random.default_rng(semilla + 100)
    filas_z, filas_m, filas_e, alarmas, lat = [], [], [], [], []
    tel, med = None, None
    clima_reg = cl.to_dict("records")
    ocup_reg = oc.to_dict("records")
    for i, t in enumerate(idx):
        h = (i - n_cal) * paso / 60.0          # horas desde `inicio` (negativas durante el calentamiento)
        registrar = i >= n_cal
        if i == n_cal:
            ed.e_kwh = 0.0
        # --- anomalías físicas y de sensores
        ed.carga_extra_kw = {}
        ed.falla_hvac = set()
        sensores_activos = set()
        ocup = dict(ocup_reg[i])
        p_perdida = 0.0
        for a in anomalias:
            if not a.activa(h):
                if a.tipo == "sensor" and a.zona in ed.falla_sensor and a.zona not in sensores_activos:
                    ed.falla_sensor.pop(a.zona, None)
                continue
            if a.tipo == "carga_extra":
                ed.carga_extra_kw[a.zona] = ed.carga_extra_kw.get(a.zona, 0) + a.params.get("kw", 30.0)
            elif a.tipo == "falla_hvac":
                ed.falla_hvac.add(a.zona)
            elif a.tipo == "sensor":
                sensores_activos.add(a.zona)
                ed.falla_sensor.setdefault(a.zona, dict(a.params))
            elif a.tipo == "ocupacion_extra":
                ocup[a.zona] = max(ocup.get(a.zona, 0), a.params.get("personas", 20))
            elif a.tipo == "perdida_comandos":
                p_perdida = a.params.get("prob", 0.3)

        # --- control (usa la telemetría del paso anterior)
        if tel is not None:
            t0 = time.perf_counter()
            cmds = ctrl.decidir(t, tel, med)
            if registrar:
                lat.append((time.perf_counter() - t0) * 1000)
            if p_perdida:
                cmds = {k: v for k, v in cmds.items() if rng.random() >= p_perdida}
            ed.aplicar(cmds)
            if registrar:
                alarmas.extend(ctrl.alarmas)
                est = ctrl.estado(t)
                est["modo_seguro"] = len(est["modo_seguro"])
                filas_e.append(est)

        tel, med = ed.paso(clima_reg[i], ocup, t.hour * 60 + t.minute, t.dayofweek)
        med["precio_usd_kwh"] = precio(cfg, t)
        med["ts"] = t
        for z in tel:
            z["ts"] = t
        if not registrar:
            continue
        filas_z.extend(tel)
        filas_m.append(med)
        if callback:
            callback(t, tel, med, ctrl)

    dz = pd.DataFrame(filas_z)
    dm = pd.DataFrame(filas_m).set_index("ts")
    da = pd.DataFrame(alarmas, columns=["ts", "nivel", "codigo", "zona", "mensaje", "valor"])
    de = pd.DataFrame(filas_e)
    return Resultado(nombre, dz, dm, da, de, np.array(lat), cfg)
