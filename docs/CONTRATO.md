# Contrato de interfaces (código ⇄ infraestructura)

Este archivo es la fuente de verdad. Cambios aquí primero, luego en el código o en `infra/`.

## 1. Servicios, puertos y variables de entorno

| Servicio | Host (en compose) | Puerto | Notas |
|---|---|---|---|
| Mosquitto | `mosquitto` | 1883 | anónimo permitido en red interna (demo) |
| Node-RED | `nodered` | 1880 | monta `nodered/flows.json` del repo en `/data/flows.json` |
| InfluxDB 2.x | `influxdb` | 8086 | org `utp`, bucket `ems`, retención ≥ 30 d |
| Grafana | `grafana` | 3000 | datasource InfluxDB **Flux**, uid `ems-influx` |
| Simulador | `simulador` | — | `docker build .` en la raíz del repo |

Variables que lee el simulador (todas opcionales; sin `INFLUX_URL` no escribe a la BD):

| Variable | Por defecto | Uso |
|---|---|---|
| `MQTT_HOST` | `localhost` | broker |
| `MQTT_PORT` | `1883` | |
| `EMS_EDIFICIO` | `edificio1` | segmento del tópico |
| `INFLUX_URL` | — | p. ej. `http://influxdb:8086` |
| `INFLUX_TOKEN` | — | token con escritura en `ems` |
| `INFLUX_ORG` | `utp` | |
| `INFLUX_BUCKET` | `ems` | |
| `EMS_CONTROL` | `externo` | `externo` = obedece a Node-RED; `interno` = reglas Python; `baseline` = sin EMS |
| `EMS_VELOCIDAD` | `300` | segundos simulados por segundo real (300 → 1 paso de 5 min por segundo) |
| `EMS_INICIO` | hoy 00:00 (America/Panama) | inicio del tiempo simulado, ISO-8601 |
| `EMS_DIAS` | `1` | días a simular en modo live (`0` = infinito, reinicia cada día) |

Node-RED necesita `MQTT_HOST` y `MQTT_PORT` (el nodo broker usa `${MQTT_HOST}`/`${MQTT_PORT}`).

## 2. Tópicos MQTT (JSON UTF-8, QoS 0 salvo indicación)

Prefijo: `ems/{edificio}` (por defecto `ems/edificio1`). Zonas: `Z01` … `Z10`. `ts` = tiempo **simulado** ISO-8601 con zona (`-05:00`).

| Tópico | Dirección | Contenido |
|---|---|---|
| `ems/edificio1/zona/{Z}/telemetria` | sim → | `{ts, zona, nombre, tipo, critica, temp_c, setpoint_c, ocupantes, ocupado, lux, luces_nivel, equipos_nivel, hvac_on, hvac_enable, p_luces_kw, p_equipos_kw, p_hvac_kw, p_total_kw}` |
| `ems/edificio1/medidor/general` | sim → | `{ts, p_total_kw, p_critica_kw, p_no_critica_kw, p_hvac_kw, p_luces_kw, p_equipos_kw, p_fija_kw, q_kvar, s_kva, fp, v_ll, i_a, e_kwh, demanda_15min_kw, t_ext_c, hr_pct, irr_wm2, precio_usd_kwh}` |
| `ems/edificio1/zona/{Z}/cmd` | Node-RED → sim | cualquiera de `{setpoint_c, hvac_enable, luces_nivel (0–1), equipos_nivel (0–1), ventilacion ("dcv"\|"fija"), hvac_mod (0–1 fuerza capacidad; null = termostato)}` + opcional `cmd_id`, `wall_ms` (epoch ms al enviar, para latencia) |
| `ems/edificio1/zona/{Z}/ack` | sim → | `{cmd_id, zona, ts, recibido_wall_ms, aplicado: true}` (latencia = `recibido_wall_ms` − `wall_ms` del cmd) |
| `ems/edificio1/ems/estado` | Node-RED/sim → | `{ts, origen, modo, dr_activo, limite_kw, n_alarmas, latencia_ms}` |
| `ems/edificio1/alarma` | Node-RED/sim → | `{ts, nivel: info\|warn\|crit, codigo, zona, mensaje}` |
| `ems/edificio1/pronostico` | sim → (retained) | `{generado, modelo, mae_kw, rmse_kw, puntos: [{ts, p_kw}]}` |
| `ems/edificio1/sim/control` | → sim | `{accion: pausa\|reanuda, velocidad?}` |
| `ems/edificio1/sim/estado` | sim → (retained, LWT) | `{en_linea, control, velocidad}` — usar para el panel de disponibilidad |
| `ems/edificio1/nodered/estado` | Node-RED → (retained, LWT) | `{en_linea}` |
| `ems/edificio1/ems/parametros` | → Node-RED | p. ej. `{limite_kw: 135, sp_ocupado: 25}` (cambio de parámetros en vivo) |

