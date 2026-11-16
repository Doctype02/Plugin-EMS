# Contrato de interfaces (código ⇄ infraestructura)

Este archivo es la fuente de verdad. Cambios aquí primero, luego en el código o en `infra/`.

## 1. Servicios, puertos y variables de entorno

| Servicio | Host (en compose) | Puerto | Notas |
|---|---|---|---|
| Mosquitto | `mosquitto` | 1883 | anónimo permitido en red interna (demo) |
| Node-RED | `nodered` | 1880 | monta `nodered/flows.json` del repo en `/data/flows.json` |
| InfluxDB 2.x | `influxdb` | 8086 | org `utp`, bucket `ems`, retención ≥ 30 d |
| Grafana | `grafana` | 3000 | datasource InfluxDB **Flux**, uid `ems-influx`; plugin `doctype02-ems-panel` (sin firmar) montado desde `grafana-ems-panel/dist` |
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
| `EMS_INICIO` | hoy 00:00 (America/Panama) | inicio del tiempo simulado: ISO-8601, o `ahora` (con `EMS_VELOCIDAD=1` el tiempo simulado coincide con el reloj: recomendado para despliegue permanente) |
| `EMS_DIAS` | `1` | días a simular en modo live (`0` = infinito, reinicia cada día) |
| `EMS_FV` | `fv.habilitado` del YAML (`true`) | variante del edificio: `si` = con paneles fotovoltaicos (ConPV), `no` = sin paneles |

Node-RED necesita `MQTT_HOST` y `MQTT_PORT` (el nodo broker usa `${MQTT_HOST}`/`${MQTT_PORT}`).

## 2. Tópicos MQTT (JSON UTF-8, QoS 0 salvo indicación)

Prefijo: `ems/{edificio}` (por defecto `ems/edificio1`). Zonas: `Z01` … `Z26` (§4). `ts` = tiempo **simulado** ISO-8601 con zona (`-05:00`).

| Tópico | Dirección | Contenido |
|---|---|---|
| `ems/edificio1/zona/{Z}/telemetria` | sim → | `{ts, zona, nombre, tipo, critica, temp_c, setpoint_c, ocupantes, ocupado, lux, luces_nivel, equipos_nivel, hvac_on, hvac_enable, p_luces_kw, p_equipos_kw, p_hvac_kw, p_total_kw}` |
| `ems/edificio1/medidor/general` | sim → | `{ts, p_total_kw, p_critica_kw, p_no_critica_kw, p_hvac_kw, p_luces_kw, p_equipos_kw, p_fija_kw, q_kvar, s_kva, fp, v_ll, i_a, e_kwh, demanda_15min_kw, t_ext_c, hr_pct, irr_wm2, precio_usd_kwh, red_ok, ups_kw?, ups_min?, eventos?, p_fv_kw?, p_red_kw?, e_fv_kwh?}` (durante un corte `p_total_kw = 0`, `red_ok = false` y el UPS informa `ups_kw`/`ups_min`). `p_total_kw` es el consumo del edificio; con la variante FV (`EMS_FV=si`) se agregan la generación `p_fv_kw`, la importación neta `p_red_kw = p_total_kw − p_fv_kw` (negativa = inyección) y `e_fv_kwh`, y `demanda_15min_kw` pasa a ser la de la acometida (importación neta) |
| `ems/edificio1/zona/{Z}/cmd` | Node-RED → sim | cualquiera de `{setpoint_c, hvac_enable, luces_nivel (0–1), equipos_nivel (0–1), ventilacion ("dcv"\|"fija"), hvac_mod (0–1 fuerza capacidad; null = termostato)}` + opcional `cmd_id`, `wall_ms` (epoch ms al enviar, para latencia) |
| `ems/edificio1/zona/{Z}/ack` | sim → | `{cmd_id, zona, ts, recibido_wall_ms, aplicado: true}` (latencia = `recibido_wall_ms` − `wall_ms` del cmd) |
| `ems/edificio1/ems/estado` | Node-RED/sim → | `{ts, origen, modo, dr_activo, limite_kw, n_alarmas, latencia_ms}` |
| `ems/edificio1/alarma` | Node-RED/sim → | `{ts, nivel: info\|warn\|crit, codigo, zona, mensaje}` |
| `ems/edificio1/pronostico` | sim → (retained) | `{generado, modelo, mae_kw, rmse_kw, puntos: [{ts, p_kw}]}` |
| `ems/edificio1/sim/control` | → sim | `{accion: pausa\|reanuda, velocidad?}` o evento simulado `{accion: "evento", operacion: iniciar\|detener, id, evento, zona?, unidad?, duracion_min, intensidad?}` (`ems/eventos.py`) |
| `ems/edificio1/sim/eventos` | sim → (retenido) | `{ts, activos: [{id, evento, zona, unidad, intensidad, restante_min}]}` |
| `ems/edificio1/sim/estado` | sim → (retained, LWT) | `{en_linea, control, velocidad}` — usar para el panel de disponibilidad |
| `ems/edificio1/nodered/estado` | Node-RED → (retained, LWT) | `{en_linea}` |
| `ems/edificio1/ems/parametros` | → Node-RED | p. ej. `{limite_kw: 153, sp_ocupado: 25}` (cambio de parámetros en vivo) |
| `ems/edificio1/ems/override` | panel/operador → Node-RED | control manual temporal: `{zona, setpoint_c?, hvac_enable?, luces_nivel?, equipos_nivel?, duracion_min (1–1440, def. 60), usuario?}` o `{tipo: "liberar", zona: "Z03"\|"*"}`. Prioridad sobre reglas y limitador de demanda; Z09/Z10 se rechazan. `ems/estado` informa `manual: [zonas]` |

