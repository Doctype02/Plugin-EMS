# Hoja de ruta: del gemelo digital a un edificio real

Qué falta para instalar este EMS en un edificio de oficinas real, cuánto cuesta y cómo se comprueba que ahorra
lo que promete. El punto de partida es favorable: **el EMS no sabe que habla con un simulador**. Las reglas
(Node-RED), la base de datos (InfluxDB) y los tableros (Grafana) sólo ven mensajes MQTT con el formato de
[`CONTRATO.md`](CONTRATO.md). En un edificio real, el simulador (`ems/live.py`) se sustituye por pasarelas que
publican esos mismos mensajes desde los equipos.

## 1. Qué cambia y qué se queda igual

| Pieza | En el gemelo | En el edificio real |
|---|---|---|
| Reglas del EMS (Node-RED) | `nodered/flows.json` | **igual** |
| Históricos y tableros | InfluxDB + Grafana | **igual** |
| Panel 3D | modelo de 5 plantas | se regenera con la geometría del edificio (`tools/generar_modelo_panel.py`) |
| Telemetría de zonas | simulador → `zona/<id>/telemetria` | sensores de temperatura, humedad, presencia y luz → pasarela → mismo tópico |
| Órdenes a las zonas | `zona/<id>/cmd` → simulador | pasarela → VRF (consigna, marcha), iluminación (nivel), enchufes (corte) |
| Medidor | simulador → `medidor/general` | medidor de red trifásico (Modbus) → mismo tópico, con las tres líneas |
| Planta de respaldo y UPS | modelo | estado del tablero de transferencia, del grupo y del UPS (Modbus/SNMP) |
| Gemelo digital | es «el edificio» | pasa a ser el **modelo de referencia**: predice lo que debería consumir y permite probar reglas sin riesgo |

## 2. Integración con los equipos

| Sistema | Protocolo habitual | Qué lee el EMS | Qué ordena |
|---|---|---|---|
| VRF (unidades exteriores e interiores) | BACnet/IP o Modbus a través de la pasarela del fabricante | temperatura de retorno, estado, alarmas, consumo | consigna, marcha/paro, modo, límite de capacidad |
| Iluminación | DALI-2 o 0–10 V con controlador por zona | nivel, presencia, luz natural | nivel de atenuación |
| Tomacorrientes | regletas o contactores inteligentes (Modbus/MQTT) | consumo | corte de standby |
| Medición eléctrica | medidor trifásico clase 0,5S (Modbus TCP) | P, Q, S, FP, V e I por línea, demanda de 15 min | — |
| Fotovoltaica | inversor (SunSpec/Modbus) | potencia, energía, estado | límite de potencia (operación con la planta) |
| Planta y transferencia | controlador del grupo y del ATS (Modbus) | red presente, planta en marcha, carga, combustible | — (la transferencia es autónoma) |
| UPS | SNMP o Modbus | en línea / en batería, autonomía | — |

El trabajo de software es escribir una pasarela por protocolo (un flujo de Node-RED o un servicio pequeño) que
traduzca los puntos del equipo a los campos del contrato. Las reglas no se tocan.

## 3. Fases

| Fase | Duración | Qué se hace | Criterio para seguir |
|---|---|---|---|
| 0. Auditoría | 2–3 semanas | levantamiento de equipos y protocolos, 2 semanas de medición con el medidor de red, línea base de consumo | hay acceso de control a los VRF y datos de medidor |
| 1. Sólo lectura | 4 semanas | sensores, medidor y pasarelas; el EMS observa y recomienda, no ordena. Se calibra el gemelo con los datos reales | el gemelo reproduce el consumo real dentro de ASHRAE G14 (NMBE ±10 %, CV(RMSE) ≤ 30 %) |
| 2. Una planta | 6 semanas | el EMS controla una planta; el resto sigue como estaba y sirve de comparación | ahorro medido ≥ 25 % en esa planta sin quejas de confort |
| 3. Edificio completo | 8 semanas | todas las plantas, respuesta a la demanda y modo emergencia con una prueba de corte programada | pico y confort dentro de lo previsto |
| 4. Operación | continuo | medición y verificación mensual, ajuste de parámetros, mantenimiento | — |

Total hasta la operación: **5 a 6 meses**.

## 4. Inversión

Estimación para un edificio de 2 000 m² y 26 zonas (`config/edificio.yaml → economia`; supuestos que deben
cotizarse localmente):

| Partida | USD |
|---|---:|
| Sensores de ocupación, temperatura y luz | 6 800 |
| Pasarelas BACnet/Modbus para VRF | 9 000 |
| Control de iluminación | 24 000 |
| Enchufes inteligentes | 5 000 |
| Medición eléctrica | 4 000 |
| Servidor y red | 3 000 |
| Software e integración | 8 000 |
| Puesta en marcha y capacitación | 4 000 |
| **Total** | **63 800** |

Operación y mantenimiento: 3 000 USD al año. La planta de respaldo (grupo de 110 kW, transferencia, tanque y UPS)
es una inversión aparte, que el edificio suele tener ya; el EMS sólo necesita leer su estado.

Las cifras de ahorro, recuperación y valor presente están en [`../README.md`](../README.md) y en el dashboard
«Resultados → Negocio».

## 5. Cómo se demuestra el ahorro

Medición y verificación según el protocolo internacional IPMVP:

- **Línea base**: consumo del edificio antes del EMS, ajustado por clima (grados-día) y ocupación.
- **Opción C (todo el edificio)** con el medidor de red, y **opción B** en la fase 2 comparando la planta
  controlada con las demás.
- El gemelo digital calibrado da una segunda referencia: qué habría consumido el edificio sin EMS con el clima
  y la ocupación reales de cada día.
- Informe mensual: energía, demanda máxima, horas de confort y alarmas.

## 6. Riesgos

| Riesgo | Mitigación |
|---|---|
| El fabricante del VRF no abre el control (sólo lectura) | confirmarlo en la fase 0; alternativa: control por contactos o termostatos compatibles |
| El ahorro real es menor que el simulado | el modelo se calibra con datos reales en la fase 1 antes de prometer cifras; la fase 2 mide en pequeño |
| Quejas de confort | consigna y horarios por zona, control manual desde el panel, límites de confort con prioridad sobre el ahorro |
| Pérdida de comunicación | cada equipo mantiene su termostato local; el EMS pasa la zona a modo seguro |
| Ciberseguridad | HTTPS, órdenes sólo con sesión, auditoría y red de control separada ([`../deploy/seguridad/README.md`](../deploy/seguridad/README.md)) |
| Datos de sensores defectuosos | el supervisor detecta sensores congelados o fuera de rango y deja de usarlos |

## 7. Lo que el proyecto ya tiene resuelto

- Reglas probadas con 10 escenarios normales y anómalos y con paridad exacta entre Python y Node-RED.
- Modelo validado contra EnergyPlus (ASHRAE Guideline 14).
- Tableros de operación, alarmas, auditoría, reglas y negocio.
- Despliegue reproducible con copias de seguridad, alertas y HTTPS.
- Diseño de la planta de respaldo con paneles en paralelo ([`PLANTA_RESPALDO.md`](PLANTA_RESPALDO.md)).

Lo que **no** está hecho: las pasarelas a equipos reales, la calibración con datos medidos y la validación en
campo. Eso es exactamente el piloto.
