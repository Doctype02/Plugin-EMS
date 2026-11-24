# EMS digital para edificio inteligente — Proyecto 2

UTP · Facultad de Ingeniería Eléctrica · Producción de la Energía Eléctrica (0877) · II Semestre 2026

Sistema de Gestión de Energía (EMS) para el edificio de oficinas del proyecto en **Ciudad de Panamá**
(5 plantas, 2000 m², 26 zonas acondicionadas, 6 sistemas VRF y 5 PTAC; variante con 55 kWp fotovoltaicos),
con los parámetros del modelo **OpenStudio/EnergyPlus** del equipo (`Edificio_Sin_EMS` y `Edificio_Sin_EMS_ConPV`,
importados en `data/energyplus/`, clima EPW Panamá-Albrook TMYx 2011–2025): gemelo digital calibrado y
validado contra EnergyPlus (ASHRAE Guideline 14), sensores, ocupación, actuadores, cargas y medidor, control por reglas con histéresis,
respuesta a la demanda, MPC simplificado, pronóstico del día siguiente, alarmas, KPIs técnico-económicos
y plataforma IoT (MQTT + Node-RED + InfluxDB + Grafana).

- Plan y división del trabajo: [`docs/PLAN.md`](docs/PLAN.md)
- Contrato de interfaces (MQTT / InfluxDB / variables): [`docs/CONTRATO.md`](docs/CONTRATO.md)
- Encargo del agente de infraestructura: [`docs/AGENTE_INFRA.md`](docs/AGENTE_INFRA.md)
- Despliegue en Arch Linux (systemd): [`docs/DESPLIEGUE_ARCH.md`](docs/DESPLIEGUE_ARCH.md) · plantillas en `deploy/arch/`
- Resultados generados: [`resultados/RESUMEN.md`](resultados/RESUMEN.md)
- Planta de respaldo (generador, UPS y paneles en un corte): [`docs/PLANTA_RESPALDO.md`](docs/PLANTA_RESPALDO.md)
- Seguridad y operación (HTTPS, auditoría, copias, alertas): [`deploy/seguridad/README.md`](deploy/seguridad/README.md)

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
| `ems/edificio.py` | Modelo térmico 2R2C por zona (aire + masa), compresores inverter con rampa, termostato con histéresis, DCV, cargas, sensores con fallas, medidor (P, Q, S, FP, V, I, demanda 15 min) y planta de respaldo (generador, UPS, paneles en paralelo) |
| `ems/control.py` | Línea base, Reglas (19 reglas: horario, ocupación, aire apagado fuera de horario, pre-enfriamiento escalonado, rampa de consigna, luz natural, standby, protecciones y modo emergencia), Reglas+DR (rotación de compresores + deslastre), MPC simplificado; supervisor de alarmas y modo seguro |
| `ems/pronostico.py` | Pronóstico día siguiente: regresión, persistencia, SARIMAX; MAE / RMSE / MAPE |
| `ems/kpi.py` | Energía, pico, confort, CO₂, VPN, TIR, payback, ROI, costo del kWh evitado, escalamiento Panamá |
| `ems/escenarios.py` | Comparación de escenarios, 10 pruebas normales/anómalas con criterios, sensibilidad |
| `ems/live.py` | Modo en vivo por MQTT (+ InfluxDB) |
| `ems/energyplus_bridge.py` | Puente Python–EnergyPlus (pyenergyplus) con el mismo controlador |
| `nodered/src/*.js` → `flows.json` | Las mismas reglas en Node-RED; `ems/nodered.py` verifica paridad exacta con Python |
| `ems/validacion.py` | Validación y calibración contra EnergyPlus: usos finales, pico, NMBE y CV(RMSE) horarios (ASHRAE G14) |
| `tools/importar_energyplus.py` | Importa el modelo E+ (in.idf, eplusout.sql, floorplan.json, EPW; con y sin FV) a `data/`: series de validación y parámetros de zonas, envolvente, VRF/PTAC y FV (`modelo_parametros.json`) |
| `grafana-ems-panel/` | Panel de Grafana propio: edificio inteligente en 3D (5 plantas, 26 zonas, azotea con 6 unidades VRF y paneles FV) con interiores animados, 6 vistas, barra de tiempo (hora, día, velocidad), alarmas, medidor, **control del edificio**, **simulación de alarmas y accidentes** y **«¿qué pasaría si…?»** (confort ISO 7730, rendimiento, riesgo de servidores); modo demostración o datos de InfluxDB |
| `nodered/src/override.js`, `http_control.js` | Control manual: overrides con prioridad sobre las reglas y endpoint `POST /ems/control` con CORS |
| `ems/eventos.py` | Eventos simulados en el gemelo (incendio, corte de energía con planta de respaldo, falla de la planta, falla VRF/terminal, puerta abierta, sensor, ola de calor, sobreocupación, pico de carga) |
| `tools/generar_dashboard_reglas.py`, `tools/dashboards_pestanas.py` | Generan los dashboards de Grafana con pestañas (esquema v2) desde `config/edificio.yaml` y `deploy/arch/grafana/dashboards-src/` |
| `deploy/seguridad/`, `deploy/arch/ems-backup.*`, `deploy/arch/grafana/alertas-ems.yaml` | HTTPS con proxy (las órdenes sólo pasan con sesión de Grafana), copia de seguridad diaria y reglas de alerta |

