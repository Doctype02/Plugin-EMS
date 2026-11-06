"""Control del edificio en Node-RED: overrides del operador y endpoint HTTP (requiere Node.js)."""
import json
import shutil
import subprocess

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
    assert {c["zona"]: c for c in r["cmds"]}["Z05"]["setpoint_c"] == 24.0
    assert r["estado"]["manual"] == []


def test_zonas_criticas_no_admiten_override(h, paso):
    t, zonas, med = paso
    out = h("override", {"zona": "Z09", "hvac_enable": False})
    assert out["overrides"] is None
    r = _enviar_paso(h, t, zonas, med)
    assert "Z09" not in r["estado"]["manual"]


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
    assert h("http", {"tipo": "override", "zona": "Z10", "hvac_enable": False})["status"] == 400
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
    assert ocupadas and all(cmd[z]["setpoint_c"] == 25 for z in ocupadas)


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
