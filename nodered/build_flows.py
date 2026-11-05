"""Genera nodered/flows.json a partir de nodered/src/*.js (python nodered/build_flows.py)."""
import json
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SRC = AQUI / "src"
TAB = "ems_tab"
BROKER = "ems_broker"


def fn(id_, nombre, archivo, x, y, wires, outputs=1):
    return {"id": id_, "type": "function", "z": TAB, "name": nombre, "func": (SRC / archivo).read_text(encoding="utf-8"),
            "outputs": outputs, "timeout": 0, "noerr": 0, "initialize": "", "finalize": "", "libs": [],
            "x": x, "y": y, "wires": wires}


def mqtt_in(id_, nombre, topic, x, y, wires):
    return {"id": id_, "type": "mqtt in", "z": TAB, "name": nombre, "topic": topic, "qos": "0", "datatype": "json",
            "broker": BROKER, "nl": False, "rap": True, "rh": 0, "inputs": 0, "x": x, "y": y, "wires": wires}


def mqtt_out(id_, nombre, x, y, retain="false"):
    return {"id": id_, "type": "mqtt out", "z": TAB, "name": nombre, "topic": "", "qos": "0", "retain": retain,
            "respTopic": "", "contentType": "", "userProps": "", "correl": "", "expiry": "", "broker": BROKER,
            "x": x, "y": y, "wires": []}


flows = [
    {"id": TAB, "type": "tab", "label": "EMS Edificio (Proyecto 2)", "disabled": False,
     "info": "Reglas EMS: ocupación + histéresis + luz natural + limitador de demanda.\n"
             "Fuente: nodered/src/*.js — regenerar con `python nodered/build_flows.py`.\n"
             "Contrato de tópicos: docs/CONTRATO.md"},
    {"id": BROKER, "type": "mqtt-broker", "name": "Mosquitto", "broker": "${MQTT_HOST}", "port": "${MQTT_PORT}",
     "clientid": "nodered-ems", "autoConnect": True, "usetls": False, "protocolVersion": "4", "keepalive": "30",
     "cleansession": True, "autoUnsubscribe": True, "birthTopic": "ems/edificio1/nodered/estado", "birthQos": "0",
     "birthRetain": "true", "birthPayload": "{\"en_linea\":true}", "birthMsg": {},
     "closeTopic": "", "closeQos": "0", "closePayload": "", "closeMsg": {},
     "willTopic": "ems/edificio1/nodered/estado", "willQos": "0", "willRetain": "true",
     "willPayload": "{\"en_linea\":false}", "willMsg": {}, "userProps": "", "sessionExpiry": ""},
    {"id": "c_info", "type": "comment", "z": TAB, "name": "Telemetría de zonas → contexto", "info": "", "x": 170, "y": 40, "wires": []},
    mqtt_in("in_zona", "telemetría zonas", "ems/+/zona/+/telemetria", 150, 80, [["fn_zona"]]),
    fn("fn_zona", "Guardar telemetría de zona", "estado_zona.js", 410, 80, []),
    {"id": "c_ems", "type": "comment", "z": TAB, "name": "Cada lectura del medidor = 1 paso EMS", "info": "", "x": 190, "y": 160, "wires": []},
    mqtt_in("in_med", "medidor general", "ems/+/medidor/general", 150, 200, [["fn_ems"]]),
    fn("fn_ems", "EMS: reglas + respuesta a la demanda", "ems_reglas.js", 440, 200,
       [["out_cmd"], ["out_estado", "dbg_estado"], ["out_alarma", "dbg_alarma"]], outputs=3),
    mqtt_out("out_cmd", "comandos zonas", 760, 160),
    mqtt_out("out_estado", "estado EMS", 750, 200),
    mqtt_out("out_alarma", "alarmas", 740, 260),
    {"id": "dbg_estado", "type": "debug", "z": TAB, "name": "estado", "active": False, "tosidebar": True,
     "console": False, "tostatus": True, "complete": "payload.dr_etapa", "targetType": "msg", "statusVal": "payload.dr_etapa",
     "statusType": "auto", "x": 740, "y": 300, "wires": []},
    {"id": "dbg_alarma", "type": "debug", "z": TAB, "name": "alarmas", "active": True, "tosidebar": True,
     "console": False, "tostatus": False, "complete": "payload", "targetType": "msg", "x": 740, "y": 340, "wires": []},
    {"id": "c_par", "type": "comment", "z": TAB, "name": "Parámetros en vivo (demo / sensibilidad)", "info": "", "x": 200, "y": 400, "wires": []},
    mqtt_in("in_par", "parámetros", "ems/+/ems/parametros", 140, 440, [["fn_par"]]),
    {"id": "inj_lim135", "type": "inject", "z": TAB, "name": "límite 135 kW", "props": [{"p": "payload"}],
     "repeat": "", "crontab": "", "once": False, "onceDelay": 0.1, "topic": "", "payload": "{\"limite_kw\":135}",
     "payloadType": "json", "x": 140, "y": 480, "wires": [["fn_par"]]},
    {"id": "inj_lim145", "type": "inject", "z": TAB, "name": "límite 145 kW (defecto)", "props": [{"p": "payload"}],
     "repeat": "", "crontab": "", "once": True, "onceDelay": 0.5, "topic": "", "payload": "{\"limite_kw\":145}",
     "payloadType": "json", "x": 170, "y": 520, "wires": [["fn_par"]]},
    {"id": "inj_sp25", "type": "inject", "z": TAB, "name": "setpoint ocupado 25 °C", "props": [{"p": "payload"}],
     "repeat": "", "crontab": "", "once": False, "onceDelay": 0.1, "topic": "", "payload": "{\"sp_ocupado\":25}",
     "payloadType": "json", "x": 170, "y": 560, "wires": [["fn_par"]]},
    fn("fn_par", "Cambiar parámetros EMS", "parametros.js", 450, 480, [["dbg_par"]]),
    {"id": "dbg_par", "type": "debug", "z": TAB, "name": "parámetros", "active": True, "tosidebar": True,
     "console": False, "tostatus": False, "complete": "payload", "targetType": "msg", "x": 690, "y": 480, "wires": []},
]

(AQUI / "flows.json").write_text(json.dumps(flows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"flows.json generado con {len(flows)} nodos")
