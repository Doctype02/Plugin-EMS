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
import time
from pathlib import Path

import paho.mqtt.client as mqtt

RAIZ = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--duracion", type=float, default=0, help="segundos (0 = infinito)")
    a = ap.parse_args()
    node = subprocess.Popen(["node", str(RAIZ / "nodered" / "harness.js")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, bufsize=1)

    def harness(tipo, payload):
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
        elif partes[-1] == "ack":
            stats["acks"] += 1

    cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="nodered-stub")
    cli.on_message = on_message
    cli.connect(a.host, a.port)
    cli.subscribe([("ems/+/zona/+/telemetria", 0), ("ems/+/medidor/general", 0), ("ems/+/zona/+/ack", 0)])
    cli.loop_start()
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