Códigos de alarma: `TEMP_ALTA`, `TEMP_BAJA`, `PICO_DEMANDA`, `DR_ACTIVO`, `SENSOR_CONGELADO`, `SENSOR_FUERA_RANGO`, `HVAC_ON_SIN_OCUPACION`, `SERVIDOR_TEMP`, `COMANDO_PERDIDO`.

## 3. Esquema InfluxDB (bucket `ems`)

Timestamp = tiempo simulado. Precisión: segundos.

| Measurement | Tags | Fields |
|---|---|---|
| `zona` | `edificio`, `zona`, `nombre`, `tipo`, `critica` (`si`/`no`), `escenario` | `temp_c`, `setpoint_c`, `ocupantes`, `ocupado` (0/1), `lux`, `luces_nivel`, `equipos_nivel`, `hvac_on` (0/1), `hvac_enable` (0/1), `p_luces_kw`, `p_equipos_kw`, `p_hvac_kw`, `p_total_kw` |
| `medidor` | `edificio`, `escenario` | todos los campos numéricos de `medidor/general` |
| `ems` | `edificio`, `escenario`, `modo` | `dr_activo` (0/1), `limite_kw`, `n_alarmas`, `latencia_ms` |
| `alarma` | `edificio`, `escenario`, `nivel`, `codigo`, `zona` | `mensaje` (string), `valor` |
| `pronostico` | `edificio`, `modelo` | `p_kw_pred`, `p_kw_real` |
| `kpi` | `edificio`, `escenario` | `energia_kwh`, `ahorro_pct`, `energia_ahorrada_kwh`, `pico_kw`, `pico_evitado_kw`, `costo_usd`, `ahorro_usd`, `co2_kg`, `confort_pct`, `roi_pct`, `payback_anios`, `costo_kwh_evitado_usd` |

`escenario` = `live` en modo vivo; en offline el nombre del escenario (`baseline`, `reglas`, `reglas_dr`, `mpc`, `ola_calor`, …) para comparar en Grafana.

### Consultas Flux de referencia para Grafana

```flux
// Potencia total del edificio
from(bucket: "ems") |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "medidor" and r._field == "p_total_kw" and r.escenario == "${escenario}")

// Temperatura de las 10 zonas
from(bucket: "ems") |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "zona" and r._field == "temp_c" and r.escenario == "${escenario}")
  |> keep(columns: ["_time", "_value", "zona"])

// Comparación de escenarios (KPI)
from(bucket: "ems") |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "kpi") |> last()
  |> pivot(rowKey: ["escenario"], columnKey: ["_field"], valueColumn: "_value")
```

**Rango de tiempo en Grafana:** como el tiempo es simulado y avanza más rápido que el real, usar `now/d` → `now/d+1d` (día de hoy completo) en modo live; los escenarios offline se escriben con fecha `2026-11-02` (lunes) en adelante.

## 4. Zonas del edificio

| Zona | Nombre | Tipo | Crítica |
|---|---|---|---|
| Z01 | Lobby | lobby | no |
| Z02 | Oficinas P1 Norte | oficina | no |
| Z03 | Oficinas P1 Sur | oficina | no |
| Z04 | Oficinas P2 Norte | oficina | no |
| Z05 | Oficinas P2 Sur | oficina | no |
| Z06 | Sala de conferencias | conferencia | no |
| Z07 | Laboratorio | laboratorio | no |
| Z08 | Cafetería | cafeteria | no |
| Z09 | Cuarto de servidores | servidores | **sí** |
| Z10 | Seguridad / UPS / emergencia | soporte | **sí** |

Parámetros completos en `config/edificio.yaml`. Las zonas críticas ignoran `hvac_enable=false`, `equipos_nivel` y `setpoint_c` (setpoint fijo).
