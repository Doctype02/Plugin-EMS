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
| `EMS_CORTE_DIARIO` | `si` | `no` desactiva el corte de red de demostración de cada día laborable (`respaldo.corte_programado`: 10:00, 30 min) |
| `EMS_ESTADO` | — (el servicio usa `/var/lib/ems/estado.json`) | archivo JSON donde `live` guarda el estado físico cada paso y del que lo restaura al arrancar si tiene < 6 h; evita el pico de arranque en frío tras un reinicio |
| `EMS_DIAS` | `1` | días a simular en modo live (`0` = infinito, reinicia cada día) |
| `EMS_FV` | `fv.habilitado` del YAML (`true`) | variante del edificio: `si` = con paneles fotovoltaicos (ConPV), `no` = sin paneles |

Node-RED necesita `MQTT_HOST` y `MQTT_PORT` (el nodo broker usa `${MQTT_HOST}`/`${MQTT_PORT}`).

## 2. Tópicos MQTT (JSON UTF-8, QoS 0 salvo indicación)

Prefijo: `ems/{edificio}` (por defecto `ems/edificio1`). Zonas: `Z01` … `Z26` (§4). `ts` = tiempo **simulado** ISO-8601 con zona (`-05:00`).

| Tópico | Dirección | Contenido |
|---|---|---|
| `ems/edificio1/zona/{Z}/telemetria` | sim → | `{ts, zona, nombre, tipo, critica, temp_c, setpoint_c, hr_pct, ocupantes, ocupado, lux, luces_nivel, equipos_nivel, hvac_on, hvac_enable, p_luces_kw, p_equipos_kw, p_hvac_kw, p_total_kw}`. `temp_c`, `hr_pct` y `ocupado` son **lo que mide el sensor** (pueden estar forzados, §2.1); el estado real y el detalle del forzado no se publican por MQTT (sólo van a InfluxDB), igual que un sensor real mal calibrado |
| `ems/edificio1/medidor/general` | sim → | `{ts, p_total_kw, p_critica_kw, p_no_critica_kw, p_hvac_kw, p_luces_kw, p_equipos_kw, p_fija_kw, q_kvar, s_kva, fp, v_ll, i_a, e_kwh, demanda_15min_kw, t_ext_c, hr_pct, irr_wm2, precio_usd_kwh, red_ok, ups_kw?, ups_min?, eventos?, p_fv_kw?, p_red_kw?, e_fv_kwh?}` (durante un corte `p_total_kw = 0`, `red_ok = false` y el UPS informa `ups_kw`/`ups_min`). `p_total_kw` es el consumo del edificio; con la variante FV (`EMS_FV=si`) se agregan la generación `p_fv_kw`, la importación neta `p_red_kw = p_total_kw − p_fv_kw` (negativa = inyección) y `e_fv_kwh`, y `demanda_15min_kw` pasa a ser la de la acometida (importación neta) |
| `ems/edificio1/zona/{Z}/cmd` | Node-RED → sim | cualquiera de `{setpoint_c, hvac_enable, luces_nivel (0–1), equipos_nivel (0–1), ventilacion ("dcv"\|"fija"), hvac_mod (0–1 fuerza capacidad; null = termostato)}` + opcional `cmd_id`, `wall_ms` (epoch ms al enviar, para latencia) |
| `ems/edificio1/zona/{Z}/ack` | sim → | `{cmd_id, zona, ts, recibido_wall_ms, aplicado: true}` (latencia = `recibido_wall_ms` − `wall_ms` del cmd) |
| `ems/edificio1/ems/estado` | Node-RED/sim → | `{ts, origen, modo, dr_activo, limite_kw, n_alarmas, latencia_ms, reglas: {…}}`; `reglas` = zonas afectadas por cada regla en el paso (ver medida `ems`) |
| `ems/edificio1/alarma` | Node-RED/sim → | `{ts, nivel: info\|warn\|crit, codigo, zona, mensaje}` |
| `ems/edificio1/pronostico` | sim → (retained) | `{generado, modelo, mae_kw, rmse_kw, puntos: [{ts, p_kw}]}` |
| `ems/edificio1/sim/control` | → sim | `{accion: pausa\|reanuda, velocidad?}`, evento simulado `{accion: "evento", operacion: iniciar\|detener, id, evento, zona?, unidad?, duracion_min, intensidad?}` (`ems/eventos.py`), ocupación `{accion: "ocupacion", …}` o controladores `{accion: "unidad", unidad, …}` / `{accion: "sensor", zona, …}` (mismos campos que el endpoint, §2.1; `ems/controladores.py`) |
| `ems/edificio1/sim/controladores` | sim → (retenido, cada paso y al aplicar un ajuste) | `{ts, unidades: [{unidad, tipo, zonas, capacidad_kw, p_kw, q_frio_kw, carga_pct, cop, modo, encendido, capacidad_pct, setpoint_c, cop_factor, forzado, restante_min, usuario, falla, sin_energia}], sensores: [{zona, temp_c, temp_real_c, hr_pct, hr_real_pct, ocupado, ocupado_real, forzado: {temp_offset_c?, temp_c?, hr_pct?, presencia?, congelado?}, restante_min, usuario}]}`. `modo`: `auto`\|`frio`\|`ventilacion`\|`apagado`; `cop` = frío / potencia del compresor del paso (`null` con el compresor parado); `restante_min: null` = sin vencimiento; `falla` = evento `falla_vrf` activo; `sensores` lista sólo los forzados |
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
| `evento` | ver «Eventos simulados» (§4) | `ems/<edif>/sim/control` |
| `ocupacion` | ver «Cantidad de personas» (§4) | `ems/<edif>/sim/control` |
| `unidad` | `unidad` (id de `sistemas_vrf`), `encendido?` (bool), `modo?` (`auto`\|`frio`\|`ventilacion`), `capacidad_pct?` (0–100), `setpoint_c?` (18–30), `cop_factor?` (0.5–1.2), `duracion_min?` (>0–10080; **omitida = hasta liberar**), `confirmar?`, `usuario?` — o `{unidad: id\|"*", liberar: true}` | `ems/<edif>/sim/control` (`accion: "unidad"`) |
| `sensor` | `zona`, `temp_offset_c?` (−10…10) **o** `temp_c?` (5–50), `hr_pct?` (0–100), `presencia?` (bool), `congelado?` (true), `duracion_min?` (omitida = hasta liberar), `confirmar?`, `usuario?` — o `{zona: Z\|"*", liberar: true}` | `ems/<edif>/sim/control` (`accion: "sensor"`) |

