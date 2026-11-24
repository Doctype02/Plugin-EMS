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


def test_config_26_zonas(cfg):
    zs = config.zonas(cfg)
    assert len(zs) == 26
    assert {z.id for z in zs if z.critica} == {"Z06"}
    assert config.nombres_plantas(cfg) == ["PB", "P1", "P2", "P3", "P4"]


def test_parametros_del_modelo_energyplus(cfg):
    zs = {z.id: z for z in config.zonas(cfg)}
    assert sum(z.area for z in zs.values()) == pytest.approx(1980)  # Net Conditioned Building Area de E+
    assert {z.planta for z in zs.values()} == {0, 1, 2, 3, 4}
    # UA de la Oficina 1 P4 (Z22): muros opacos (30−24)+(27−21.6) m² × 2.478 + vidrio 45.6 m² × 5.708 + techo 90 m² × 0.605
    ua_w = ((30 - 24) + (27 - 21.6)) * 2.478 + 45.6 * 5.708 + 90 * 0.605
    assert zs["Z22"].ua == pytest.approx(ua_w / 1000, rel=1e-6)
    assert zs["Z22"].ua_suelo == 0 and zs["Z02"].ua_suelo == pytest.approx(4.02 * 180 / 1000)
    # losas interiores: la PB sólo acopla hacia arriba, la P4 sólo hacia abajo, las intermedias a ambos lados
    assert zs["Z02"].ua_abajo == 0 and zs["Z02"].ua_arriba > 0
    assert zs["Z22"].ua_arriba == 0 and zs["Z22"].ua_abajo > 0
    assert zs["Z12"].ua_arriba > 0 and zs["Z12"].ua_abajo > 0
    # capacidades de los terminales VRF suman la de cada sistema
    for s in cfg["sistemas_vrf"]:
        assert sum(zs[z].hvac_kw for z in s["zonas"]) == pytest.approx(s["capacidad_kw"], abs=0.05)


def test_horarios_del_modelo(cfg):
    # BASE_Ocupacion: 1.0 de 8 a 18 h entre semana; 0 de noche y el fin de semana
    assert config.horario(cfg, "ocupacion", 2, 10.5) == 1.0
    assert config.horario(cfg, "ocupacion", 2, 3.0) == 0.0
    assert config.horario(cfg, "ocupacion", 6, 10.0) == 0.0
    # TEMP_Refrigeracion: 22 °C las 24 h (el modelo sin EMS no tiene retroceso nocturno); baños 24 °C
    assert config.horario(cfg, "ac_oficinas", 0, 8.0) == 22 and config.horario(cfg, "ac_oficinas", 0, 19.0) == 22
    assert config.horario(cfg, "ac_banos", 3, 12.0) == 24
    assert config.horario(cfg, "elevador", 1, 9.0) == 0.2 and config.horario(cfg, "elevador", 6, 9.0) == 0.05
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
    # con el terreno del modelo E+ (18 °C) la losa enfría la planta baja
    from ems.validacion import condiciones_energyplus

    cfg = condiciones_energyplus(cfg)
    ed = Edificio(cfg)
    ed.aplicar({zid: {"hvac_enable": False, "luces_nivel": 0.0} for zid in ed.estado})
    for _ in range(288 * 3):
        ed.paso({"t_ext_c": 27.0, "irr_wm2": 0.0, "hr_pct": 80}, {}, 120, 6)
    pb, pa = ed.estado["Z02"].t, ed.estado["Z12"].t
    t_suelo, t_ext = cfg["edificio"]["t_suelo_c"], 27.0
    assert t_suelo < pb < pa < t_ext + 1


def test_zonas_criticas_no_se_deslastran(cfg):
    ed = Edificio(cfg)
    ed.aplicar({"Z06": {"hvac_enable": False, "equipos_nivel": 0.0, "setpoint_c": 28}})
    s = ed.estado["Z06"]
    assert s.hvac_enable is True and s.equipos_nivel == 1.0 and ed.zmap["Z06"].setpoint_fijo == 22.0


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
    hist = simular(cfg, "reglas_dr", dias=42, inicio="2026-09-21")
    _, met = pronostico.evaluar(hist.medidor, dias_prueba=7, usar_sarimax=False)
    assert met.loc["regresion", "rmse_kw"] < 0.15 * hist.medidor.p_total_kw.mean() + 2
    # los horarios del modelo nuevo son deterministas: la persistencia semanal es una referencia exigente
    assert met.loc["regresion", "mae_kw"] <= met.loc["persistencia", "mae_kw"] * 1.25


