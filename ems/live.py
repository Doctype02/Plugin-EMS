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


OCULTOS_MQTT = ("temp_real_c", "hvac_mod", "hr_real_pct", "ocupado_real", "sensor_forzado", "sensor_temp_offset_c",
                "sensor_temp_fijo_c", "sensor_hr_fijo_pct", "sensor_presencia", "sensor_congelado",
                "sensor_restante_min")


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

        fv = os.getenv("EMS_FV")
        if fv is not None and cfg.get("fv"):
            # variante del edificio: con (ConPV) o sin paneles fotovoltaicos
            cfg = {**cfg, "fv": {**cfg["fv"], "habilitado": fv.strip().lower() in ("1", "si", "sí", "true", "yes")}}
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
        cli.subscribe(f"{self.base}/auditoria")
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
            elif partes[-1] == "auditoria":
                self.influx.auditoria(data)
            elif partes[-1] == "control" and data.get("accion") == "evento":
                self._evento(ed, t, data)
            elif partes[-1] == "control" and data.get("accion") in ("unidad", "sensor"):
                self._controlador(ed, t, data)
            elif partes[-1] == "control" and data.get("accion") == "ocupacion":
                err = ed.fijar_ocupacion(data)
                print(f"[live] ocupación {data.get('zona')}: {err or 'aplicada'}")
            elif partes[-1] == "control":
                acc = data.get("accion")
                if acc == "pausa":
                    self.pausado = True
                elif acc == "reanuda":
                    self.pausado = False
                if "velocidad" in data:
                    self.velocidad = float(data["velocidad"])

    def _corte_programado(self, ed: Edificio, t):
        """Corte de red diario de demostración (`respaldo.corte_programado`): cada día laborable, después del
        encendido escalonado de la mañana, se simula un corte para ver la planta de respaldo, la toma de carga
        escalonada y el retorno a la red. `EMS_CORTE_DIARIO=no` lo desactiva."""
        cp = (self.cfg.get("respaldo") or {}).get("corte_programado")
        if not cp or os.getenv("EMS_CORTE_DIARIO", "si").strip().lower() in ("0", "no", "false"):
            return
        if cp.get("solo_laborables", True) and t.dayofweek >= 5:
            return
        hora = float(cp["hora"])
        if t.hour == int(hora) and t.minute == int(round((hora % 1) * 60)) and "corte-diario" not in ed.eventos:
            self._evento(ed, t, {"evento": "corte_energia", "id": "corte-diario", "duracion_min": cp.get("duracion_min", 30)})

    def _evento(self, ed: Edificio, t, data: dict):
        """Evento simulado desde el panel (vía Node-RED): iniciar o detener."""
        if data.get("operacion", "iniciar") == "detener":
            ed.terminar_evento(str(data.get("id", "*")))
            self._pub("sim/eventos", {"ts": t.isoformat(), "activos": self._eventos_activos(ed)}, retain=True)
            return
        ev, alarmas, err = ed.iniciar_evento(data)
        if err:
            print(f"[live] evento rechazado: {err}")
            return
        for a in alarmas:
            a = {"ts": t, **a}
            self._pub("alarma", a)
            self.influx.alarma(a)
        print(f"[live] evento {ev.tipo} iniciado ({ev.minutos:.0f} min)")
        self._pub("sim/eventos", {"ts": t.isoformat(), "activos": self._eventos_activos(ed)}, retain=True)

    def _controlador(self, ed: Edificio, t, data: dict):
        """Ajuste de una unidad VRF/PTAC o forzado del sensor de una zona (ems/controladores.py)."""
        if data["accion"] == "unidad":
            alarmas, err = ed.ajustar_unidad(data)
            objetivo = data.get("unidad")
        else:
            alarmas, err = ed.forzar_sensor(data)
            objetivo = data.get("zona")
        print(f"[live] {data['accion']} {objetivo}: {err or ('liberado' if data.get('liberar') else 'aplicado')}")
        for a in alarmas:
            a = {"ts": t, **a}
            self._pub("alarma", a)
            self.influx.alarma(a)
        if not err:
            self._pub_controladores(ed, t)

    def _pub_controladores(self, ed: Edificio, t):
        self._pub("sim/controladores", {"ts": t.isoformat(), **ed.estado_controladores()}, retain=True)

    @staticmethod
    def _eventos_activos(ed: Edificio) -> list[dict]:
        return [{"id": e.id, "evento": e.tipo, "zona": e.zona, "unidad": e.unidad, "intensidad": e.intensidad,
                 "restante_min": round(e.minutos - e.transcurrido, 1)} for e in ed.eventos.values()]

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

    # ------------------------------------------------- persistencia del estado
    def _ruta_estado(self) -> str | None:
        return os.getenv("EMS_ESTADO") or None

    def _guardar(self, ed: Edificio, t):
        ruta = self._ruta_estado()
        if not ruta:
            return
        try:
            tmp = f"{ruta}.tmp"
            with open(tmp, "w") as f:
                json.dump({"ts": t.isoformat(), "edificio": self.edif, **ed.exportar_estado()}, f)
            os.replace(tmp, ruta)
        except OSError as exc:
            print(f"[live] no se pudo guardar el estado: {exc}")

    def _restaurar(self, ed: Edificio, inicio: pd.Timestamp, max_h: float = 6.0):
        """Continúa desde el último estado guardado si es reciente: evita el pico de arranque en frío."""
        ruta = self._ruta_estado()
        if not ruta or not os.path.exists(ruta):
            return
        try:
            with open(ruta) as f:
                d = json.load(f)
            ts = pd.Timestamp(d["ts"])
            ini = inicio if inicio.tzinfo else inicio.tz_localize(self.tz)
            edad_h = abs((ini - ts).total_seconds()) / 3600
            if d.get("edificio") != self.edif or edad_h > max_h:
                print(f"[live] estado guardado descartado ({edad_h:.1f} h de antigüedad)")
                return
            n = ed.restaurar_estado(d)
            print(f"[live] estado restaurado de {ts} ({n} zonas, e_kwh {ed.e_kwh:.1f})")
        except (OSError, ValueError, KeyError) as exc:
            print(f"[live] estado guardado ilegible: {exc}")

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
        self._restaurar(ed, inicio)
        tel = med = None
        lat_ultima = 0.0
        while self.activo:
            idx = m_clima.indice(inicio, dias_bloque, paso, self.tz)
            cl = m_clima.generar(cfg, idx)
            oc = m_ocup.generar(zonas(cfg), idx, cfg["ocupacion"], cfg=cfg)
            for i, t in enumerate(idx):
                if not self.activo:
                    break
                while self.pausado and self.activo:
                    time.sleep(0.2)
                    self._procesar_cola(ed, t)
                t_real = time.time()
                self._corte_programado(ed, t)
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
                tel, med = ed.paso(cl.iloc[i].to_dict(), oc.iloc[i].to_dict(), t.hour * 60 + t.minute, t.dayofweek)
                med["precio_usd_kwh"] = precio(cfg, t)
                if ed._fin_eventos:
                    self._pub("sim/eventos", {"ts": t.isoformat(), "activos": self._eventos_activos(ed)}, retain=True)
                ts = t.isoformat()
                for z in tel:
                    z["ts"] = ts
                    # el EMS sólo ve lo que miden los sensores (no el estado real ni si están forzados)
                    pub = {k: v for k, v in z.items() if k not in OCULTOS_MQTT}
                    self._pub(f"zona/{z['zona']}/telemetria", pub)
                    self.influx.zona(t, z)
                self._pub_controladores(ed, t)
                for u in ed.estado_controladores()["unidades"]:
                    self.influx.unidad(t, u)
                self._pub("medidor/general", {"ts": ts, **med})
                self.influx.medidor(t, med)
                self.influx.flush(forzar=True)  # un paso = un lote (con velocidad 1 hay 1 paso cada 5 min)
                self._guardar(ed, t)
                # Espera al siguiente paso atendiendo la cola: con velocidad 1 un paso dura 5 min y, si se
                # durmiera de corrido, los eventos y órdenes del panel tardarían hasta 5 min en aplicarse.
                # Sus alarmas salen al momento; el efecto en la telemetría, en el paso siguiente.
                while self.activo and time.time() - t_real < paso * 60 / self.velocidad:
                    time.sleep(min(0.5, max(0.0, paso * 60 / self.velocidad - (time.time() - t_real))))
                    _, lats = self._procesar_cola(ed, t)
                    if lats:
                        lat_ultima = sum(lats) / len(lats)
                    self.influx.flush(forzar=True)
            if self.dias > 0:
                break
            inicio = idx[-1] + pd.Timedelta(minutes=paso)
        self.influx.cerrar()
        self._pub("sim/estado", {"en_linea": False}, retain=True)
        self.cli.loop_stop()
        self.cli.disconnect()