Respuesta `{ok, mensaje, …}` con 200, 400 si el comando no es válido (zona crítica en `override`, sin cambios,
fuera de rango, unidad/zona inválida) o **409** `{ok: false, requiere_confirmar: true}` si un ajuste de
`unidad`/`sensor` afecta a una zona crítica y falta `confirmar: true`.

### 2.1 Controladores: unidades VRF/PTAC y datos de sensores (`ems/controladores.py`)

Escenarios de simulación sobre el gemelo. Cada ajuste **reemplaza** al anterior de la misma unidad o zona (lo
no indicado vuelve a automático); con `duracion_min` vence solo, sin ella dura hasta `liberar`.

**Unidad** (controlador local, prioridad sobre el EMS):

| Campo | Efecto en el gemelo |
|---|---|
| `encendido: false` | compresor y terminales apagados (sin ventilador) en todas las zonas de la unidad |
| `modo: "frio"` | termostato local con el setpoint de la zona (o el de la unidad): ignora `hvac_enable=false` y el deslastre (`hvac_mod`) del EMS |
| `modo: "ventilacion"` | sólo ventiladores con aire exterior de diseño, sin compresor |
| `capacidad_pct` | tope de la capacidad total de la unidad; si sus zonas piden más se reduce la modulación de todas en la misma proporción |
| `setpoint_c` | setpoint del controlador local para sus zonas (reemplaza al del EMS y al fijo de las críticas) |
| `cop_factor` | multiplica el COP: el mismo frío con más (o menos) potencia eléctrica |

La **falla** de la unidad no es un ajuste: es el evento `falla_vrf` (§4), que el estado informa como `falla`.

**Sensor de zona**: cambia sólo lo que leen el termostato local y el EMS (Python y Node-RED, que reciben el valor
por la telemetría); la física sigue con el estado real. `temp_offset_c` suma un desfase; `temp_c` fija la
lectura con el ruido normal del sensor (σ 0.08 °C, para no parecer congelado); `hr_pct` fija la HR; `presencia`
fuerza el detector (decide setpoint, luces, enchufes y ventilador DCV); `congelado` deja todas las lecturas en
el último valor (prioridad sobre los demás campos) y el supervisor lo detecta en 6 lecturas (≈ 30 min) como
`SENSOR_CONGELADO` → modo seguro. La HR es **informativa**: el VRF no controla la humedad (como en el modelo E+,
la HR interior con ocupación ronda el 90–100 %), así que ninguna regla del EMS la usa.

**Zona crítica (Z06, cuarto de servidores, y su unidad VRF-SRV)**: se permite simular cualquier ajuste —es
justamente el escenario que interesa probar— pero exige `confirmar: true` (409 sin él, en Node-RED y en el
gemelo) y al aplicarse el gemelo emite la alarma `AJUSTE_CRITICO` (warn). `liberar` no necesita confirmación.
El panel pide confirmación en línea antes de enviar.

Códigos de alarma: `TEMP_ALTA`, `TEMP_BAJA`, `PICO_DEMANDA`, `DR_ACTIVO`, `SENSOR_CONGELADO`, `SENSOR_FUERA_RANGO`, `HVAC_ON_SIN_OCUPACION`, `SERVIDOR_TEMP`, `COMANDO_PERDIDO`, `AJUSTE_CRITICO`.

## 3. Esquema InfluxDB (bucket `ems`)