def test_sensor_congelado_detectado_y_modo_seguro(cfg):
    r = simular(cfg, "reglas_dr", dias=2,
                anomalias=[Anomalia("sensor", 33, 37, "Z02", {"tipo": "congelado"})])
    assert "SENSOR_CONGELADO" in set(r.alarmas.codigo)
    z = r.zonas[(r.zonas.zona == "Z02")]
    ts = pd.to_datetime(z.ts)
    w = z[(ts >= "2026-11-03 09:30") & (ts < "2026-11-03 13:00")]
    assert w.temp_real_c.max() < 27.0


def test_limitador_demanda_responde_a_pico(cfg):
    # el limitador ve el consumo completo; límite bajo para forzar el pico (el edificio no llega a 170 kW)
    sin_fv = config.aplicar(cfg, {"fv.habilitado": False, "ems.limite_demanda_kw": 90})
    r = simular(sin_fv, "reglas_dr", dias=2, anomalias=[Anomalia("carga_extra", 37, 39, "Z13", {"kw": 25.0})])
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
    assert ref["energia_anual_kwh"]["Total End Uses"] == pytest.approx(552472, rel=1e-3)
    # fotovoltaica de la variante ConPV: mismo modelo que PhotovoltaicPerformance:Simple
    assert c["fv"]["cumple_g14"] and abs(c["fv"]["nmbe_pct"]) < 3, c["fv"]


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


def test_estado_live_se_restaura(cfg, tmp_path, monkeypatch):
    from ems.edificio import Edificio
    from ems.live import Puente

    a = Edificio(cfg)
    a.estado["Z08"].t, a.estado["Z08"].hvac_on, a.e_kwh, a._hist_p = 23.1, True, 812.5, [40.0, 41.0, 42.0]
    b = Edificio(cfg)
    assert b.restaurar_estado(a.exportar_estado()) == len(a.estado)
    assert b.estado["Z08"].t == 23.1 and b.estado["Z08"].hvac_on and b.e_kwh == 812.5 and b._hist_p == [40.0, 41.0, 42.0]

    ruta = tmp_path / "estado.json"
    monkeypatch.setenv("EMS_ESTADO", str(ruta))
    p = Puente.__new__(Puente)
    p.edif, p.tz = "edificio1", cfg["edificio"]["zona_horaria"]
    t = pd.Timestamp("2026-11-16 10:00", tz=p.tz)
    p._guardar(a, t)
    c = Edificio(cfg)
    p._restaurar(c, t + pd.Timedelta(minutes=10))
    assert c.estado["Z08"].t == 23.1 and c.e_kwh == 812.5
    d = Edificio(cfg)
    p._restaurar(d, t + pd.Timedelta(hours=12))  # demasiado antiguo: arranque normal
    assert d.e_kwh == 0.0


def test_fin_de_semana_aire_apagado_sigue_al_clima(cfg, semana):
    """Sábado y domingo el aire está apagado: la temperatura deriva con el exterior (no se queda fija)."""
    r = semana["reglas_dr"]
    z = r.zonas.copy()
    z["ts"] = pd.to_datetime(z["ts"])
    finde = z[(z.ts.dt.dayofweek >= 5) & ~z.critica]
    assert (finde.hvac_on.mean()) < 0.05                       # casi sin compresores (sólo protección)
    media = finde.groupby("ts").temp_real_c.mean()
    assert media.max() - media.min() > 2.5                     # sube de día y baja de noche
    assert finde.temp_real_c.max() <= cfg["ems"]["t_proteccion_max_c"] + 1.0
    # el interior responde al exterior con retraso por la masa térmica: el máximo llega después del exterior
    sab = media[media.index.dayofweek == 5]
    t_ext = r.medidor.t_ext_c[r.medidor.index.dayofweek == 5]
    assert sab.idxmax() > t_ext.idxmax()


def test_arranque_escalonado_y_rampa_de_setpoint(cfg, semana):
    r = semana["reglas_dr"]
    reglas = pd.DataFrame(list(r.estado.reglas))
    assert reglas.arranques.max() <= cfg["ems"]["arranques_max_paso"]
    assert reglas.arranque_espera.max() > 0                    # el pre-enfriamiento sí tuvo que esperar turno
    z = r.zonas[~r.zonas.critica].copy()
    paso_c = cfg["ems"]["rampa_setpoint_c_h"] * cfg["edificio"]["paso_min"] / 60
    saltos = z.sort_values("ts").groupby("zona").apply(
        lambda g: g.setpoint_c.diff().abs()[g.hvac_enable & g.hvac_enable.shift(fill_value=False)].max())
    assert saltos.max() <= paso_c + 1e-6                       # sin escalones de consigna
    # la potencia sube de forma gradual en el pre-enfriamiento (sin el escalón de todos los compresores juntos)
    m = r.medidor
    manana = m[(m.index.dayofweek < 5) & (m.index.hour >= 6) & (m.index.hour < 9)]
    assert manana.p_total_kw.diff().max() < 15


