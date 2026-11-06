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


def test_parametros_del_modelo_energyplus(cfg):
    zs = {z.id: z for z in config.zonas(cfg)}
    assert sum(z.area for z in zs.values()) == pytest.approx(800)
    assert {z.planta for z in zs.values()} == {0, 1}
    # UA de la Oficina 1: muros opacos (27−20.25)+(30−22.5) m² × 0.86 + vidrio 42.75 m² × 6.424 + techo 90 m² × 0.274
    ua_w = ((27 - 20.25) + (30 - 22.5)) * 0.86 + 42.75 * 6.424 + 90 * 0.274
    assert zs["Z04"].ua == pytest.approx(ua_w / 1000, rel=1e-6)
    assert zs["Z04"].ua_suelo == 0 and zs["Z02"].ua_suelo == pytest.approx(2.945 * 170 / 1000)
    # capacidades de los terminales VRF suman la de cada sistema
    for s in cfg["sistemas_vrf"]:
        assert sum(zs[z].hvac_kw for z in s["zonas"]) == pytest.approx(s["capacidad_kw"], abs=0.05)


def test_horarios_del_modelo(cfg):
    # SCH_Ocupacion_Oficinas: 1.0 entre 9 y 12; 0 de noche y los domingos
    assert config.horario(cfg, "ocupacion", 2, 10.5) == 1.0
    assert config.horario(cfg, "ocupacion", 2, 3.0) == 0.0
    assert config.horario(cfg, "ocupacion", 6, 10.0) == 0.0
    assert config.horario(cfg, "ac_oficinas", 0, 8.0) == 22 and config.horario(cfg, "ac_oficinas", 0, 19.0) == 28
    assert config.horario(cfg, "ac_conferencia", 0, 6.5) == 22
    assert config.horario(cfg, "continuo", 6, 3.0) == 1.0


def test_irradiancia_por_fachada(cfg):
    from ems import clima

    idx = clima.indice("2006-03-21", 1, 60)
    c = clima.generar(cfg, idx)
    manana, tarde = c.loc["2006-03-21 09:00"], c.loc["2006-03-21 16:00"]
    assert manana["irr_E"] > manana["irr_W"] and tarde["irr_W"] > tarde["irr_E"]
    assert c["irr_H"].max() > 700 and c.loc["2006-03-21 02:00", "irr_H"] == 0


def test_humedad_absoluta():
    from ems.edificio import humedad_absoluta

    assert humedad_absoluta(24, 55) == pytest.approx(0.0102, abs=4e-4)
    assert humedad_absoluta(30, 80) > humedad_absoluta(30, 50)


def test_termostato_vrf_histeresis_y_modulacion(cfg):
    from ems.edificio import PLR_MIN, modulacion_termostato

    assert modulacion_termostato(24.4, 24, 0.5, False) == (0.0, False)  # dentro de la banda: sigue apagado
    mod, on = modulacion_termostato(24.6, 24, 0.5, False)               # sobre sp + banda: enciende
    assert on and 0.5 < mod <= 1
    mod, on = modulacion_termostato(23.8, 24, 0.5, True)                # sobre sp − banda: sigue encendido
    assert on and mod == pytest.approx(PLR_MIN)
    assert modulacion_termostato(23.4, 24, 0.5, True) == (0.0, False)   # bajo sp − banda: apaga
    assert modulacion_termostato(27.0, 24, 0.5, True)[0] == 1.0          # capacidad plena


def test_planta_baja_mas_fria_por_el_terreno(cfg):
    ed = Edificio(cfg)
    ed.aplicar({zid: {"hvac_enable": False} for zid in ed.estado})
    for _ in range(288 * 3):
        ed.paso({"t_ext_c": 27.0, "irr_wm2": 0.0, "hr_pct": 80}, {}, 120, 6)
    pb, pa = ed.estado["Z02"].t, ed.estado["Z04"].t
    t_suelo, t_ext = cfg["edificio"]["t_suelo_c"], 27.0
    assert t_suelo < pb < pa < t_ext + 1


def test_zonas_criticas_no_se_deslastran(cfg):
    ed = Edificio(cfg)
    ed.aplicar({"Z09": {"hvac_enable": False, "equipos_nivel": 0.0, "setpoint_c": 28}})
    s = ed.estado["Z09"]
    assert s.hvac_enable is True and s.equipos_nivel == 1.0 and ed.zmap["Z09"].setpoint_fijo == 24.0


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
    assert eco["ahorro_pct"] > 20
    assert eco["pico_evitado_kw"] > 8
    assert ke["demanda_max_15min_kw"] <= cfg["ems"]["limite_demanda_kw"] * 1.05
    assert ke["confort_pct"] >= kb["confort_pct"] - 1
    assert ke["servidores_ok_pct"] == 100
    assert 0 < eco["payback_anios"] < cfg["economia"]["vida_util_anios"]


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
    assert met.loc["regresion", "rmse_kw"] < 0.15 * hist.medidor.p_total_kw.mean() + 2
    assert met.loc["regresion", "mae_kw"] <= met.loc["persistencia", "mae_kw"] * 1.1


def test_sensor_congelado_detectado_y_modo_seguro(cfg):
    r = simular(cfg, "reglas_dr", dias=2,
                anomalias=[Anomalia("sensor", 33, 37, "Z02", {"tipo": "congelado"})])
    assert "SENSOR_CONGELADO" in set(r.alarmas.codigo)
    z = r.zonas[(r.zonas.zona == "Z02")]
    ts = pd.to_datetime(z.ts)
    w = z[(ts >= "2026-11-03 09:30") & (ts < "2026-11-03 13:00")]
    assert w.temp_real_c.max() < 27.0


def test_limitador_demanda_responde_a_pico(cfg):
    r = simular(cfg, "reglas_dr", dias=2, anomalias=[Anomalia("carga_extra", 37, 39, "Z07", {"kw": 12.0})])
    e = r.estado
    act = e[(pd.to_datetime(e.ts) >= "2026-11-03 13:00") & e.dr_activo]
    assert len(act) > 0
    assert (pd.to_datetime(act.ts.iloc[0]) - pd.Timestamp("2026-11-03 13:00", tz="America/Panama")) <= pd.Timedelta(minutes=10)


def test_metricas_ashrae_g14():
    from ems.validacion import metricas

    ref = pd.Series([10.0, 20.0, 30.0, 40.0])
    assert metricas(ref, ref)["nmbe_pct"] == 0 and metricas(ref, ref)["cumple_g14"]
    m = metricas(ref, ref * 1.2)
    assert m["nmbe_pct"] == pytest.approx(-100 * (0.2 * 100) / (3 * 25))  # (Σ(ref − modelo))/((n−1)·media)
    assert not m["cumple_g14"]


@pytest.mark.skipif(not (config.RAIZ / "data" / "energyplus" / "electricidad_10min.csv").exists(),
                    reason="faltan los datos de EnergyPlus")
def test_validacion_contra_energyplus_cumple_g14(cfg):
    from ems import validacion

    c = validacion.comparar(cfg, "2006-08-13", 8)
    assert c["electricidad_total"]["cumple_g14"], c["electricidad_total"]
    assert abs(c["pico_kw"]["modelo"] / c["pico_kw"]["energyplus"] - 1) < 0.15
    ref = validacion.cargar_energyplus()["resumen"]
    assert ref["energia_anual_kwh"]["Total End Uses"] == pytest.approx(143994, rel=1e-3)


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
