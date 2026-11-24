# Informe técnico: EMS para un edificio de oficinas en Ciudad de Panamá

UTP · Facultad de Ingeniería Eléctrica · Producción de la Energía Eléctrica (0877) · II Semestre 2026

## 1. Resumen

Se diseñó, simuló y desplegó un Sistema de Gestión de Energía (EMS) para un edificio de oficinas de 5 plantas
(2 000 m², 26 zonas, 6 sistemas VRF, 5 PTAC y 55 kWp fotovoltaicos) con clima de Ciudad de Panamá. El EMS se
probó sobre un gemelo digital del edificio validado contra EnergyPlus.

| Indicador (4 semanas tipo del año) | Sin EMS | Con EMS (reglas) | Diferencia |
|---|---|---|---|
| Energía | 43 632 kWh | 21 740 kWh | **−50,2 %** |
| Demanda máxima de 15 min | 131,6 kW | 129,7 kW | −1,9 kW |
| Costo de la energía | 6 838 USD | 3 407 USD | −50 % |
| Tiempo en confort (21–26 °C con ocupación) | 100,0 % | 97,7 % | −2,3 puntos |

Ahorro anual estimado: **45 066 USD**. Inversión: 63 800 USD. Recuperación: **1,5 años**. Valor presente neto a
10 años: 241 000 USD (tasa del 8 %). Tasa interna de retorno: 68 %. CO₂ evitado: 88 t al año.

El EMS ahorra la mitad de la energía, pero con el encendido escalonado por planta de las 7:00 casi no reduce el
pico: el lunes el edificio arranca caliente (sección 4).

Estas cifras son de simulación con datos de sensores simulados y con tarifas e inversión supuestas (sección 9).

## 2. El edificio

- 5 plantas de 20 × 20 m (planta baja y cuatro plantas tipo), 26 zonas acondicionadas, 198 personas de aforo.
- Climatización: 5 sistemas VRF de planta (54–62 kW térmicos), uno para el cuarto de servidores y 5 PTAC en baños.
- Envolvente del modelo OpenStudio/EnergyPlus del equipo: muro U 2,48, cubierta U 0,61, vidrio tintado U 5,71 /
  SHGC 0,50, con un 69 % de fachada acristalada.
- Servicio eléctrico de 480 V trifásico. Límite de demanda: 170 kW. Tarifa: 0,15672 USD/kWh, 15,03 USD/kW·mes
  de demanda máxima y 10,03 USD/mes de cargo fijo.
- Fotovoltaica en la azotea: 55 kWp (variante «ConPV» del modelo).

## 3. Gemelo digital

`ems/edificio.py` simula el edificio en pasos de 5 minutos:

- **Modelo térmico de dos nodos por zona** (ISO 13790 simplificado): un nodo de aire, que responde en minutos, y
  un nodo de masa (losas y muros), que responde en horas. Es lo que hace que el interior siga al clima exterior
  con retraso cuando el aire está apagado y que la temperatura cambie de forma gradual.
- **Climatización**: terminales VRF modulantes con termostato e histéresis; los compresores inverter suben de
  carga en rampa (10 % por minuto) y añaden un pico de arranque de unos segundos (1,5 × en VRF, 5 × en PTAC).
- **Cargas**: iluminación, tomacorrientes, servidores y ascensor según los horarios del modelo, con llegada y
  salida gradual del personal.
- **Medidor**: P, Q, S, factor de potencia, demanda de 15 min y las **tres líneas** (corriente, tensión y
  potencia por fase, con el desbalance de las cargas monofásicas).
- **Sensores** con ruido y fallas (congelado, fuera de rango, deriva).
- **Planta de respaldo**, UPS y paneles en paralelo durante un corte (sección 6).

### Validación contra EnergyPlus

Se compara la operación sin EMS del gemelo con la simulación anual de EnergyPlus del mismo edificio, hora a hora,
con los criterios de ASHRAE Guideline 14 (NMBE dentro de ±10 % y CV(RMSE) ≤ 30 %).

| Uso final anual | EnergyPlus | Gemelo | Diferencia |
|---|---|---|---|
| Enfriamiento | 318,9 MWh | 286,2 MWh | −10,3 % |
| Ventiladores | 74,9 MWh | 76,0 MWh | +1,6 % |
| Iluminación | 60,6 MWh | 60,9 MWh | +0,5 % |
| Equipos (incluye ascensor) | 98,1 MWh | 87,7 MWh | −10,6 % |
| **Total** | **552,5 MWh** | **521,4 MWh** | **−5,6 %** |

