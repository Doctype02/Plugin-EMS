"""Sustituto de Node-RED para pruebas sin Docker: ejecuta nodered/src/*.js vía Node.js y habla MQTT.

    python tools/nodered_stub.py --host localhost --port 1883

Se suscribe a telemetría y medidor, corre la misma función que el flujo de Node-RED y publica
comandos, estado y alarmas. Útil para probar el lazo completo y medir latencia sin Node-RED.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import paho.mqtt.client as mqtt

RAIZ = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--duracion", type=float, default=0, help="segundos (0 = infinito)")
    ap.add_argument("--http-port", type=int, default=1880, help="puerto del endpoint POST /ems/control (0 = sin HTTP)")
    a = ap.parse_args()
    node = subprocess.Popen(["node", str(RAIZ / "nodered" / "harness.js")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, bufsize=1)

    lock = threading.Lock()

    def harness(tipo, payload):
        with lock:
            node.stdin.write(json.dumps({"tipo": tipo, "payload": payload}) + "\n")
            node.stdin.flush()
            return json.loads(node.stdout.readline())

    stats = {"pasos": 0, "cmds": 0, "acks": 0, "lat": []}

    def on_message(cli, _u, msg):
        p = json.loads(msg.payload)
        partes = msg.topic.split("/")
        base = "/".join(partes[:2])
        if partes[-1] == "telemetria":
            harness("zona", p)
        elif partes[-1] == "general":
            r = harness("medidor", p)
            for c in r["cmds"]:
                zid = c.pop("zona")
                cli.publish(f"{base}/zona/{zid}/cmd", json.dumps(c))
                stats["cmds"] += 1
            cli.publish(f"{base}/ems/estado", json.dumps(r["estado"]))
            for al in r["alarmas"]:
                cli.publish(f"{base}/alarma", json.dumps(al))
            stats["pasos"] += 1
        elif partes[-1] == "override":
            harness("override", p)
        elif partes[-1] == "parametros":
            harness("parametros", p)
        elif partes[-1] == "ack":
            stats["acks"] += 1

    cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="nodered-stub")
    cli.on_message = on_message
    cli.connect(a.host, a.port)
    cli.subscribe([("ems/+/zona/+/telemetria", 0), ("ems/+/medidor/general", 0), ("ems/+/zona/+/ack", 0),
                   ("ems/+/ems/override", 0), ("ems/+/ems/parametros", 0)])
    cli.loop_start()

    class Control(BaseHTTPRequestHandler):
        """Mismo endpoint que el flujo de Node-RED: valida con http_control.js y publica por MQTT."""

        def _cors(self, code):
            self.send_response(code)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def do_OPTIONS(self):  # noqa: N802
            self._cors(204)
            self.end_headers()

        def do_POST(self):  # noqa: N802
            if self.path.rstrip("/") != "/ems/control":
                self._cors(404)
                self.end_headers()
                return
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            r = harness("http", body)
            for k in ("mqtt", "parametros"):
                if r.get(k):
                    cli.publish(r[k]["topic"], json.dumps(r[k]["payload"]))
            self._cors(r["status"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(r["cuerpo"]).encode())

        def log_message(self, *a):
            pass

    if a.http_port:
        srv = ThreadingHTTPServer(("0.0.0.0", a.http_port), Control)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"[stub] POST http://localhost:{a.http_port}/ems/control", file=sys.stderr)
    t0 = time.time()
    try:
        while not a.duracion or time.time() - t0 < a.duracion:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    cli.loop_stop()
    node.stdin.close()
    print(json.dumps({k: v for k, v in stats.items() if k != "lat"}), file=sys.stderr)


if __name__ == "__main__":
    main()
