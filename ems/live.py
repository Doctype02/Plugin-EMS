"""Modo en vivo: el gemelo digital publica por MQTT y obedece comandos (Node-RED o reglas Python).

Tópicos y payloads: docs/CONTRATO.md (§2). El tiempo simulado avanza `velocidad` veces más rápido que
el real (por defecto 300 → un paso de 5 min por segundo).
"""
from __future__ import annotations

import json
import os
import queue
import signal
import threading
import time

import pandas as pd

from . import clima as m_clima
from . import ocupacion as m_ocup
from . import pronostico as m_pron
from .config import zonas
from .control import crear, precio
from .edificio import Edificio
from .influx import Escritor
from .simulacion import simular


def _hoy(tz: str) -> str:
    return pd.Timestamp.now(tz=tz).normalize().strftime("%Y-%m-%d %H:%M")


def resolver_inicio(valor: str | None, tz: str, paso_min: int = 5) -> str:
    """`ahora` = hora actual redondeada al paso (tiempo simulado = reloj real con velocidad 1);
    vacío = hoy 00:00; cualquier otro valor se interpreta como fecha ISO."""
    if not valor:
        return _hoy(tz)
    if valor.strip().lower() == "ahora":
        return pd.Timestamp.now(tz=tz).floor(f"{paso_min}min").strftime("%Y-%m-%d %H:%M")
    return valor


