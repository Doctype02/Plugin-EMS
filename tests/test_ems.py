"""Pruebas unitarias y de regresión del EMS (pytest -q)."""
import math
import shutil

import numpy as np
import pandas as pd
import pytest

from ems import config, control, kpi, pronostico
from ems.edificio import Edificio
from ems.simulacion import Anomalia, simular


@pytest.fixture(scope="module")
def cfg():
    return config.cargar()


@pytest.fixture(scope="module")
def semana(cfg):
    return {c: simular(cfg, c, dias=7) for c in ("baseline", "reglas_dr")}


def test_config_10_zonas(cfg):
    zs = config.zonas(cfg)
    assert len(zs) == 10
    assert {z.id for z in zs if z.critica} == {"Z09", "Z10"}


def test_balance_termico_sin_cargas_tiende_a_exterior(cfg):
    ed = Edificio(cfg)
    for z in ed.estado.values():
        z.hvac_enable = False
        z.luces_nivel = 0
        z.equipos_nivel = 0
    ed.aplicar({zid: {"hvac_enable": False} for zid in ed.estado})
    t0 = ed.estado["Z02"].t
    for _ in range(288 * 3):
        ed.paso({"t_ext_c": 30.0, "irr_wm2": 0.0, "hr_pct": 70}, {}, 0)
    # sin HVAC ni sol, la zona de oficinas converge hacia T exterior + ganancias internas mínimas
    assert ed.estado["Z02"].t > t0
    assert abs(ed.estado["Z02"].t - 30.0) < 3.0


def test_termostato_histeresis(cfg):
    ed = Edificio(cfg)
    ed.aplicar({"Z02": {"setpoint_c": 24.0, "hvac_enable": True}})
    s = ed.estado["Z02"]
    s.t_medida = 24.4  # dentro de la banda: no cambia
    ed.paso({"t_ext_c": 31, "irr_wm2": 500, "hr_pct": 70}, {"Z02": 20}, 600)
    assert s.hvac_on is False
    s.t_medida = 24.6  # sobre sp + banda: enciende
    ed.paso({"t_ext_c": 31, "irr_wm2": 500, "hr_pct": 70}, {"Z02": 20}, 605)
    assert s.hvac_on is True
    s.t_medida = 23.8  # aún sobre sp - banda: sigue encendido
    ed.paso({"t_ext_c": 31, "irr_wm2": 500, "hr_pct": 70}, {"Z02": 20}, 610)
    assert s.hvac_on is True
    s.t_medida = 23.4  # bajo sp - banda: apaga
    ed.paso({"t_ext_c": 31, "irr_wm2": 500, "hr_pct": 70}, {"Z02": 20}, 615)
    assert s.hvac_on is False


def test_zonas_criticas_no_se_deslastran(cfg):
    ed = Edificio(cfg)
    ed.aplicar({"Z09": {"hvac_enable": False, "equipos_nivel": 0.0, "setpoint_c": 28}})
    s = ed.estado["Z09"]
    assert s.hvac_enable is True and s.equipos_nivel == 1.0 and ed.zmap["Z09"].setpoint_fijo == 22.0


def test_medidor_electrico_consistente(cfg, semana):
    m = semana["baseline"].medidor
    assert np.allclose(m.s_kva, np.hypot(m.p_total_kw, m.q_kvar), atol=1e-2)
    i = m.s_kva * 1000 / (math.sqrt(3) * cfg["edificio"]["v_ll"])
    assert np.allclose(m.i_a, i, atol=0.05)
    assert ((m.fp > 0.8) & (m.fp <= 1)).all()
    assert np.isclose(m.e_kwh.iloc[-1], m.p_total_kw.sum() * 5 / 60, rtol=1e-3)


def test_ems_ahorra_y_reduce_pico_manteniendo_confort(cfg, semana):
    kb = kpi.energeticos(semana["baseline"], cfg)
    ke = kpi.energeticos(semana["reglas_dr"], cfg)
    eco = kpi.economia(kb, ke, cfg)
    assert eco["ahorro_pct"] > 15
    assert eco["pico_evitado_kw"] > 20
    assert ke["demanda_max_15min_kw"] <= cfg["ems"]["limite_demanda_kw"] * 1.03
    assert ke["confort_pct"] >= kb["confort_pct"]
    assert ke["servidores_ok_pct"] == 100
    assert 0 < eco["payback_anios"] < eco.get("vida", 10)


