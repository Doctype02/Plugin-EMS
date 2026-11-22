"""Control del edificio en Node-RED: overrides del operador y endpoint HTTP (requiere Node.js)."""
import json
import shutil
import subprocess

import pandas as pd
import pytest

from ems import config
from ems.config import RAIZ
from ems.simulacion import simular

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="requiere Node.js")


class Harness:
    def __init__(self):
        self.p = subprocess.Popen(["node", str(RAIZ / "nodered" / "harness.js")], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)

    def __call__(self, tipo, payload):
        self.p.stdin.write(json.dumps({"tipo": tipo, "payload": payload}, default=str) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=5)


@pytest.fixture()
def h():
    x = Harness()
    yield x
    x.close()


@pytest.fixture(scope="module")
def paso():
    """Telemetría real de un mediodía laborable (último paso de una simulación corta)."""
    cfg = config.cargar()
    r = simular(cfg, "reglas_dr", dias=1.5)
    t = r.medidor.index[(r.medidor.index.hour == 11) & (r.medidor.index.minute == 0)][-1]
    zonas = r.zonas[r.zonas.ts == t].to_dict("records")
    med = r.medidor.loc[t].to_dict()
    return t, zonas, med


def _enviar_paso(h, t, zonas, med):
    for z in zonas:
        pub = {k: v for k, v in z.items() if k not in ("temp_real_c", "hvac_mod")}
        pub["ts"] = t.isoformat()
        h("zona", pub)
    return h("medidor", {**med, "ts": t.isoformat()})


def test_override_tiene_prioridad_sobre_las_reglas(h, paso):
    t, zonas, med = paso
    base = {c["zona"]: c for c in _enviar_paso(h, t, zonas, med)["cmds"]}
    assert base["Z02"]["hvac_enable"] is True
    h("override", {"zona": "Z02", "hvac_enable": False, "luces_nivel": 0.3, "duracion_min": 30, "usuario": "operador"})
    r = _enviar_paso(h, t, zonas, med)
    cmd = {c["zona"]: c for c in r["cmds"]}
    assert cmd["Z02"]["hvac_enable"] is False
    assert cmd["Z02"]["luces_nivel"] == 0.3
    assert "Z02" in r["estado"]["manual"]
    # las demás zonas siguen en automático
    assert cmd["Z03"]["luces_nivel"] == base["Z03"]["luces_nivel"]


def test_override_setpoint_y_liberar(h, paso):
    t, zonas, med = paso
    h("override", {"zona": "Z05", "setpoint_c": 22.5, "duracion_min": 60})
    cmd = {c["zona"]: c for c in _enviar_paso(h, t, zonas, med)["cmds"]}
    assert cmd["Z05"]["setpoint_c"] == 22.5 and cmd["Z05"]["hvac_enable"] is True
    h("override", {"tipo": "liberar", "zona": "Z05"})
    r = _enviar_paso(h, t, zonas, med)
    # liberado vuelve a las reglas con la rampa de setpoint: ≤ 0.25 °C por paso desde el del terminal
    previo = next(z for z in zonas if z["zona"] == "Z05")["setpoint_c"]
    sp = {c["zona"]: c for c in r["cmds"]}["Z05"]["setpoint_c"]
    assert sp != 22.5 and abs(sp - previo) <= 0.25 + 1e-9
    assert r["estado"]["manual"] == []


def test_zonas_criticas_no_admiten_override(h, paso):
    t, zonas, med = paso
    out = h("override", {"zona": "Z06", "hvac_enable": False})
    assert out["overrides"] is None
    r = _enviar_paso(h, t, zonas, med)
    assert "Z06" not in r["estado"]["manual"]


def test_override_valores_acotados(h):
    out = h("override", {"zona": "Z04", "setpoint_c": 35, "luces_nivel": 3, "duracion_min": 99999})
    o = out["overrides"]["Z04"]
    assert o["setpoint_c"] == 28 and o["luces_nivel"] == 1
    assert o["hasta"] - o["desde"] == 1440 * 60000


def test_endpoint_http_valida_y_publica(h):
    ok = h("http", {"tipo": "override", "zona": "Z03", "setpoint_c": 25, "duracion_min": 30, "usuario": "ana"})
    assert ok["status"] == 200 and ok["cors"] == "*"
    assert ok["mqtt"]["topic"] == "ems/edificio1/ems/override"
    assert ok["mqtt"]["payload"] == {"zona": "Z03", "setpoint_c": 25, "duracion_min": 30, "usuario": "ana"}
    assert h("http", {"tipo": "override", "zona": "Z06", "hvac_enable": False})["status"] == 400
    assert h("http", {"tipo": "override", "zona": "Z27", "hvac_enable": False})["status"] == 400
    assert h("http", {"tipo": "override", "zona": "Z03"})["status"] == 400
    par = h("http", {"tipo": "parametros", "limite_kw": 32, "sp_ocupado": 24.5})
    assert par["status"] == 200 and par["parametros"]["payload"] == {"limite_kw": 32, "sp_ocupado": 24.5}
    assert h("http", {"tipo": "parametros", "limite_kw": 5})["status"] == 400
    assert h("http", {"tipo": "otro"})["status"] == 400
    lib = h("http", {"tipo": "liberar", "zona": "*"})
    assert lib["status"] == 200 and lib["mqtt"]["payload"]["zona"] == "*"