class Puente:
    def __init__(self, cfg: dict, control: str | None = None, velocidad: float | None = None,
                 inicio: str | None = None, dias: float | None = None, host: str | None = None,
                 port: int | None = None):
        import paho.mqtt.client as mqtt

        self.cfg = cfg
        self.tz = cfg["edificio"]["zona_horaria"]
        self.control = control or os.getenv("EMS_CONTROL", "externo")
        self.velocidad = float(velocidad or os.getenv("EMS_VELOCIDAD", 300))
        self.inicio = resolver_inicio(inicio or os.getenv("EMS_INICIO"), self.tz, cfg["edificio"]["paso_min"])
        self.dias = float(dias if dias is not None else os.getenv("EMS_DIAS", 1))
        self.edif = os.getenv("EMS_EDIFICIO", cfg["edificio"]["nombre"])
        self.base = f"ems/{self.edif}"
        self.cola: queue.Queue = queue.Queue()
        self.pausado = False
        self.activo = True
        self.influx = Escritor(edificio=self.edif)

        self.cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"ems-sim-{self.edif}")
        self.cli.on_connect = self._on_connect
        self.cli.on_message = self._on_message
        self.cli.will_set(f"{self.base}/sim/estado", json.dumps({"en_linea": False}), retain=True)
        host = host or os.getenv("MQTT_HOST", "localhost")
        port = int(port or os.getenv("MQTT_PORT", 1883))
        for intento in range(30):
            try:
                self.cli.connect(host, port, keepalive=30)
                break
            except OSError as exc:
                print(f"[live] esperando broker {host}:{port} ({exc}); reintento {intento + 1}/30")
                time.sleep(2)
        else:
            raise SystemExit("[live] no se pudo conectar al broker MQTT")
        self.cli.loop_start()

    # ---------------------------------------------------------------- MQTT
    def _on_connect(self, cli, userdata, flags, rc, props=None):
        cli.subscribe(f"{self.base}/zona/+/cmd")
        cli.subscribe(f"{self.base}/sim/control")
        if self.control == "externo":
            # estado y alarmas que publica Node-RED → InfluxDB (el panel en vivo los lee de ahí)
            cli.subscribe(f"{self.base}/ems/estado")
            cli.subscribe(f"{self.base}/alarma")
        cli.publish(f"{self.base}/sim/estado", json.dumps({"en_linea": True, "control": self.control,
                                                           "velocidad": self.velocidad}), retain=True)
        print(f"[live] conectado; control={self.control} velocidad={self.velocidad}x inicio={self.inicio}")

    def _on_message(self, cli, userdata, msg):
        try:
            data = json.loads(msg.payload or b"{}")
        except json.JSONDecodeError:
            return
        self.cola.put((msg.topic, data, time.time() * 1000))

    def _pub(self, sub: str, data, retain: bool = False):
        self.cli.publish(f"{self.base}/{sub}", json.dumps(data, default=str), retain=retain)

    # ---------------------------------------------------------------- bucle
    def _procesar_cola(self, ed: Edificio, t) -> tuple[int, list[float]]:
        n, lats = 0, []
        while True:
            try:
                topic, data, recibido = self.cola.get_nowait()
            except queue.Empty:
                return n, lats
            partes = topic.split("/")
            if partes[-1] == "cmd" and self.control == "externo":
                zid = partes[-2]
                ed.aplicar({zid: data})
                n += 1
                if "wall_ms" in data:
                    lats.append(recibido - float(data["wall_ms"]))
                self._pub(f"zona/{zid}/ack", {"cmd_id": data.get("cmd_id"), "zona": zid, "ts": t.isoformat(),
                                              "recibido_wall_ms": recibido, "aplicado": True})
            elif partes[-2:] == ["ems", "estado"] and self.control == "externo":
                est = dict(data)
                est.setdefault("modo", "nodered")
                self.influx.ems(t, est)
            elif partes[-1] == "alarma" and self.control == "externo":
                a = {"ts": t, "nivel": data.get("nivel", "warn"), "codigo": data.get("codigo", "ALARMA"),
                     "zona": data.get("zona", "EDIF"), "mensaje": data.get("mensaje", ""), "valor": data.get("valor")}
                self.influx.alarma(a)
            elif partes[-1] == "control":
                acc = data.get("accion")
                if acc == "pausa":
                    self.pausado = True
                elif acc == "reanuda":
                    self.pausado = False
                if "velocidad" in data:
                    self.velocidad = float(data["velocidad"])

    def publicar_pronostico(self):
        """Entrena la regresión con 3 semanas simuladas previas y publica el día pronosticado."""
        try:
            t0 = pd.Timestamp(self.inicio).tz_localize(self.tz) if pd.Timestamp(self.inicio).tzinfo is None \
                else pd.Timestamp(self.inicio)
            hist = simular(self.cfg, "reglas_dr", dias=21, inicio=(t0 - pd.Timedelta(days=21)).strftime("%Y-%m-%d %H:%M"))
            serie = m_pron.dia_siguiente(hist.medidor)
            _, met = m_pron.evaluar(hist.medidor, dias_prueba=3, usar_sarimax=False)
            mr = met.loc["regresion"]
            self._pub("pronostico", {"generado": pd.Timestamp.now(tz=self.tz).isoformat(), "modelo": "regresion",
                                     "mae_kw": round(mr.mae_kw, 2), "rmse_kw": round(mr.rmse_kw, 2),
                                     "puntos": [{"ts": ts.isoformat(), "p_kw": round(v, 2)} for ts, v in serie.items()]},
                      retain=True)
            self.influx.pronostico(serie, "regresion")
            self.influx.flush(forzar=True)
            print(f"[live] pronóstico publicado (MAE {mr.mae_kw:.2f} kW, RMSE {mr.rmse_kw:.2f} kW)")
        except Exception as exc:  # el pronóstico no debe tumbar la demo
            print(f"[live] pronóstico omitido: {exc}")

    def correr(self):
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, lambda *a: setattr(self, "activo", False))
        self.publicar_pronostico()
        cfg = self.cfg
        paso = cfg["edificio"]["paso_min"]
        dias_bloque = self.dias if self.dias > 0 else 1
        ctrl = None if self.control == "externo" else crear("baseline" if self.control == "baseline" else "reglas_dr", cfg)
        ed = Edificio(cfg)
        inicio = pd.Timestamp(self.inicio)
        tel = med = None
        lat_ultima = 0.0
        while self.activo:
            idx = m_clima.indice(inicio, dias_bloque, paso, self.tz)
            cl = m_clima.generar(cfg, idx)
            oc = m_ocup.generar(zonas(cfg), idx, cfg["ocupacion"])
            for i, t in enumerate(idx):
                if not self.activo:
                    break
                while self.pausado and self.activo:
                    time.sleep(0.2)
                    self._procesar_cola(ed, t)
                t_real = time.time()
                _, lats = self._procesar_cola(ed, t)
                if lats:
                    lat_ultima = sum(lats) / len(lats)
                if ctrl is not None and tel is not None:
                    t0 = time.perf_counter()
                    ed.aplicar(ctrl.decidir(t, tel, med))
                    lat_ultima = (time.perf_counter() - t0) * 1000
                    est = ctrl.estado(t)
                    est["latencia_ms"] = round(lat_ultima, 3)
                    self._pub("ems/estado", est)
                    self.influx.ems(t, est)
                    for a in ctrl.alarmas:
                        self._pub("alarma", a)
                        self.influx.alarma(a)
                tel, med = ed.paso(cl.iloc[i].to_dict(), oc.iloc[i].to_dict(), t.hour * 60 + t.minute)
                med["precio_usd_kwh"] = precio(cfg, t)
                ts = t.isoformat()
                for z in tel:
                    z["ts"] = ts
                    pub = {k: v for k, v in z.items() if k not in ("temp_real_c", "hvac_mod")}
                    self._pub(f"zona/{z['zona']}/telemetria", pub)
                    self.influx.zona(t, z)
                self._pub("medidor/general", {"ts": ts, **med})
                self.influx.medidor(t, med)
                self.influx.flush()
                espera = paso * 60 / self.velocidad - (time.time() - t_real)
                if espera > 0:
                    time.sleep(espera)
            if self.dias > 0:
                break
            inicio = idx[-1] + pd.Timedelta(minutes=paso)
        self.influx.cerrar()
        self._pub("sim/estado", {"en_linea": False}, retain=True)
        self.cli.loop_stop()
        self.cli.disconnect()
