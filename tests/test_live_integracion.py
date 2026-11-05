"""Integración del modo en vivo: Mosquitto + sustituto de Node-RED + simulador (requiere mosquitto y node)."""
import json
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request

import pandas as pd
import pytest

from ems import config
from ems.config import RAIZ
from ems.live import resolver_inicio

pytestmark = pytest.mark.skipif(not (shutil.which("mosquitto") and shutil.which("node")), reason="requiere mosquitto y node")


def _puerto_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_resolver_inicio():
    tz = "America/Panama"
    assert resolver_inicio(None, tz).endswith("00:00")
    ahora = pd.Timestamp(resolver_inicio("ahora", tz)).tz_localize(tz)
    assert abs((pd.Timestamp.now(tz=tz) - ahora).total_seconds()) < 5 * 60 + 5
    assert ahora.minute % 5 == 0
    assert resolver_inicio("2026-11-03 09:00", tz) == "2026-11-03 09:00"


def test_lazo_en_vivo_guarda_estado_y_alarmas_y_respeta_overrides(monkeypatch):
    mqtt_port, http_port = _puerto_libre(), _puerto_libre()
    broker = subprocess.Popen(["mosquitto", "-p", str(mqtt_port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stub = subprocess.Popen([sys.executable, str(RAIZ / "tools" / "nodered_stub.py"), "--port", str(mqtt_port),
                             "--http-port", str(http_port), "--duracion", "60"], stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        from ems import influx, live

        registro = {"zona": [], "medidor": [], "ems": [], "alarma": []}

        class Grabador(influx.Escritor):
            def __init__(self, *a, **k):
                self.habilitado = True
                self.edificio = "edificio1"

            def zona(self, ts, z, escenario="live"):
                registro["zona"].append((ts, z["zona"], z["hvac_enable"]))

            def medidor(self, ts, m, escenario="live"):
                registro["medidor"].append(ts)

            def ems(self, ts, est, escenario="live"):
                registro["ems"].append((ts, est))

            def alarma(self, a, escenario="live"):
                registro["alarma"].append(a)

            def pronostico(self, *a, **k):
                pass

            def flush(self, forzar=False):
                pass

            def cerrar(self):
                pass

        monkeypatch.setattr(live, "Escritor", Grabador)
        cfg = config.cargar()
        p = live.Puente(cfg, control="externo", velocidad=3000, inicio="2026-11-04 12:30", dias=0.25,
                        host="127.0.0.1", port=mqtt_port)
        p.publicar_pronostico = lambda: None
        hilo = threading.Thread(target=p.correr)
        hilo.start()
        time.sleep(3)
        req = urllib.request.Request(f"http://127.0.0.1:{http_port}/ems/control", method="POST",
                                     data=json.dumps({"tipo": "override", "zona": "Z02", "hvac_enable": False,
                                                      "duracion_min": 60}).encode(),
                                     headers={"Content-Type": "application/json"})
        assert json.loads(urllib.request.urlopen(req, timeout=5).read())["ok"] is True
        hilo.join(timeout=40)
        assert not hilo.is_alive()

        assert len(registro["medidor"]) >= 70  # 6 h a 5 min
        assert registro["ems"], "el estado de Node-RED debe guardarse en InfluxDB"
        assert any(e[1].get("origen") == "nodered" for e in registro["ems"])
        assert any("Z02" in e[1].get("manual", []) for e in registro["ems"]), "el override debe verse en el estado"
        # tras el override, Z02 queda con el HVAC deshabilitado en la telemetría
        z02 = [z for z in registro["zona"] if z[1] == "Z02"]
        assert z02[-1][2] is False
        # las alarmas de Node-RED (p. ej. DR_ACTIVO al mediodía) también se guardan
        assert all({"ts", "nivel", "codigo", "zona", "mensaje"} <= set(a) for a in registro["alarma"])
    finally:
        stub.terminate()
        broker.terminate()
        stub.wait(timeout=5)
        broker.wait(timeout=5)