def test_parametros_en_vivo_cambian_el_setpoint(h, paso):
    t, zonas, med = paso
    h("parametros", {"sp_ocupado": 25})
    cmd = {c["zona"]: c for c in _enviar_paso(h, t, zonas, med)["cmds"]}
    ocupadas = [z["zona"] for z in zonas if z["ocupado"] and not z["critica"]]
    previo = {z["zona"]: z["setpoint_c"] for z in zonas}
    # la consigna avanza hacia 25 °C con la rampa (0.25 °C por paso de 5 min)
    assert ocupadas and all(cmd[z]["setpoint_c"] == round(previo[z] + max(-0.25, min(0.25, 25 - previo[z])), 2)
                            for z in ocupadas)


def test_endpoint_http_eventos_simulados(h):
    ev = h("http", {"tipo": "evento", "accion": "iniciar", "id": "e1", "evento": "incendio", "zona": "Z03",
                    "duracion_min": 45, "usuario": "ana"})
    assert ev["status"] == 200
    assert ev["mqtt"]["topic"] == "ems/edificio1/sim/control"
    assert ev["mqtt"]["payload"] == {"accion": "evento", "operacion": "iniciar", "id": "e1", "evento": "incendio",
                                     "zona": "Z03", "duracion_min": 45, "usuario": "ana"}
    assert h("http", {"tipo": "evento", "evento": "meteorito", "duracion_min": 5})["status"] == 400
    assert h("http", {"tipo": "evento", "evento": "falla_vrf", "unidad": "VRF-Z", "duracion_min": 5})["status"] == 400
    assert h("http", {"tipo": "evento", "evento": "ola_calor", "duracion_min": 0})["status"] == 400
    fin = h("http", {"tipo": "evento", "accion": "detener", "id": "e1"})
    assert fin["status"] == 200 and fin["mqtt"]["payload"]["operacion"] == "detener"


def test_endpoint_http_ocupacion(h):
    r = h("http", {"tipo": "ocupacion", "zona": "Z03", "personas": 30, "duracion_min": 60})
    assert r["status"] == 200 and r["mqtt"]["topic"] == "ems/edificio1/sim/control"
    assert r["mqtt"]["payload"] == {"accion": "ocupacion", "zona": "Z03", "usuario": "", "duracion_min": 60, "personas": 30}
    r = h("http", {"tipo": "ocupacion", "zona": "*", "porcentaje": 50, "duracion_min": 240})
    assert r["status"] == 200 and r["mqtt"]["payload"]["porcentaje"] == 50
    assert h("http", {"tipo": "ocupacion", "zona": "Z06", "personas": 2, "duracion_min": 5})["status"] == 400
    assert h("http", {"tipo": "ocupacion", "zona": "*", "porcentaje": 300, "duracion_min": 5})["status"] == 400
    lib = h("http", {"tipo": "ocupacion", "zona": "Z03", "liberar": True})
    assert lib["status"] == 200 and lib["mqtt"]["payload"]["liberar"] is True


def test_endpoint_http_unidad(h):
    r = h("http", {"tipo": "unidad", "unidad": "VRF-P2", "encendido": False, "modo": "ventilacion",
                   "capacidad_pct": 60, "setpoint_c": 25.5, "cop_factor": 0.8, "duracion_min": 30, "usuario": "ana"})
    assert r["status"] == 200 and r["mqtt"]["topic"] == "ems/edificio1/sim/control"
    assert r["mqtt"]["payload"] == {"accion": "unidad", "unidad": "VRF-P2", "usuario": "ana", "encendido": False,
                                    "modo": "ventilacion", "capacidad_pct": 60, "setpoint_c": 25.5,
                                    "cop_factor": 0.8, "duracion_min": 30}
    # sin duración: queda hasta liberar
    sin = h("http", {"tipo": "unidad", "unidad": "PTAC-P1", "capacidad_pct": 0})
    assert sin["status"] == 200 and "duracion_min" not in sin["mqtt"]["payload"]
    # rangos y valores inválidos
    for malo in ({"capacidad_pct": 101}, {"capacidad_pct": -1}, {"setpoint_c": 17}, {"setpoint_c": 31},
                 {"cop_factor": 0.4}, {"cop_factor": 1.3}, {"modo": "calor"}, {"encendido": "no"},
                 {"encendido": False, "duracion_min": 0}, {"encendido": False, "duracion_min": 20000}, {}):
        out = h("http", {"tipo": "unidad", "unidad": "VRF-P2", **malo})
        assert out["status"] == 400 and out["mqtt"] is None, malo
    assert h("http", {"tipo": "unidad", "unidad": "VRF-X", "encendido": False})["status"] == 400
    assert h("http", {"tipo": "unidad", "unidad": "*", "encendido": False})["status"] == 400