Serie horaria anual: **NMBE 5,6 %** y **CV(RMSE) 13,5 %**, dentro de los dos criterios. Pico anual: 132,7 kW en
EnergyPlus frente a 114,3 kW en el gemelo.

Una diferencia deliberada: el modelo de EnergyPlus usa el terreno a 18 °C (valor por defecto del programa), que
no corresponde a Panamá. El gemelo usa 18 °C sólo para esta comparación y 27 °C para operar.

## 4. Reglas del EMS

El EMS decide cada 5 minutos con lo que miden los sensores, nunca con el estado interno del modelo. La misma
lógica existe en Python (`ems/control.py`) y en Node-RED (`nodered/src/ems_reglas.js`), y una prueba comprueba
que ambas dan exactamente el mismo resultado (0 diferencias en 2 016 pasos, también durante un corte de red).

| Grupo | Reglas |
|---|---|
| Horario y confort | horario laboral; encendido escalonado por planta; aire apagado fuera de horario; consigna de 24 °C con ocupación; retardo de vacancia de 15 min; espera a 27 °C sin ocupación |
| Secuencia | rampa de consigna (3 °C/h); arranque escalonado (2 terminales cada 5 min); arranque suave del compresor; llegada gradual |
| Iluminación y enchufes | atenuación por luz natural (500 lux); corte de standby |
| Demanda | rotación de compresores; deslastre de luces y enchufes |
| Protección y seguridad | protección por calor (32 °C) y por frío; validación de sensores y modo seguro; modo emergencia con la planta; zonas críticas intocables |

Prioridad: protección y seguridad → control manual del operador → límite de demanda → secuencia → horario,
ocupación e iluminación. El dashboard «Reglas» muestra las 19 reglas con sus parámetros y cuántas zonas maneja
cada una en cada momento.

### El encendido de la mañana y el problema del lunes

El EMS enciende el VRF de una planta cada 15 minutos: PB a las 7:00, P1 a las 7:15, P2 a las 7:30, P3 a las 7:45
y P4 a las 8:00, sin pasillos ni baños y con consigna de 24 °C. De 6:00 a 8:00 las reglas que dependen de la
temperatura quedan desactivadas: sólo manda ese horario. Dentro de cada planta los terminales entran de 2 en 2 y
la consigna baja en rampa, así que la potencia sube en escalones.

De martes a viernes el resultado es bueno: pico de 80–97 kW y oficinas a 24 °C a la entrada. El lunes no: apagar
el aire el fin de semana es lo que más energía ahorra, pero el edificio amanece a 28–30 °C y una hora de
enfriamiento no alcanza. La recuperación se junta con la llegada del personal, el pico sube a ≈ 141 kW y las
oficinas reciben a la gente a 26–27 °C.

| Encendido de la mañana | Pico del lunes | Pico de las 4 semanas | Confort | Energía |
|---|---|---|---|---|
| Por planta desde las 7:00 (desplegado) | ≈ 141 kW | 129,7 kW | 97,7 % | 21 740 kWh |
| Arranque óptimo (alternativa implementada) | 89 kW | 106,0 kW | 99,9 % | 22 110 kWh |

El arranque óptimo hace que cada zona empiece antes cuanto más caliente está (hasta 7 horas antes de la entrada),
por turnos y sin pasar de 90 kW mientras el edificio está cerrado. Cuesta un 1,7 % más de energía y evita 24 kW
de pico. Se activa quitando el bloque `ems.arranque_por_planta` de la configuración.

Un detalle aprendido en el camino: con un tope de potencia, rotar los compresores en cada paso es
contraproducente, porque todos quedan siempre arrancando en rampa y ninguno entrega su capacidad. El limitador da
prioridad a los que ya están en marcha.

## 5. Resultados

Cuatro semanas tipo de 2026 (febrero, mayo, agosto y noviembre) con el archivo climático de Panamá, el mismo
clima y la misma ocupación para todas las estrategias.

| Escenario | Energía (kWh) | Demanda máx. (kW) | Confort (%) | Ahorro (%) | Ahorro anual (USD) | Recuperación (años) |
|---|---|---|---|---|---|---|
| Sin EMS | 43 632 | 131,6 | 100,0 | — | — | — |
| Reglas | 21 740 | 129,7 | 97,7 | 50,2 | 45 066 | 1,5 |
| Reglas + respuesta a la demanda | 21 740 | 129,7 | 97,7 | 50,2 | 45 066 | 1,5 |
| Control predictivo (MPC) | 21 620 | 139,8 | 98,2 | 50,4 | 43 495 | 1,6 |
| Sin EMS, con paneles | 36 323 (red) | 112,2 | 100,0 | — | — | — |
| Reglas + DR, con paneles | 16 251 (red) | 111,3 | 97,7 | 55,3 | 43 534 | 1,6 |