def _corte(cfg, ctrl="reglas_dr", inicio="2026-11-05 09:00", horas=6, falla_gen=False):
    """Simula un corte de red (con la planta de respaldo, o sin ella si `falla_gen`)."""
    from ems import clima as m_clima, ocupacion as m_ocup

    ini = pd.Timestamp(inicio, tz="America/Panama")
    idx = m_clima.indice((ini - pd.Timedelta(hours=30)).strftime("%Y-%m-%d %H:%M"), (30 + horas + 2) / 24, 5, "America/Panama")
    cl = m_clima.generar(cfg, idx).to_dict("records")
    oc = m_ocup.generar(config.zonas(cfg), idx, cfg["ocupacion"], cfg=cfg).to_dict("records")
    ed, c = Edificio(cfg), control.crear(ctrl, cfg)
    tel = med = None
    meds, zonas_ = [], []
    for i, t in enumerate(idx):
        if t == ini:
            ed.iniciar_evento({"evento": "corte_energia", "duracion_min": horas * 60, "id": "corte"})
            if falla_gen:
                ed.iniciar_evento({"evento": "falla_generador", "duracion_min": horas * 60, "id": "gen"})
        if tel is not None:
            ed.aplicar(c.decidir(t, tel, med))
        tel, med = ed.paso(cl[i], oc[i], t.hour * 60 + t.minute, t.dayofweek)
        meds.append({**med, "ts": t})
        zonas_.extend({**z, "ts": t} for z in tel)
    m = pd.DataFrame(meds).set_index("ts")
    z = pd.DataFrame(zonas_)
    fin = ini + pd.Timedelta(hours=horas) - pd.Timedelta(minutes=5)
    return m.loc[ini:fin], z[(z.ts >= ini) & (z.ts <= fin)], m.loc[fin + pd.Timedelta(minutes=5):]


def test_corte_con_planta_de_respaldo_y_paneles(cfg):
    g = cfg["respaldo"]["generador"]
    em = cfg["respaldo"]["emergencia"]
    m, z, despues = _corte(cfg)
    assert (m.modo_energia == "generador").all() and not m.red_ok.any()
    assert (m.p_red_kw == 0).all()                                   # nada de la acometida
    # balance: carga = planta + paneles; los paneles siguen aportando (tras la reconexión)
    assert np.allclose(m.p_total_kw, m.p_gen_kw + m.p_fv_kw, atol=1e-2)
    assert m.p_fv_kw.iloc[0] == 0 and m.p_fv_kw.max() > 5
    # la planta nunca baja de su carga mínima por culpa de los paneles ni pasa de su carga máxima
    con_fv = m[m.p_fv_kw > 0.01]
    assert (con_fv.p_gen_kw >= g["carga_min"] * g["potencia_kw"] - 1e-6).all()
    assert m.p_gen_kw.max() <= g["carga_max"] * g["potencia_kw"] + 3
    assert m.p_gen_kw.diff().max() < 20                              # toma de carga gradual
    # consumo de diésel coherente con la curva de la planta
    litros = g["tanque_l"] - m.gen_combustible_l.iloc[-1]
    esperado = (g["consumo_vacio_l_h_kw"] * g["potencia_kw"] * len(m) + g["consumo_l_kwh"] * m.p_gen_kw.sum()) / 12
    assert litros == pytest.approx(esperado, rel=0.02)
    # tablero de emergencia: sin tomacorrientes de oficina ni PTAC; ascensor y servidores con servicio
    nc = z[~z.critica]
    assert nc.p_equipos_kw.max() == 0 and z[z.tipo == "bano"].p_hvac_kw.max() == 0
    assert m.p_fija_kw.max() > 1 and z[z.critica].temp_real_c.max() < cfg["ems"]["alarma_servidor_c"]
    # reglas de emergencia: luces ≤ 70 %, consigna ≥ 25 °C con ocupación, pasillos sin aire
    estable = nc[nc.ts > nc.ts.min() + pd.Timedelta(minutes=30)]
    assert estable.luces_nivel.max() <= em["luces_nivel"] + 1e-9
    assert estable[estable.hvac_enable].setpoint_c.min() >= em["setpoint_min_c"]
    assert not estable[estable.tipo == "pasillo"].hvac_enable.any()
    assert estable[estable.ocupado & (estable.tipo != "pasillo")].temp_real_c.mean() < 26.5
    # vuelve la red: se reposta el tanque y el edificio vuelve a la acometida
    assert despues.modo_energia.iloc[1] == "red" and despues.gen_combustible_l.iloc[1] == g["tanque_l"]


