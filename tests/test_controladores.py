"""Ajustes de unidades VRF/PTAC y forzado de sensores de zona (ems/controladores.py, Edificio)."""
import pandas as pd
import pytest

from ems import clima as m_clima
from ems import config
from ems import ocupacion as m_ocup
from ems.config import zonas
from ems.control import crear
from ems.edificio import Edificio


@pytest.fixture(scope="module")
def cfg():
    return config.cargar()


class Gemelo:
    """Gemelo + EMS por reglas en lazo cerrado, paso a paso desde un lunes laborable."""

    def __init__(self, cfg, inicio="2026-11-02 06:00", horas=8):
        self.ed = Edificio(cfg)
        self.ctrl = crear("reglas_dr", cfg)
        self.idx = m_clima.indice(pd.Timestamp(inicio), horas / 24, cfg["edificio"]["paso_min"],
                                  cfg["edificio"]["zona_horaria"])
        self.cl = m_clima.generar(cfg, self.idx).to_dict("records")
        self.oc = m_ocup.generar(zonas(cfg), self.idx, cfg["ocupacion"], cfg=cfg).to_dict("records")
        self.i = 0
        self.tel = self.med = None

    def avanzar(self, pasos=1):
        for _ in range(pasos):
            t = self.idx[self.i]
            if self.tel is not None:
                self.ed.aplicar(self.ctrl.decidir(t, self.tel, self.med))
            self.tel, self.med = self.ed.paso(self.cl[self.i], self.oc[self.i], t.hour * 60 + t.minute,
                                              t.dayofweek)
            self.i += 1
        return {z["zona"]: z for z in self.tel}

    def unidad(self, uid):
        return next(u for u in self.ed.estado_controladores()["unidades"] if u["unidad"] == uid)


def _a_las(g: Gemelo, hora: float):
    return g.avanzar(int(round((hora - 6) * 12)) - g.i)


def test_validacion_de_unidades_y_sensores(cfg):
    ed = Edificio(cfg)
    assert ed.ajustar_unidad({"unidad": "VRF-X", "encendido": False})[1].startswith("unidad inválida")
    assert "fuera de rango" in ed.ajustar_unidad({"unidad": "VRF-PB", "capacidad_pct": 120})[1]
    assert "fuera de rango" in ed.ajustar_unidad({"unidad": "VRF-PB", "cop_factor": 0.2})[1]
    assert "modo inválido" in ed.ajustar_unidad({"unidad": "VRF-PB", "modo": "calor"})[1]
    assert ed.ajustar_unidad({"unidad": "VRF-PB"})[1] == "sin cambios"
    assert "duración" in ed.ajustar_unidad({"unidad": "VRF-PB", "encendido": False, "duracion_min": 0})[1]
    # la unidad del cuarto de servidores exige confirmación y avisa al aplicarse
    assert "confirmar" in ed.ajustar_unidad({"unidad": "VRF-SRV", "encendido": False})[1]
    alarmas, err = ed.ajustar_unidad({"unidad": "VRF-SRV", "capacidad_pct": 50, "confirmar": True})
    assert err is None and alarmas[0]["codigo"] == "AJUSTE_CRITICO"
    assert "no ambos" in ed.forzar_sensor({"zona": "Z02", "temp_c": 24, "temp_offset_c": 1})[1]
    assert "fuera de rango" in ed.forzar_sensor({"zona": "Z02", "hr_pct": 140})[1]
    assert "confirmar" in ed.forzar_sensor({"zona": "Z06", "congelado": True})[1]
    assert ed.forzar_sensor({"zona": "Z02", "congelado": False})[1] == "sin cambios"
    assert ed.forzar_sensor({"zona": "Z99", "liberar": True})[1].startswith("zona inválida")