Timestamp = tiempo simulado. Precisión: segundos. En modo `externo` el simulador también guarda en `ems` y `alarma` lo que Node-RED publica en `ems/<edif>/ems/estado` y `ems/<edif>/alarma` (con el tiempo simulado del paso en curso).

| Measurement | Tags | Fields |
|---|---|---|
| `zona` | `edificio`, `zona`, `nombre`, `tipo`, `critica` (`si`/`no`), `escenario` | `temp_c`, `setpoint_c`, `ocupantes`, `ocupado` (0/1), `lux`, `luces_nivel`, `equipos_nivel`, `hvac_on` (0/1), `hvac_enable` (0/1), `p_luces_kw`, `p_equipos_kw`, `p_hvac_kw`, `p_total_kw`; lectura frente a real: `temp_c` / `temp_real_c`, `hr_pct` / `hr_real_pct`, `ocupado` / `ocupado_real`, `sensor_forzado` (0/1); mientras el sensor está forzado: `sensor_temp_offset_c`, `sensor_temp_fijo_c`, `sensor_hr_fijo_pct`, `sensor_presencia` (0/1), `sensor_congelado` (0/1), `sensor_restante_min` (−1 = sin vencimiento) |
| `unidad` | `edificio`, `unidad`, `tipo` (`vrf`/`ptac`), `escenario` | `p_kw`, `q_frio_kw`, `carga_pct`, `cop` (sólo con compresor en marcha), `modo` (string), `encendido`, `capacidad_pct`, `setpoint_c` (sólo si está fijado), `cop_factor`, `forzado`, `restante_min` (−1 = sin vencimiento; sólo si `forzado`), `falla`, `sin_energia` (booleanos 0/1) |
| `medidor` | `edificio`, `escenario` | todos los campos numéricos de `medidor/general`. Pico de arranque de los compresores: `p_arranque_kw` (potencia extra durante unos segundos), `p_pico_kw` (potencia instantánea máxima del paso), `n_arranques_equipos` e `i_pico_a`. Las tres líneas del sistema trifásico: `i_l1_a`, `i_l2_a`, `i_l3_a` (A), `v_l1_v`, `v_l2_v`, `v_l3_v` (fase–neutro, V), `p_l1_kw`, `p_l2_kw`, `p_l3_kw` y `desbalance_pct` (máx. desviación de corriente / media). Planta de respaldo: `modo_energia_cod` (1 red, 2 planta, 3 UPS, 0 sin energía; en MQTT `modo_energia` = `red`/`generador`/`ups`/`sin_energia`), `p_gen_kw`, `gen_carga_pct`, `gen_combustible_l`, `gen_combustible_pct`, `gen_consumo_l_h`, `gen_autonomia_h`, `e_gen_kwh`, `p_fv_recortada_kw`; durante un corte `ups_kw` y `ups_min` |
| `auditoria` | `edificio`, `tipo`, `resultado` (`aceptada`/`rechazada`) | `usuario`, `objetivo`, `codigo`, `ip`, `detalle`: cada orden recibida por `POST /ems/control` |
| `ems` | `edificio`, `escenario`, `modo` | `dr_activo` (0/1), `limite_kw`, `n_alarmas`, `latencia_ms`; actividad de las reglas (dashboard «Reglas del EMS»): `r_precool`, `r_fuera_horario` (0/1), `r_ocupadas`, `r_vacancia`, `r_setback`, `r_apagadas`, `r_proteccion_alta`, `r_proteccion_baja`, `r_luz_natural`, `r_standby`, `r_rampa_setpoint`, `r_arranque_espera`, `r_arranques`, `r_rotacion_compresores`, `r_dr_etapa`, `r_modo_seguro`, `r_manual` (zonas) |
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

// Estado de las unidades VRF/PTAC (consulta E del panel 3D)
from(bucket: "ems") |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "unidad" and r.escenario == "live") |> last()
  |> pivot(rowKey: ["_time", "unidad"], columnKey: ["_field"], valueColumn: "_value") |> group()

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
o `{tipo: "evento", accion: "detener", id | "*"}`. Tipos: `incendio`, `corte_energia` (la planta de respaldo toma el tablero
de emergencia; ver `docs/PLANTA_RESPALDO.md`), `falla_generador` (la planta no está disponible: en un corte sólo
queda el UPS de los servidores), `falla_vrf` (unidad: cualquier id de `sistemas_vrf`, incluidos los PTAC), `falla_terminal`, `puerta_abierta` (%), `sensor`,
`ola_calor` (°C), `sobreocupacion` (% sobre el aforo), `pico_carga` (kW). Alarmas nuevas: `INCENDIO`,
`CORTE_ENERGIA`, `EN_PLANTA`, `FALLA_GENERADOR`, `EN_UPS`, `UPS_AGOTADO`, `FALLA_VRF`, `FALLA_TERMINAL`, `PUERTA_ABIERTA`, `OLA_CALOR`,
`SOBREOCUPACION`, `CARGA_EXTRA`, `AJUSTE_CRITICO`. Rango de `limite_kw` en `parametros`: 42–561 kW.