### Endpoint HTTP de control (Node-RED, puerto 1880)

`POST /ems/control` con JSON (CORS abierto, `OPTIONS` responde 204). Lo usa el panel de Grafana en modo en vivo:

| `tipo` | Campos | Publica en |
|---|---|---|
| `override` | `zona`, `setpoint_c?`, `hvac_enable?`, `luces_nivel?`, `equipos_nivel?`, `duracion_min?`, `usuario?` | `ems/<edif>/ems/override` |
| `liberar` | `zona` (`Z01`…`Z26` o `*`) | `ems/<edif>/ems/override` |
| `parametros` | `limite_kw?` (0.25–3.3 × `ems.limite_demanda_kw`: 42–561 kW), `sp_ocupado?` (20–28) | `ems/<edif>/ems/parametros` |

Respuesta `{ok, mensaje, …}` con 200, o 400 si el comando no es válido (zona crítica, sin cambios, fuera de rango).

Códigos de alarma: `TEMP_ALTA`, `TEMP_BAJA`, `PICO_DEMANDA`, `DR_ACTIVO`, `SENSOR_CONGELADO`, `SENSOR_FUERA_RANGO`, `HVAC_ON_SIN_OCUPACION`, `SERVIDOR_TEMP`, `COMANDO_PERDIDO`.

## 3. Esquema InfluxDB (bucket `ems`)

Timestamp = tiempo simulado. Precisión: segundos. En modo `externo` el simulador también guarda en `ems` y `alarma` lo que Node-RED publica en `ems/<edif>/ems/estado` y `ems/<edif>/alarma` (con el tiempo simulado del paso en curso).

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

// Temperatura de las 26 zonas
from(bucket: "ems") |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r._measurement == "zona" and r._field == "temp_c" and r.escenario == "${escenario}")
  |> keep(columns: ["_time", "_value", "zona"])

// Comparación de escenarios (KPI)
from(bucket: "ems") |> range(start: 0)
  |> filter(fn: (r) => r._measurement == "kpi") |> last()
  |> pivot(rowKey: ["escenario"], columnKey: ["_field"], valueColumn: "_value")
