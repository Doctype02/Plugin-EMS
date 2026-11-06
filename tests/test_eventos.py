"""Eventos simulados en el gemelo digital (incendio, corte, fallas, condiciones extremas)."""
import pytest

from ems import config
from ems.edificio import Edificio


@pytest.fixture(scope="module")
def cfg():
    return config.cargar()


CLIMA = {"t_ext_c": 31.0, "hr_pct": 70.0, "irr_wm2": 700.0}


def correr(cfg, evento=None, pasos=8, ocup=None):
    """Mediodía laborable: 1 h de calentamiento y luego `pasos` pasos con el evento (si lo hay)."""
    ed = Edificio(cfg)
    ocup = ocup or {z.id: z.ocupantes for z in ed.zonas}
    for _ in range(12):
        ed.paso(CLIMA, ocup, 12 * 60, 1)
    if evento:
        ev, alarmas, err = ed.iniciar_evento(evento)
        assert err is None
    else:
        alarmas = []
    for _ in range(pasos):
        tel, med = ed.paso(CLIMA, ocup, 12 * 60, 1)
    return ed, {z["zona"]: z for z in tel}, med, alarmas


def test_incendio_evacua_y_para_la_climatizacion(cfg):
    _, base, _, _ = correr(cfg)
    ed, tel, med, alarmas = correr(cfg, {"evento": "incendio", "zona": "Z03", "duracion_min": 45})
    assert [a["codigo"] for a in alarmas] == ["INCENDIO"]
    assert all(not z["hvac_on"] and z["p_ventilador_kw"] == 0 for z in tel.values())
    assert sum(z["ocupantes"] for z in tel.values()) == 0
    assert tel["Z03"]["temp_real_c"] > base["Z03"]["temp_real_c"] + 8
    assert med["eventos"] == ["incendio"]


def test_corte_de_energia_ups_y_medidor(cfg):
    ed, tel, med, alarmas = correr(cfg, {"evento": "corte_energia", "duracion_min": 120, "intensidad": 20}, pasos=2)
    assert {a["codigo"] for a in alarmas} == {"CORTE_ENERGIA", "EN_UPS"}
    assert med["p_total_kw"] == 0 and med["red_ok"] is False and med["v_ll"] == 0
    assert med["ups_kw"] > 1.5  # servidores en UPS
    assert tel["Z02"]["p_total_kw"] == 0
    # tras agotar la autonomía (20 min) los servidores también se apagan
    for _ in range(4):
        tel2, med2 = ed.paso(CLIMA, {z.id: z.ocupantes for z in ed.zonas}, 12 * 60, 1)
    assert med2["ups_kw"] == 0 and med2["ups_min"] == 0


def test_falla_vrf_solo_afecta_sus_zonas(cfg):
    _, base, _, _ = correr(cfg, pasos=12)
    _, tel, _, alarmas = correr(cfg, {"evento": "falla_vrf", "unidad": "VRF-A", "duracion_min": 120}, pasos=12)
    assert alarmas[0]["codigo"] == "FALLA_VRF"
    for zid in ("Z04", "Z05", "Z06", "Z07"):
        assert tel[zid]["temp_real_c"] > base[zid]["temp_real_c"] + 1.0
        assert tel[zid]["q_frio_kw"] == 0
    assert abs(tel["Z02"]["temp_real_c"] - base["Z02"]["temp_real_c"]) < 0.3


def test_eventos_terminan_solos_y_se_pueden_detener(cfg):
    ed, _, _, _ = correr(cfg, {"evento": "ola_calor", "duracion_min": 20, "intensidad": 5}, pasos=1)
    assert ed.eventos
    for _ in range(4):
        ed.paso(CLIMA, {}, 12 * 60, 1)
    assert not ed.eventos
    ed.iniciar_evento({"evento": "sensor", "zona": "Z04", "duracion_min": 60, "id": "s1"})
    assert "Z04" in ed.falla_sensor
    ed.terminar_evento("s1")
    assert "Z04" not in ed.falla_sensor and not ed.eventos


def test_eventos_invalidos(cfg):
    ed = Edificio(cfg)
    assert ed.iniciar_evento({"evento": "meteorito"})[2]
    assert ed.iniciar_evento({"evento": "incendio", "zona": "Z99"})[2]
    assert ed.iniciar_evento({"evento": "falla_vrf", "unidad": "VRF-Z"})[2]


def test_puerta_abierta_y_pico_de_carga_suben_el_consumo(cfg):
    _, base, mb, _ = correr(cfg)
    _, tel, med, _ = correr(cfg, {"evento": "pico_carga", "zona": "Z02", "duracion_min": 60, "intensidad": 10})
    assert med["p_total_kw"] > mb["p_total_kw"] + 8
    _, tel2, _, _ = correr(cfg, {"evento": "puerta_abierta", "zona": "Z03", "duracion_min": 60, "intensidad": 100})
    assert tel2["Z03"]["q_frio_kw"] > base["Z03"]["q_frio_kw"] or tel2["Z03"]["temp_real_c"] > base["Z03"]["temp_real_c"]