def test_endpoint_http_unidad_critica_exige_confirmar(h):
    r = h("http", {"tipo": "unidad", "unidad": "VRF-SRV", "encendido": False})
    assert r["status"] == 409 and r["cuerpo"]["requiere_confirmar"] is True and r["mqtt"] is None
    ok = h("http", {"tipo": "unidad", "unidad": "VRF-SRV", "encendido": False, "confirmar": True, "duracion_min": 15})
    assert ok["status"] == 200 and ok["mqtt"]["payload"]["confirmar"] is True


def test_endpoint_http_sensor(h):
    r = h("http", {"tipo": "sensor", "zona": "Z03", "temp_offset_c": 2.5, "hr_pct": 80, "presencia": False,
                   "duracion_min": 60})
    assert r["status"] == 200 and r["mqtt"]["topic"] == "ems/edificio1/sim/control"
    assert r["mqtt"]["payload"] == {"accion": "sensor", "zona": "Z03", "usuario": "", "temp_offset_c": 2.5,
                                    "hr_pct": 80, "presencia": False, "duracion_min": 60}
    fijo = h("http", {"tipo": "sensor", "zona": "Z12", "temp_c": 30, "congelado": True})
    assert fijo["status"] == 200 and fijo["mqtt"]["payload"]["congelado"] is True
    for malo in ({"temp_offset_c": 11}, {"temp_c": 4}, {"temp_c": 51}, {"hr_pct": 101}, {"presencia": 1},
                 {"temp_c": 25, "temp_offset_c": 1}, {"congelado": False}, {}):
        out = h("http", {"tipo": "sensor", "zona": "Z03", **malo})
        assert out["status"] == 400 and out["mqtt"] is None, malo
    assert h("http", {"tipo": "sensor", "zona": "Z27", "congelado": True})["status"] == 400
    assert h("http", {"tipo": "sensor", "zona": "Z06", "congelado": True})["status"] == 409
    assert h("http", {"tipo": "sensor", "zona": "Z06", "congelado": True, "confirmar": True})["status"] == 200


def test_endpoint_http_liberar_controladores(h):
    for cuerpo, clave in (({"tipo": "unidad", "unidad": "VRF-P1"}, "unidad"), ({"tipo": "unidad", "unidad": "*"}, "unidad"),
                          ({"tipo": "sensor", "zona": "Z05"}, "zona"), ({"tipo": "sensor", "zona": "*"}, "zona")):
        r = h("http", {**cuerpo, "liberar": True})
        assert r["status"] == 200 and r["mqtt"]["payload"]["liberar"] is True
        assert r["mqtt"]["payload"][clave] == cuerpo[clave]
    # liberar la unidad crítica no necesita confirmación (devuelve el control al EMS)
    assert h("http", {"tipo": "unidad", "unidad": "VRF-SRV", "liberar": True})["status"] == 200
    assert h("http", {"tipo": "unidad", "unidad": "VRF-9", "liberar": True})["status"] == 400
    assert h("http", {"tipo": "sensor", "zona": "Z99", "liberar": True})["status"] == 400


def test_nodered_reacciona_al_sensor_forzado(h, paso):
    """La telemetría lleva el valor forzado: Node-RED actúa sobre él como con un sensor real."""
    t, zonas, med = paso
    base = {c["zona"]: c for c in _enviar_paso(h, t, zonas, med)["cmds"]}
    assert base["Z09"]["luces_nivel"] > 0
    assert next(z for z in zonas if z["zona"] == "Z09")["ocupado"]
    forzadas = [dict(z, ocupado=False) if z["zona"] == "Z09" else z for z in zonas]
    # tras el retardo de vacancia (15 min) la zona «vacía» apaga luces y sube el setpoint
    t2 = t + pd.Timedelta(minutes=20)
    cmd = {c["zona"]: c for c in _enviar_paso(h, t2, forzadas, med)["cmds"]}
    assert cmd["Z09"]["luces_nivel"] == 0 and cmd["Z09"]["setpoint_c"] > base["Z09"]["setpoint_c"]