```

**Rango de tiempo en Grafana:** como el tiempo es simulado y avanza más rápido que el real, usar `now/d` → `now/d+1d` (día de hoy completo) en modo live; los escenarios offline se escriben en 4 semanas tipo de 2026 (9 feb, 11 may, 10 ago y 2 nov, de lunes a domingo); la variante con paneles se exporta como `<escenario>_fv` (sólo `medidor` y `kpi`).

## 4. Zonas del edificio

| Zona | Nombre | Planta | Tipo | Climatización | Crítica |
|---|---|---|---|---|---|
| Z01 | Recepción | PB | recepcion | VRF-PB | no |
| Z02 | Cubículos | PB | cubiculos | VRF-PB | no |
| Z03 | Sala de conferencias | PB | conferencia | VRF-PB | no |
| Z04 | Pasillo PB | PB | pasillo | VRF-PB | no |
| Z05 | Baños PB | PB | bano | PTAC-PB | no |
| Z06 | Cuarto de servidores | PB | servidores | VRF-SRV | **sí** |
| Z07 | Oficina 1 P1 | P1 | oficina | VRF-P1 | no |
| Z08 | Oficina 2 P1 | P1 | oficina | VRF-P1 | no |
| Z09 | Oficina abierta P1 | P1 | oficina_abierta | VRF-P1 | no |
| Z10 | Pasillo P1 | P1 | pasillo | VRF-P1 | no |
| Z11 | Baños P1 | P1 | bano | PTAC-P1 | no |
| Z12 | Oficina 1 P2 | P2 | oficina | VRF-P2 | no |
| Z13 | Oficina 2 P2 | P2 | oficina | VRF-P2 | no |
| Z14 | Oficina abierta P2 | P2 | oficina_abierta | VRF-P2 | no |
| Z15 | Pasillo P2 | P2 | pasillo | VRF-P2 | no |
| Z16 | Baños P2 | P2 | bano | PTAC-P2 | no |
| Z17 | Oficina 1 P3 | P3 | oficina | VRF-P3 | no |
| Z18 | Oficina 2 P3 | P3 | oficina | VRF-P3 | no |
| Z19 | Oficina abierta P3 | P3 | oficina_abierta | VRF-P3 | no |
| Z20 | Pasillo P3 | P3 | pasillo | VRF-P3 | no |
| Z21 | Baños P3 | P3 | bano | PTAC-P3 | no |
| Z22 | Oficina 1 P4 | P4 | oficina | VRF-P4 | no |
| Z23 | Oficina 2 P4 | P4 | oficina | VRF-P4 | no |
| Z24 | Oficina abierta P4 | P4 | oficina_abierta | VRF-P4 | no |
| Z25 | Pasillo P4 | P4 | pasillo | VRF-P4 | no |
| Z26 | Baños P4 | P4 | bano | PTAC-P4 | no |

Edificio de 5 plantas (PB y P1–P4) de 20 × 20 m según el modelo OpenStudio/EnergyPlus `Edificio_Sin_EMS`
(2000 m², 1980 m² acondicionados); núcleo de elevador de 2 × 2 m por planta, no acondicionado (carga fija
"Ascensor"). Climatización: 6 sistemas VRF (VRF-PB, VRF-P1…P4 y VRF-SRV para el cuarto de servidores) y 5 PTAC
en los baños (PTAC-PB, PTAC-P1…P4). Variante `Edificio_Sin_EMS_ConPV`: 6 campos FV sobre la azotea (400 m²
brutos, 60 % activo, η 0.24, inversor 0.96 ≈ 55 kWp). Parámetros completos en `config/edificio.yaml`. Las zonas
críticas ignoran `hvac_enable=false`, `equipos_nivel` y `setpoint_c` (setpoint fijo).

### Cantidad de personas (panel → Node-RED → gemelo)

`POST /ems/control` con `{tipo: "ocupacion", zona: <zona con aforo>, personas, duracion_min}` (0 al doble del
aforo), `{tipo: "ocupacion", zona: "*", porcentaje, duracion_min}` (0–200 % del horario) o
`{tipo: "ocupacion", zona, liberar: true}`. Se publica en `ems/edificio1/sim/control` con `accion: "ocupacion"`;
el medidor informa `ocupacion_forzada: [zonas]` mientras dure.

### Eventos simulados (panel → Node-RED → gemelo)

`POST /ems/control` con `{tipo: "evento", accion: "iniciar", id, evento, zona?, unidad?, duracion_min, intensidad?}`
o `{tipo: "evento", accion: "detener", id | "*"}`. Tipos: `incendio`, `corte_energia` (intensidad = autonomía
del UPS en min), `falla_vrf` (unidad: cualquier id de `sistemas_vrf`, incluidos los PTAC), `falla_terminal`, `puerta_abierta` (%), `sensor`,
`ola_calor` (°C), `sobreocupacion` (% sobre el aforo), `pico_carga` (kW). Alarmas nuevas: `INCENDIO`,
`CORTE_ENERGIA`, `EN_UPS`, `UPS_AGOTADO`, `FALLA_VRF`, `FALLA_TERMINAL`, `PUERTA_ABIERTA`, `OLA_CALOR`,
`SOBREOCUPACION`, `CARGA_EXTRA`. Rango de `limite_kw` en `parametros`: 42–561 kW.
