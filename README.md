# EMS digital para edificio inteligente — Proyecto 2

UTP · Facultad de Ingeniería Eléctrica · Producción de la Energía Eléctrica (0877) · II Semestre 2026

Sistema de Gestión de Energía (EMS) para un edificio de oficinas de **10 zonas en Ciudad de Panamá**:
gemelo digital (sensores, ocupación, actuadores, cargas y medidor), control por reglas con histéresis,
respuesta a la demanda, MPC simplificado, pronóstico del día siguiente, alarmas, KPIs técnico-económicos
y plataforma IoT (MQTT + Node-RED + InfluxDB + Grafana).

- Plan y división del trabajo: [`docs/PLAN.md`](docs/PLAN.md)
- Contrato de interfaces (MQTT / InfluxDB / variables): [`docs/CONTRATO.md`](docs/CONTRATO.md)
- Brief del agente de infraestructura: [`docs/AGENTE_INFRA.md`](docs/AGENTE_INFRA.md)
- Resultados generados: [`resultados/RESUMEN.md`](resultados/RESUMEN.md)

## Arquitectura

```
clima ─┐                       ┌──────── Node-RED (reglas EMS, nodered/flows.json)
ocupac.├─► gemelo digital ──MQTT┤
       │   (ems/edificio.py)   └──────── comandos ─► actuadores (setpoint, HVAC, luces, enchufes)
       │          │
       │          └── InfluxDB ──► Grafana (tiempo real, zonas, alarmas, resultados)
       └─► escenarios offline (Python) ─► resultados/*.csv, *.png, RESUMEN.md
```

| Módulo | Qué hace |
|---|---|
| `ems/edificio.py` | Modelo térmico RC por zona, termostato on/off con histéresis, DCV, cargas, sensores con fallas, medidor (P, Q, S, FP, V, I, demanda 15 min) |
| `ems/control.py` | Línea base, Reglas (ocupación + vacancia + pre-enfriamiento + luz natural + standby), Reglas+DR (rotación de compresores + deslastre escalonado), MPC simplificado; supervisor de alarmas y modo seguro |
| `ems/pronostico.py` | Pronóstico día siguiente: regresión, persistencia, SARIMAX; MAE / RMSE / MAPE |
| `ems/kpi.py` | Energía, pico, confort, CO₂, VPN, TIR, payback, ROI, costo del kWh evitado, escalamiento Panamá |
| `ems/escenarios.py` | Comparación de escenarios, 10 pruebas normales/anómalas con criterios, sensibilidad |
| `ems/live.py` | Modo en vivo por MQTT (+ InfluxDB) |
| `ems/energyplus_bridge.py` | Puente Python–EnergyPlus (pyenergyplus) con el mismo controlador |
| `nodered/src/*.js` → `flows.json` | Las mismas reglas en Node-RED; `ems/nodered.py` verifica paridad exacta con Python |
| `grafana-ems-panel/` | Panel de Grafana propio: edificio inteligente en 3D isométrico (3 niveles, 10 zonas, azotea), 6 vistas, alarmas, medidor y detalle por zona; modo demostración o datos de InfluxDB |

## Panel 3D de Grafana

![Panel EMS 3D](grafana-ems-panel/docs/vista_estado_oscuro.png)

Ver [`grafana-ems-panel/README.md`](grafana-ems-panel/README.md) (compilar con `npm ci && npm run build`).

## Uso rápido

```bash
pip install -r requirements.txt
```

```bash
python -m ems todo          # todo el análisis → resultados/ (≈1 min)
```

```bash
pytest -q                   # 15 pruebas
```

Comandos individuales: `auditoria`, `pronostico`, `escenarios`, `pruebas`, `sensibilidad`, `paridad`,
`live`, `exportar`, `energyplus`. Cualquier parámetro de `config/edificio.yaml` se puede variar sin editar el archivo:

```bash
python -m ems --set ems.limite_demanda_kw=135 --set tarifa.precio_punta_usd_kwh=0.28 escenarios
```

### Modo en vivo (demo)

Con la plataforma de `infra/` levantada (ver `docs/AGENTE_INFRA.md`) el servicio `simulador` arranca solo.
Sin Docker, con un Mosquitto local:

```bash
python tools/nodered_stub.py --port 1883 &          # sustituto de Node-RED (mismo JS)
```

```bash
python -m ems live --control externo --velocidad 300
```

`--control interno` usa las reglas Python sin Node-RED; `--control baseline` simula el edificio sin EMS.

### EnergyPlus

```bash
export ENERGYPLUS_DIR=/ruta/EnergyPlus-24-2-0
```

```bash
python -m ems energyplus --idf modelo_10zonas.idf --epw PAN_Tocumen.epw --mapa config/energyplus_mapa.yaml
```

`config/energyplus_mapa_5zone.yaml` permite probar el puente con el ejemplo `5ZoneAirCooled.idf` de EnergyPlus.

## Resultados principales (semana tipo, `python -m ems todo`)

| Escenario | Energía (kWh/sem) | Demanda máx. 15 min (kW) | Confort (%) | Ahorro (%) | Pico evitado (kW) | Payback (años) |
|---|---|---|---|---|---|---|
| Línea base | 16 874 | 178.1 | 96.9 | — | — | — |
| Reglas | 13 127 | 159.7 | 98.7 | 22.2 | 18.5 | 1.8 |
| Reglas + DR | 13 111 | 145.4 | 98.8 | 22.3 | 32.7 | 1.7 |
| MPC | 12 923 | 146.1 | 98.4 | 23.4 | 32.0 | 1.6 |

Pronóstico día siguiente (regresión): MAE ≈ 2.5 kW, RMSE ≈ 3.7 kW, MAPE ≈ 3.2 %. Pruebas: 10/10 superadas,
disponibilidad de la lógica 100 %, latencia de decisión < 1.2 ms (p99); lazo MQTT medido comando→actuador
≈ 12 ms de media. Detalle en `resultados/RESUMEN.md`.

## Supuestos y limitaciones

- Datos de sensores **simulados** (clima sintético tropical o EPW, ocupación estocástica por tipo de zona).
  La regularidad del perfil sintético favorece al pronóstico; con datos reales se esperan errores mayores.
- Tarifas, CAPEX, factor de emisión y área de oficinas de Panamá son **supuestos documentados** en
  `config/edificio.yaml` y `ems/kpi.py`; deben contrastarse con el pliego tarifario ASEP vigente, cotizaciones
  locales y datos de SNE/INEC antes del informe final.
- El modelo RC 1R1C por zona no representa humedad explícitamente (se usa SHR del equipo DX).
- El puente EnergyPlus está implementado pero **no se ha ejecutado** en este entorno (ver `docs/PLAN.md`).
