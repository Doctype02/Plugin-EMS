# Brief para el agente de infraestructura

Copia este documento completo como instrucción para la sesión de infraestructura.

---

**Repositorio:** `Doctype02/Plugin-EMS` · **rama:** `claude/focused-ramanujan-y99jeb` (trabajar en la misma rama, sólo dentro de `infra/`, más un `.env.example` en la raíz si hace falta).

**Contexto:** el agente de código ya entregó el gemelo digital del edificio (Python, `ems/`), las reglas EMS para Node-RED (`nodered/flows.json`) y un `Dockerfile` en la raíz para el simulador. Tu trabajo es levantar la plataforma y los dashboards. **La fuente de verdad es [`docs/CONTRATO.md`](CONTRATO.md)** (puertos, variables, tópicos MQTT y esquema InfluxDB). Guíate por el BMS de Grafana que ya tenemos (`Doctype02/Plugin-BMS`) para el estilo y la estructura de los dashboards.

## Entregables

1. **`infra/docker-compose.yml`** con:
   - `mosquitto` (eclipse-mosquitto:2): puerto 1883, `allow_anonymous true` en `infra/mosquitto/mosquitto.conf`, volumen para datos.
   - `nodered` (nodered/node-red:4.x): puerto 1880, monta `../nodered/flows.json` → `/data/flows.json`, env `MQTT_HOST=mosquitto`, `MQTT_PORT=1883`, `EMS_EDIFICIO=edificio1`. No hace falta instalar nodos extra (el flujo sólo usa nodos del núcleo).
   - `influxdb` (influxdb:2.7): puerto 8086, inicialización automática con `DOCKER_INFLUXDB_INIT_*` (org `utp`, bucket `ems`, retención 30 d, token admin desde `.env`).
   - `grafana` (grafana/grafana:11.x): puerto 3000, aprovisionamiento en `infra/grafana/provisioning/` (datasource + dashboards).
   - `simulador`: `build: ..` (Dockerfile raíz), env `MQTT_HOST`, `INFLUX_URL=http://influxdb:8086`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET`, `EMS_CONTROL=externo`, `EMS_VELOCIDAD=300`, `EMS_DIAS=0`. `depends_on` mosquitto, influxdb (healthy) y nodered.
   - Healthchecks y `restart: unless-stopped`.
2. **Datasource Grafana** InfluxDB en modo **Flux**, `uid: ems-influx`, org `utp`, bucket por defecto `ems`, token desde variable de entorno.
3. **Dashboards** (JSON aprovisionados, carpeta "EMS Edificio"), con variable `escenario` (consulta `schema.tagValues(bucket: "ems", tag: "escenario")`, por defecto `live`):
   - **EMS · Tiempo real**: potencia total / crítica / no crítica (series), demanda 15 min vs `limite_kw` (umbral), tensión, corriente, FP, kVA, energía acumulada, temperatura exterior y precio; estado de cargas por zona (state timeline de `hvac_on`, `luces_nivel`, `equipos_nivel`); tabla de las 10 zonas (temp, setpoint, ocupantes, kW); indicador DR activo y modo seguro.
   - **EMS · Zonas**: temperatura de las 10 zonas con banda de confort 21–26 °C, ocupación, lux, potencia por uso; repetir panel por `zona`.
   - **EMS · Alarmas**: tabla de `alarma` (ts, nivel, código, zona, mensaje) con colores por nivel; conteo por código; disponibilidad (`sim/estado` no está en Influx → usar `count` de `medidor` por minuto como pulso del sistema).
   - **EMS · Resultados**: comparación de escenarios desde `kpi` (energía, ahorro %, pico evitado, ahorro USD/año, VPN, payback, costo kWh evitado) y pronóstico (`pronostico`: `p_kw_pred` vs `p_kw_real`), perfiles de `medidor` superpuestos por escenario.
   - Rango por defecto en Tiempo real: `now/d` → `now/d+1d` (el tiempo simulado corre 300× más rápido). Resultados: rango absoluto `2026-09-28` → `2026-11-09`.
4. **`infra/up.sh`** (o Makefile): `docker compose up -d --build`, espera a Influx y ejecuta una vez `docker compose run --rm simulador python -m ems exportar` para cargar los escenarios offline y el pronóstico.
5. **`infra/README.md`**: requisitos, `.env`, puertos, URLs, cómo ver cada dashboard y cómo resetear volúmenes.

## Cómo verificar

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs -f simulador     # "[live] conectado; control=externo"
mosquitto_sub -h localhost -t 'ems/#' -v | head                  # telemetría y comandos fluyendo
docker compose -f infra/docker-compose.yml run --rm simulador python -m ems exportar
```

En Grafana (http://localhost:3000) deben verse las 10 zonas en vivo, DR activándose al mediodía (demanda ≈ 145 kW) y los 4 escenarios en Resultados. Node-RED (http://localhost:1880) muestra el flujo "EMS Edificio (Proyecto 2)"; los inject "límite 135 kW" / "setpoint ocupado 25 °C" cambian parámetros en vivo para la demo.

## No tocar

`ems/`, `nodered/`, `config/`, `tests/`, `Dockerfile` (son del agente de código). Si necesitas un cambio de tópico, campo o medida, primero actualiza `docs/CONTRATO.md` y avisa.