def test_corte_sin_planta_solo_ups_de_servidores(cfg):
    m, z, _ = _corte(cfg, horas=1, falla_gen=True)
    ups = cfg["respaldo"]["ups"]["autonomia_min"]
    assert (m.p_gen_kw == 0).all() and (m.p_fv_kw == 0).all() and (m.p_total_kw == 0).all()
    assert set(m.modo_energia) == {"ups", "sin_energia"}
    assert (m.modo_energia == "ups").sum() == ups // 5              # el UPS aguanta su autonomía
    assert z[~z.critica].p_total_kw.max() == 0


def test_tres_lineas_del_sistema_trifasico(cfg, semana):
    m = semana["reglas_dr"].medidor
    # la potencia de las tres líneas suma la del edificio y la corriente media coincide con la trifásica
    assert np.allclose(m.p_l1_kw + m.p_l2_kw + m.p_l3_kw, m.p_total_kw, atol=0.01)
    dia = m[m.p_total_kw > 40]
    media = (dia.i_l1_a + dia.i_l2_a + dia.i_l3_a) / 3
    assert np.allclose(media, dia.i_a, rtol=0.03)
    # con el edificio en carga el desbalance es moderado y la tensión se mantiene cerca de 277 V
    assert dia.desbalance_pct.median() < 6 and dia.desbalance_pct.quantile(0.95) < 15
    v_ln = cfg["edificio"]["v_ll"] / math.sqrt(3)
    assert dia[["v_l1_v", "v_l2_v", "v_l3_v"]].min().min() > 0.95 * v_ln


def test_pico_de_arranque_de_los_equipos(cfg, semana):
    """Al encender, cada compresor añade unos segundos de potencia; el escalonamiento evita que se sumen."""
    for nombre in ("reglas_dr", "baseline"):
        m = semana[nombre].medidor
        assert np.allclose(m.p_pico_kw, m.p_total_kw + m.p_arranque_kw, atol=0.01)
        assert ((m.p_arranque_kw > 0) == (m.n_arranques_equipos > 0)).all()
    m = semana["reglas_dr"].medidor
    assert m.n_arranques_equipos.sum() > 20                  # hay arranques cada día
    assert m.n_arranques_equipos.max() <= 4                  # nunca arrancan todos los equipos a la vez (son 11)
    vrf = [s for s in cfg["sistemas_vrf"] if s.get("tipo") != "ptac"]
    mayor = max(s["capacidad_kw"] / (s["cop"] * cfg["edificio"]["factor_cop"]) for s in vrf)
    # el mayor pico simultáneo equivale a pocas unidades, muy lejos de las 6 VRF arrancando juntas
    assert m.p_arranque_kw.max() < 3 * 0.5 * mayor + 10


def test_transferencia_a_la_planta_es_escalonada(cfg):
    """Nada cambia de golpe en un corte: los terminales se paran, vuelven por turnos y la temperatura deriva."""
    m, z, despues = _corte(cfg, inicio="2026-11-05 11:00", horas=2)
    nc = z[~z.critica]
    activos = nc.groupby("ts").hvac_enable.sum()
    assert activos.iloc[1] == 0                                   # tras la transferencia, todos parados
    assert activos.diff().max() <= cfg["ems"]["arranques_max_paso"]  # vuelven de 2 en 2
    assert activos.iloc[-1] >= 15
    # la planta toma la carga poco a poco y nunca arrancan muchos compresores a la vez
    assert m.p_gen_kw.iloc[1] < 0.5 * m.p_gen_kw.iloc[-1]
    assert m.p_gen_kw.diff().iloc[2:].max() < 15 and m.n_arranques_equipos.max() <= 3
    # la temperatura de las zonas ocupadas sube durante la toma de carga y no se dispara
    ocup = nc[nc.ocupado & (nc.tipo != "pasillo")].groupby("ts").temp_real_c.mean()
    assert 0.4 < ocup.max() - ocup.iloc[0] < 2.5
    # al volver la red hay otra parada y otro reingreso por turnos
    assert despues.modo_energia.iloc[0] == "red"
