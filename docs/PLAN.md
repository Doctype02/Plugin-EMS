# Plan de trabajo — Proyecto 2: EMS para Edificio Inteligente

UTP · Producción de la Energía Eléctrica (0877) · II Semestre 2026 · entrega tentativa: **1 dic 2026**

## 1. Arquitectura

```
          ┌───────────────────────────── CÓDIGO (agente de código) ─────────────────────────────┐
          │                                                                                      │
 clima ──►│  Simulador del edificio (10 zonas)      Control EMS (Python, modo offline)            │
 (EPW o   │  · backend RC (por defecto)             · línea base (sin EMS)                        │
 sintét.) │  · backend EnergyPlus (pyenergyplus)    · reglas: histéresis + ocupación + luz natural│
          │  sensores ▸ actuadores ▸ cargas         · respuesta a la demanda (peak shaving)       │
          │           │        ▲                    · MPC simplificado                            │
          │           │        │                    Pronóstico día siguiente (regresión, SARIMA)  │
          │           ▼        │                    KPIs, ROI, sensibilidad, pruebas anómalas     │
          │   puente MQTT  ◄───┘                                                                  │
          └──────┬──────────────▲───────────────────────────────┬──────────────────────────────────┘
                 │ telemetría   │ comandos                      │ escritura directa
                 ▼              │                               ▼
 ┌──────────── INFRAESTRUCTURA (agente de infraestructura) ────────────────────────────────────┐
 │   Mosquitto :1883  ◄──►  Node-RED :1880 (carga nodered/flows.json del repo = reglas EMS)    │
 │                                  InfluxDB 2.x :8086 (org utp, bucket ems)  ──►  Grafana :3000│
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Dos modos de operación:

| Modo | Quién decide | Para qué |
|---|---|---|
| `offline` | Python (`ems escenarios`) | Resultados reproducibles para el informe: línea base vs EMS, KPIs, CSV y gráficas |
| `live` | Node-RED (reglas) o Python (`--control interno`) | Demo en vivo: el simulador publica por MQTT, Node-RED manda comandos, Grafana muestra todo |

## 2. División del trabajo

### Agente de código (este repo: `ems/`, `nodered/`, `tests/`, `Dockerfile`)

| Etapa | Trabajo | Resultado |
|---|---|---|
| 2 | Modelo de 10 zonas (RC térmico + cargas) y puente Python–EnergyPlus | Lectura de temperaturas |
| 3 | Actuadores: luces, equipos, ocupación, HVAC (setpoint/enable) | Control por zona |
| 4 | Reglas en Python **y** `nodered/flows.json` con la misma lógica | EMS automático |
| — | Auditoría base y clasificación crítica / no crítica | Línea base |
| — | Pronóstico día siguiente (regresión + SARIMA) con MAE / RMSE / MAPE | Pronóstico validado |
| 6 | Escenarios, perfiles anómalos, KPIs, ROI, sensibilidad, escalamiento Panamá | Evaluación energía y confort |
| — | Escritor a InfluxDB según el contrato; `Dockerfile` del simulador | Datos en la BD |
| 5 | Panel de Grafana propio `grafana-ems-panel/`: edificio inteligente en 3D (10 zonas, 6 vistas, alarmas, medidor) | Dashboard 3D |

### Agente de infraestructura (carpeta `infra/`)

| Etapa | Trabajo | Resultado |
|---|---|---|
| 1 | `docker-compose` con Mosquitto, Node-RED, InfluxDB 2, Grafana y el servicio `simulador` (build del `Dockerfile` raíz) | Comunicación MQTT |
| 1 | Node-RED montando `nodered/flows.json`, variables `MQTT_HOST`, `MQTT_PORT` | Reglas cargadas |
| 5 | InfluxDB inicializado (org `utp`, bucket `ems`, token por `.env`) | BD corriendo |
| 5 | Grafana: datasource Flux aprovisionado + dashboards (guiarse del BMS existente) | Monitoreo de las 10 zonas |
| 5 | Panel de alarmas, estado de cargas, variables eléctricas, KPIs y pronóstico | Dashboard funcional |
| — | Script `infra/up.sh` / instrucciones, healthchecks, persistencia de volúmenes | Despliegue reproducible |

**Frontera:** el contrato está en [`CONTRATO.md`](CONTRATO.md). Si alguno necesita cambiar un tópico, medida o campo, se cambia primero ahí.

## 3. Orden de ejecución

1. ✅ Plan + contrato (este documento).
2. En paralelo: código (simulador, control, pronóstico, KPIs) ‖ infraestructura (compose, Influx, Grafana).
3. Integración: `docker compose up` → simulador en modo `live` → Node-RED controla → Grafana muestra.
4. Corrida de escenarios offline → tablas/gráficas para el informe y el artículo JIC.
5. Video demo 3–5 min y defensa.

## 4. Mapeo requerimiento → entregable

| Requerimiento del enunciado | Dónde queda |
|---|---|
| Auditoría base y clasificación de cargas | `ems auditoria` → `resultados/auditoria_*.csv` |
| Pronóstico día siguiente + MAE/RMSE | `ems pronostico` → `resultados/pronostico_*.csv` |
| Control on/off con histéresis, ocupación, MPC simplificado | `ems/control.py`, `nodered/flows.json` |
| Modelo digital de sensores, ocupación, actuadores y cargas | `ems/edificio.py`, `ems/ocupacion.py`, `ems/energyplus_bridge.py` |
| Dashboard con variables eléctricas, estado de cargas, alarmas, resultados | Panel 3D `grafana-ems-panel/` (código) + dashboards de Grafana (infra) sobre el esquema del contrato |
| Ahorro %, reducción de demanda máxima, ROI, sensibilidad | `ems escenarios`, `ems sensibilidad` |
| Pruebas con perfiles normales y anómalos | `ems pruebas` (ola de calor, ocupación fuera de horario, sensor congelado/ruidoso, pérdida de comandos, pico de carga) |
| Reducción %, kW pico evitado, kWh ahorrados | `resultados/kpi_escenarios.csv` |
| Disponibilidad, tiempo de respuesta, confiabilidad de la lógica | `resultados/pruebas.csv` (+ latencia medida en vivo vía `ack`) |
| Costo del kWh evitado, escalabilidad Panamá | `resultados/economia.csv`, `resultados/escalamiento_panama.csv` |