Lectura:

- Las tres estrategias ahorran casi lo mismo en energía. El ahorro viene de dejar de climatizar un edificio
  vacío, no de la sofisticación del algoritmo.
- El pico casi no baja, y con el control predictivo sube: todas comparten el encendido de las 7:00 y el
  problema del lunes.
- Con el límite de 170 kW, la respuesta a la demanda no llega a actuar. Su funcionamiento se comprueba aparte
  con un límite de 100 kW (prueba P08).

Otras comprobaciones: 9 de 10 pruebas de aceptación (operación normal, sensores congelados o fuera de rango,
falla de un terminal, pico de carga, pérdida del 30 % de las órdenes y sobrecalentamiento de servidores). Falla
la de ola de calor: con el encendido a las 7:00 el confort queda 2,8 puntos por debajo del de la línea base; con
el arranque óptimo pasaban las 10. Latencia de decisión de unos 4 ms (percentil 99); pronóstico de demanda del
día siguiente con un error medio de 2,6 kW.

## 6. Planta de respaldo

Diseño completo en [`PLANTA_RESPALDO.md`](PLANTA_RESPALDO.md). En resumen:

- **Generador diésel de 110 kW continuos (137,5 kVA)** con transferencia automática, dimensionado con la carga de
  emergencia del día más caluroso del año (87,7 kW, el 80 % de la planta).
- **UPS de 3 kVA** para los servidores, que cubre los 15 s del arranque.
- La planta alimenta los VRF, el ascensor, la iluminación y los servidores; quedan fuera los tomacorrientes de
  oficina y los aires de los baños.
- **Los paneles siguen produciendo** en paralelo con la planta, recortados para que ésta no baje del 30 % de su
  carga. Ahorran entre el 13 % y el 26 % del diésel.
- **Toma de carga escalonada**: tras la transferencia los compresores vuelven de 2 en 2 cada 5 minutos, y lo
  mismo al regresar la red. En modo emergencia: luces al 70 %, consigna de 25 °C y pasillos sin aire.
- Tanque de 600 L: dos días del día de diseño sin sol.

## 7. Plataforma

```
sensores / gemelo ──MQTT──► Node-RED (reglas) ──MQTT──► actuadores
        │                        │
        └──────► InfluxDB ◄──────┘ ──► Grafana (6 dashboards + panel 3D)
```

- **Mosquitto** (MQTT), **Node-RED** (reglas y endpoint de control), **InfluxDB 2** (históricos) y **Grafana 13**
  con un panel propio que muestra el edificio en 3D, la planta de respaldo y el flujo de energía.
- Seis dashboards con pestañas: Edificio 3D, Tiempo real, Zonas, Alarmas, Reglas y Resultados (con la pestaña
  «Negocio»).
- Despliegue con systemd en dos servidores. El público usa HTTPS; las órdenes de control sólo pasan con sesión
  iniciada y cada una queda registrada (quién, qué y resultado). Copia de seguridad diaria y cuatro alertas.

## 8. Calidad

- 63 pruebas automáticas en Python y 128 en el panel.
- Paridad exacta entre la lógica de Python y la de Node-RED.
- Validación del modelo contra EnergyPlus dentro de ASHRAE Guideline 14.

## 9. Supuestos y limitaciones

- **Datos simulados.** No hay mediciones de un edificio real; los sensores son los del gemelo, con ruido y
  fallas inyectadas. Con datos reales se esperan errores mayores, sobre todo en el pronóstico.
- **Tarifa, inversión y factor de emisión son supuestos** documentados en `config/edificio.yaml`. Deben
  contrastarse con el pliego tarifario vigente y con cotizaciones locales antes de usarlos en una propuesta.
- **La línea base es exigente con el EMS a favor.** El modelo sin EMS enfría a 22 °C las 24 horas, todos los
  días. Un edificio que ya apague el aire de noche con un temporizador ahorraría bastante menos.
- El gemelo subestima el enfriamiento anual de EnergyPlus en un 10 % y el pico en un 14 %.
- La planta de respaldo trabaja en baja carga de noche y en fin de semana (3–9 kW), y en esas horas se desperdicia
  casi toda la energía solar. Un banco de baterías lo resolvería; no está incluido.
- El puente directo con EnergyPlus está implementado pero no se ejecutó en este entorno.

## 10. Siguiente paso

Un piloto en un edificio real, en cinco fases y 5–6 meses, empezando por sólo lectura y por una planta antes de
controlar todo el edificio: [`PILOTO.md`](PILOTO.md).