def test_economia_casos_limite(cfg, semana):
    kb = kpi.energeticos(semana["baseline"], cfg)
    eco = kpi.economia(kb, kb, cfg)  # sin ahorro
    assert eco["energia_ahorrada_anual_kwh"] == 0
    assert eco["costo_kwh_evitado_usd"] == float("inf")
    assert eco["vpn_usd"] < 0


def test_pronostico_metricas():
    m = pronostico.metricas([10, 20, 30], [12, 18, 33])
    assert m["mae_kw"] == pytest.approx(7 / 3)
    assert m["rmse_kw"] == pytest.approx(math.sqrt((4 + 4 + 9) / 3))


def test_pronostico_regresion_mejor_que_persistencia(cfg):
    hist = simular(cfg, "reglas_dr", dias=28, inicio="2026-10-05")
    _, met = pronostico.evaluar(hist.medidor, dias_prueba=7, usar_sarimax=False)
    assert met.loc["regresion", "mape_pct"] < 10
    assert met.loc["regresion", "mae_kw"] <= met.loc["persistencia", "mae_kw"] * 1.1


def test_sensor_congelado_detectado_y_modo_seguro(cfg):
    r = simular(cfg, "reglas_dr", dias=2,
                anomalias=[Anomalia("sensor", 33, 37, "Z03", {"tipo": "congelado"})])
    assert "SENSOR_CONGELADO" in set(r.alarmas.codigo)
    z = r.zonas[(r.zonas.zona == "Z03")]
    ts = pd.to_datetime(z.ts)
    w = z[(ts >= "2026-11-03 09:30") & (ts < "2026-11-03 13:00")]
    assert w.temp_real_c.max() < 27.0


def test_limitador_demanda_responde_a_pico(cfg):
    r = simular(cfg, "reglas_dr", dias=2, anomalias=[Anomalia("carga_extra", 37, 39, "Z07", {"kw": 40.0})])
    e = r.estado
    act = e[(pd.to_datetime(e.ts) >= "2026-11-03 13:00") & e.dr_activo]
    assert len(act) > 0
    assert (pd.to_datetime(act.ts.iloc[0]) - pd.Timestamp("2026-11-03 13:00", tz="America/Panama")) <= pd.Timedelta(minutes=10)


def test_latencia_logica(cfg, semana):
    assert np.percentile(semana["reglas_dr"].latencia_ms, 99) < 50


@pytest.mark.skipif(shutil.which("node") is None, reason="requiere Node.js")
def test_paridad_python_nodered(cfg):
    from ems.nodered import ControladorNodeRed

    c = ControladorNodeRed(cfg)
    rn = simular(cfg, c, dias=2, nombre="nodered")
    c.cerrar()
    rp = simular(cfg, "reglas_dr", dias=2)
    assert np.allclose(rn.medidor.p_total_kw.values, rp.medidor.p_total_kw.values)
    assert sorted(rn.alarmas.codigo) == sorted(rp.alarmas.codigo)


def test_influx_esquema(cfg, semana, monkeypatch):
    pytest.importorskip("influxdb_client")
    from ems.influx import Escritor, exportar_resultado

    esc = Escritor(url="http://x:8086", token="t")
    escritos = []
    monkeypatch.setattr(esc.api, "write", lambda bucket, org, record: escritos.extend(record))
    r = semana["reglas_dr"]
    sub = type(r)(r.nombre, r.zonas.head(20), r.medidor.head(2), r.alarmas.head(3), r.estado.head(2), r.latencia_ms, cfg)
    exportar_resultado(esc, sub, "reglas_dr")
    lp = [p.to_line_protocol() for p in escritos]
    assert any(l.startswith("zona,") and "zona=Z01" in l and "temp_c=" in l for l in lp)
    assert any(l.startswith("medidor,") and "p_total_kw=" in l and "escenario=reglas_dr" in l for l in lp)
    assert any(l.startswith("ems,") and "dr_activo=" in l for l in lp)


def test_precio_tarifa_horaria(cfg):
    lun_10 = pd.Timestamp("2026-11-02 10:00", tz="America/Panama")
    dom_10 = pd.Timestamp("2026-11-08 10:00", tz="America/Panama")
    assert control.precio(cfg, lun_10) == cfg["tarifa"]["precio_punta_usd_kwh"]
    assert control.precio(cfg, dom_10) == cfg["tarifa"]["precio_fuera_punta_usd_kwh"]