## Dashboards de Grafana

Seis dashboards con la misma barra de enlaces y pestañas: **Edificio 3D** (gemelo en vivo a pantalla completa),
**Tiempo real** (Resumen · Energía y EMS · Climatización · Respaldo), **Zonas**, **Alarmas** (con la auditoría de
órdenes), **Reglas** (las 19 reglas del EMS, sus parámetros y cuándo actúa cada una) y **Resultados** (con la
pestaña «Negocio»: ahorro anual, inversión, recuperación, VPN, TIR y flujo de caja a 10 años).

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
pytest -q                   # 38 pruebas
```

Comandos individuales: `auditoria`, `pronostico`, `escenarios`, `pruebas`, `sensibilidad`, `paridad`,
`live`, `exportar`, `energyplus`. Cualquier parámetro de `config/edificio.yaml` se puede variar sin editar el archivo:

```bash
python -m ems --set ems.limite_demanda_kw=150 --set tarifa.precio_punta_usd_kwh=0.28 escenarios
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
python -m ems energyplus --idf data/energyplus/modelo/in.idf --epw data/clima/PAN_PO_Panama-Albrook.Gelabert.Intl.AP.783842_TMYx.2011-2025.epw
```

`config/energyplus_mapa_5zone.yaml` permite probar el puente con el ejemplo `5ZoneAirCooled.idf` de EnergyPlus.

## Modelo del edificio y validación contra EnergyPlus

Parámetros tomados de los modelos del equipo (`Edificio_Sin_EMS` y `Edificio_Sin_EMS_ConPV`) con
`tools/importar_energyplus.py`: geometría (floorplan.json: PB y P1–P4 de 20 × 20 m), cargas internas por zona,
horarios `BASE_*`/`TEMP_*` (el modelo sin EMS enfría a 22 °C las 24 h; baños a 24 °C), envolvente (muro U 2.48,
techo U 0.61, losa U 4.02, vidrio tintado U 5.71 / SHGC 0.50), 21 terminales VRF en 6 sistemas y 5 PTAC
autodimensionados, ascensor, FV y clima EPW de Panamá. El COP estacional y los parámetros efectivos del modelo
RC se calibran contra la serie horaria de E+ (`python -m ems calibrar`).

| Uso final anual | EnergyPlus | Gemelo digital | Diferencia |
|---|---|---|---|
| Enfriamiento | 318.9 MWh | 275.1 MWh | −13.7 % |
| Ventiladores | 74.9 MWh | 76.0 MWh | +1.6 % |
| Iluminación | 60.6 MWh | 60.9 MWh | +0.5 % |
| Equipos (incl. ascensor) | 98.1 MWh | 87.7 MWh | −10.6 % |
| **Total** | **552.5 MWh** | **510.8 MWh** | **−7.5 %** |

Serie horaria anual: NMBE 7.5 %, CV(RMSE) 21.2 % → **cumple ASHRAE Guideline 14** (±10 %, ≤ 30 %).
Pico anual: 132.7 kW (E+) frente a 119.2 kW. FV (variante ConPV): NMBE < 1 % frente a la generación de E+
(101 MWh/año). El modelo de un nodo por zona subestima la carga nocturna de E+ (inercia de los muros), así que
la línea base queda algo baja y los ahorros del EMS son conservadores. `python -m ems validar` regenera la
tabla y la figura.

## Resultados principales (4 semanas tipo con el EPW, `python -m ems todo`)

Sin paneles (energía y demanda = consumo del edificio):

| Escenario | Energía 4 sem. (kWh) | Demanda máx. 15 min (kW) | Confort (%) | Ahorro (%) | Pico evitado (kW) | Payback (años) |
|---|---|---|---|---|---|---|
| Línea base (operación del modelo E+) | 39 448 | 138.0 | 98.8 | — | — | — |
| Reglas | 19 359 | 109.7 | 98.9 | 50.9 | 28.3 | 1.2 |
| Reglas + DR (límite 170 kW) | 19 359 | 109.7 | 98.9 | 50.9 | 28.3 | 1.2 |
| MPC | 19 524 | 113.5 | 99.1 | 50.5 | 24.6 | 1.2 |

Con paneles (energía y demanda de la acometida, netas de 7.3 MWh FV en las 4 semanas; ahorro frente a la
línea base con FV):

| Escenario | Energía de red (kWh) | Demanda máx. 15 min (kW) | Ahorro (%) | Pico evitado (kW) | Payback (años) |
|---|---|---|---|---|---|
| Línea base + FV | 32 139 | 110.3 | — | — | — |
| Reglas + FV | 13 374 | 82.5 | 58.4 | 27.9 | 1.2 |
| Reglas + DR + FV | 13 374 | 82.5 | 58.4 | 27.9 | 1.2 |
| MPC + FV | 13 507 | 81.8 | 58.0 | 28.5 | 1.2 |

Los ahorros vienen sobre todo de eliminar el enfriamiento nocturno y de fin de semana (el modelo mantiene 22 °C
las 24 h con los ventiladores encendidos), del setpoint 24 °C con ocupación, del apagado de luces y del corte de
standby sin ocupación. Con el límite de demanda de 170 kW (potencia máxima del edificio) la respuesta a la demanda no llega a
actuar: el pico del edificio es 138 kW sin EMS y 110 kW con reglas, así que «Reglas + DR» coincide con «Reglas».
(Con el límite anterior de 90 kW el DR recortaba 45 kW del pico.)

Pronóstico día siguiente (regresión ridge): sobre el año de EnergyPlus MAE 2.3 kW, RMSE 3.0 kW; sobre el gemelo
con ocupación estocástica MAE 3.2 kW, RMSE 5.3 kW (persistencia semanal 3.7 / 6.5 kW). Pruebas: 10/10
superadas, confiabilidad de la lógica 100 %, latencia de decisión ≈ 3 ms (p99); paridad exacta Python ⇄
Node-RED en 2016 pasos. Detalle en `resultados/RESUMEN.md`.

## Supuestos y limitaciones

- Datos de sensores **simulados** con el EPW de Panamá y los horarios del modelo E+ (más variación aleatoria de
  ocupación). La serie de EnergyPlus es determinista y favorece al pronóstico; con datos reales de medidor se
  esperan errores mayores.
- El modelo E+ usa la temperatura de terreno por defecto de EnergyPlus (**18 °C**); en Panamá el terreno está a
  26–28 °C. El gemelo opera con **27 °C** (`edificio.t_suelo_c`) y sólo usa 18 °C para compararse con E+
  (`edificio.t_suelo_energyplus_c`); conviene corregirlo también en OpenStudio.
- Tarifa única de **0,15672 USD/kWh** a todas las horas (`tarifa`), más el cargo por demanda.
- La planta de respaldo (110 kW, tanque de 600 L, UPS de 3 kVA) está dimensionada con la simulación del día de
  diseño; ver `docs/PLANTA_RESPALDO.md` para sus limitaciones (baja carga de noche y en fin de semana).
- Tarifas, CAPEX, factor de emisión y área de oficinas de Panamá son **supuestos documentados** en
  `config/edificio.yaml` y `ems/kpi.py`; deben contrastarse con el pliego tarifario ASEP vigente, cotizaciones
  locales y datos de SNE/INEC antes del informe final.
- El modelo 2R2C por zona integra la humedad sólo para informar la HR (el VRF no la controla).
- El puente EnergyPlus está implementado pero **no se ha ejecutado** en este entorno (ver `docs/PLAN.md`).