def test_apagar_una_unidad_deja_sin_frio_a_sus_zonas(cfg):
    ref, g = Gemelo(cfg), Gemelo(cfg)
    _a_las(ref, 11)
    _a_las(g, 11)
    assert g.unidad("VRF-P2")["p_kw"] > 1.0
    assert g.ed.ajustar_unidad({"unidad": "VRF-P2", "encendido": False, "duracion_min": 60})[1] is None
    z_ref, z = ref.avanzar(6), g.avanzar(6)
    u = g.unidad("VRF-P2")
    assert u["modo"] == "apagado" and not u["encendido"] and u["forzado"]
    assert u["p_kw"] == 0.0 and u["q_frio_kw"] == 0.0
    for zid in ("Z12", "Z13", "Z14", "Z15"):
        assert z[zid]["p_hvac_kw"] == 0.0 and not z[zid]["hvac_on"]
        assert z[zid]["temp_real_c"] > z_ref[zid]["temp_real_c"] + (0.1 if zid == "Z15" else 0.5)
    # las demás unidades siguen normales
    assert z["Z07"]["p_hvac_kw"] > 0


def test_limitar_capacidad_y_degradar_cop(cfg):
    ref, g = Gemelo(cfg), Gemelo(cfg)
    _a_las(ref, 13)
    _a_las(g, 13)
    g.ed.ajustar_unidad({"unidad": "VRF-P4", "capacidad_pct": 10})
    g.ed.ajustar_unidad({"unidad": "VRF-P3", "cop_factor": 0.5})
    ref.avanzar(3)
    g.avanzar(3)
    lim, base = g.unidad("VRF-P4"), ref.unidad("VRF-P4")
    assert lim["q_frio_kw"] <= 0.1 * lim["capacidad_kw"] * 1.12 + 1e-6  # sensible + latente del serpentín
    assert lim["q_frio_kw"] < base["q_frio_kw"]
    deg, b3 = g.unidad("VRF-P3"), ref.unidad("VRF-P3")
    assert deg["cop"] == pytest.approx(b3["cop"] * 0.5, rel=0.05)
    assert deg["cop_factor"] == 0.5 and lim["capacidad_pct"] == 10


def test_modo_ventilacion_y_setpoint_local(cfg):
    g = Gemelo(cfg)
    _a_las(g, 11)
    g.ed.ajustar_unidad({"unidad": "VRF-P1", "modo": "ventilacion"})
    g.ed.ajustar_unidad({"unidad": "VRF-PB", "setpoint_c": 21.0})
    z = g.avanzar(2)
    u = g.unidad("VRF-P1")
    assert u["q_frio_kw"] == 0.0 and u["p_kw"] > 0  # sólo ventiladores
    assert all(z[zid]["setpoint_c"] == 21.0 for zid in ("Z01", "Z02", "Z03", "Z04"))
    assert z["Z07"]["setpoint_c"] != 21.0


def test_modo_frio_ignora_el_deslastre_del_ems(cfg):
    g = Gemelo(cfg)
    _a_las(g, 11)
    g.ed.aplicar({"Z02": {"hvac_enable": False}})
    g.ed.ajustar_unidad({"unidad": "VRF-PB", "modo": "frio", "setpoint_c": 22.0})
    for _ in range(4):
        g.ed.aplicar({zid: {"hvac_mod": 0.0} for zid in ("Z01", "Z02", "Z03", "Z04")})
        z = g.avanzar()
    assert z["Z02"]["hvac_enable"] and g.unidad("VRF-PB")["q_frio_kw"] > 0


def test_el_ems_reacciona_al_sensor_forzado_sin_cambiar_la_fisica(cfg):
    ref, g = Gemelo(cfg), Gemelo(cfg)
    _a_las(ref, 11)
    _a_las(g, 11)
    # +4 °C de descalibración: el controlador cree que hace calor y enfría de más
    g.ed.forzar_sensor({"zona": "Z09", "temp_offset_c": 4.0})
    z_ref, z = ref.avanzar(6), g.avanzar(6)
    assert z["Z09"]["temp_c"] == pytest.approx(z["Z09"]["temp_real_c"] + 4.0, abs=0.4)
    assert z["Z09"]["sensor_forzado"] and z["Z09"]["sensor_temp_offset_c"] == 4.0
    assert z["Z09"]["temp_real_c"] < z_ref["Z09"]["temp_real_c"] - 0.5
    assert z["Z09"]["p_hvac_kw"] > z_ref["Z09"]["p_hvac_kw"]
    # presencia forzada a «vacía»: el EMS apaga la iluminación aunque haya personas
    g.ed.forzar_sensor({"zona": "Z14", "presencia": False})
    z = g.avanzar(5)
    assert z["Z14"]["ocupado_real"] and not z["Z14"]["ocupado"]
    assert z["Z14"]["ocupantes"] > 0 and z["Z14"]["luces_nivel"] == 0.0
    # temperatura fija alta: TEMP_ALTA del supervisor
    g.ed.forzar_sensor({"zona": "Z13", "temp_c": 29.5})
    alarmas = []
    for _ in range(4):
        g.avanzar()
        alarmas += g.ctrl.alarmas
    assert any(a["codigo"] == "TEMP_ALTA" and a["zona"] == "Z13" for a in alarmas)


def test_sensor_congelado_pasa_a_modo_seguro_y_hr_forzada(cfg):
    g = Gemelo(cfg)
    _a_las(g, 10)
    g.ed.forzar_sensor({"zona": "Z18", "congelado": True, "hr_pct": 40.0, "duracion_min": 60})
    lecturas, alarmas = [], []
    for _ in range(8):
        z = g.avanzar()
        lecturas.append(z["Z18"]["temp_c"])
        alarmas += g.ctrl.alarmas
    assert len(set(lecturas)) == 1
    assert any(a["codigo"] == "SENSOR_CONGELADO" and a["zona"] == "Z18" for a in alarmas)
    assert "Z18" in g.ctrl.modo_seguro
    # congelado tiene prioridad: la HR también queda fija en el último valor real
    est = g.ed.estado_controladores()["sensores"][0]
    assert est["zona"] == "Z18" and est["forzado"] == {"hr_pct": 40.0, "congelado": True}
    assert est["temp_c"] == lecturas[-1] and est["restante_min"] == pytest.approx(20)


def test_expiracion_por_duracion_y_liberar(cfg):
    g = Gemelo(cfg)
    _a_las(g, 9)
    g.ed.ajustar_unidad({"unidad": "PTAC-P2", "encendido": False, "duracion_min": 15})
    g.ed.ajustar_unidad({"unidad": "VRF-P3", "capacidad_pct": 40})  # sin duración
    g.ed.forzar_sensor({"zona": "Z02", "temp_offset_c": -2.0, "duracion_min": 10})
    g.avanzar(2)
    assert g.ed.fin_ajustes == ["Z02"] and "Z02" not in g.ed.sensor_forzado
    assert g.unidad("PTAC-P2")["restante_min"] == pytest.approx(5)
    g.avanzar()
    assert g.ed.fin_ajustes == ["PTAC-P2"] and not g.unidad("PTAC-P2")["forzado"]
    z = g.avanzar()
    assert abs(z["Z02"]["temp_c"] - z["Z02"]["temp_real_c"]) < 0.5
    assert g.unidad("VRF-P3")["forzado"] and g.unidad("VRF-P3")["restante_min"] is None
    assert g.ed.ajustar_unidad({"unidad": "VRF-P3", "liberar": True}) == ([], None)
    g.ed.forzar_sensor({"zona": "Z03", "presencia": True})
    g.ed.forzar_sensor({"zona": "Z04", "presencia": True})
    assert g.ed.forzar_sensor({"zona": "*", "liberar": True}) == ([], None)
    g.avanzar()
    assert not g.ed.sensor_forzado and not g.unidad("VRF-P3")["forzado"]
    assert "unidades_ajustadas" not in g.med and "sensores_forzados" not in g.med


def test_falla_vrf_se_informa_en_el_estado_de_la_unidad(cfg):
    g = Gemelo(cfg)
    _a_las(g, 11)
    g.ed.iniciar_evento({"evento": "falla_vrf", "unidad": "VRF-P1", "duracion_min": 30})
    g.avanzar()
    u = g.unidad("VRF-P1")
    assert u["falla"] and not u["forzado"] and u["q_frio_kw"] == 0.0
