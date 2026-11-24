# Planta de respaldo del edificio

Diseño del sistema de respaldo eléctrico del edificio de oficinas de 5 plantas (2 000 m², Ciudad de Panamá) y
de su integración con el EMS y con los paneles solares. Los números salen del gemelo digital
(`ems/edificio.py`), no de factores de simultaneidad genéricos: se simula un corte de red de 24 h y se mide lo
que realmente consume el tablero de emergencia. Parámetros en `config/edificio.yaml → respaldo`.

## 1. Qué se respalda

| Tablero de emergencia (con planta) | Fuera del respaldo |
|---|---|
| Los 6 sistemas VRF (5 de planta + el del cuarto de servidores) | Tomacorrientes de oficina (PC, impresoras) |
| Ascensor (14,9 kW) | PTAC de los baños (5 equipos de pared) |
| Iluminación de todas las zonas | Extractores de los baños |
| Cuarto de servidores (1,8 kW de TI, a través del UPS) | |

Durante el corte el EMS pasa a **modo emergencia**: iluminación al 70 %, consigna de 25 °C con ocupación (nadie
puede pedir menos de 24 °C), terminales de pasillo apagados, arranque escalonado de los compresores (2 cada
5 min) y límite del 80 % sobre la potencia de la planta.

## 2. Carga de diseño

Corte de 24 h simulado con el archivo climático de Panamá (EPW TMYx):

| Caso | Pico de carga | Energía en 24 h | Comentario |
|---|---|---|---|
| Día de diseño (13 abr, 33,5 °C) con EMS | **87,7 kW** | 859 kWh | caso de dimensionado |
| Día de diseño sin EMS (sin reglas de emergencia) | 103,5 kW | 1 456 kWh | contingencia: EMS fuera de servicio |
| Día laborable típico (5 nov, 28 °C) con EMS | 52,0 kW | 533 kWh | |
| Fin de semana (edificio vacío) | 8,9 kW | 88 kWh/día | servidores y cargas en espera |

Con el EMS las zonas ocupadas se mantienen en 25–26 °C de media y el cuarto de servidores no pasa de 23 °C.
La toma de carga es gradual (≤ 10 kW por paso de 5 min) gracias al arranque escalonado y a la rampa del inverter.

## 3. Generador

**110 kW continuos (prime) · 137,5 kVA a fp 0,8 · 480 V trifásico** (clase comercial de 150 kVA en emergencia).

- Carga en el pico de diseño: 87,7 / 110 = **80 %** (criterio habitual: no superar el 80 % de la potencia continua).
- Contingencia sin EMS: 103,5 kW = 94 % de la potencia continua, dentro de la potencia de emergencia (120 kW).
- Arranques: los VRF son inverter (≈ 1,5 × la corriente nominal durante unos segundos) y el ascensor lleva
  variador; sólo los PTAC arrancan de forma directa (≈ 5 ×), pero son equipos de 1 kW. El gemelo simula ese pico
  (`p_pico_kw`) y, como el EMS arranca como máximo 2 terminales cada 5 min, nunca coinciden más de 2–3 unidades:
  el pico de arranque no pasa de unos 25–35 kW y no obliga a sobredimensionar la planta.
- Un equipo mayor no conviene: trabajaría más horas en baja carga y obligaría a desperdiciar más energía solar.

Corriente a plena carga: 137,5 kVA / (√3 · 480 V) = 165 A → interruptor de la planta de 200 A.

## 4. Transferencia automática y UPS

- **Transferencia automática (ATS)** de 250 A, 480 V, 4 polos. Detecta la falta de red, arranca la planta y
  transfiere el tablero de emergencia en ≈ 15 s; al volver la red, retransfiere y deja la planta enfriando.
- **UPS de servidores**: 3 kVA / 2,7 kW, en línea de doble conversión, 20 min de autonomía con la carga de TI
  (1,8 kW = 67 % del UPS). Cubre los 15 s del arranque y da margen para un apagado ordenado si la planta no arranca.

### Secuencia de un corte (nada cambia de golpe)

| Momento | Qué ocurre |
|---|---|
| 0 s | Cae la red. El UPS sostiene los servidores; el resto del edificio queda sin tensión |
| ≈ 15 s | La planta arranca y la transferencia le pasa el tablero de emergencia: vuelven la iluminación (al 70 %) y el ascensor |
| 3 min | Termina la protección de rearranque de los compresores; el VRF de los servidores vuelve primero |
| 5 min en adelante | **Toma de carga escalonada**: el EMS devuelve los terminales de 2 en 2 cada 5 min, la zona más caliente primero. La planta sube de ≈ 8 kW a su régimen en unos 50 min |
| 5 min | Los paneles se resincronizan y empiezan a aportar en cuanto la carga supera el mínimo de la planta |
| durante la espera | Las zonas se calientan (≈ +1 °C en las ocupadas) y luego se estabilizan en la consigna de emergencia de 25 °C |
| vuelve la red | Retransferencia: los compresores paran otra vez y vuelven por turnos; la temperatura baja poco a poco a 24 °C |

Cada compresor añade además unos segundos de pico al arrancar (campo `p_pico_kw`); como entran por turnos, nunca
se suman más de 2–3.

## 5. Paneles solares en paralelo con la planta

La fotovoltaica de la azotea (55 kW pico) no se desconecta durante el corte: la planta forma la red y el inversor
se vuelve a sincronizar 5 min después (IEEE 1547). Para no dañar el motor diésel, el controlador recorta la
generación solar de modo que la planta nunca baje del **30 % de su carga (33 kW)**; por debajo de ese punto el
diésel no quema bien (*wet stacking*).

| Corte de 24 h | Solar aprovechada | Solar recortada | Diésel con paneles | Diésel sin paneles |
|---|---|---|---|---|
| Día de diseño | 307 kWh | 28 kWh | 212 L | 285 L |
| Día típico | 109 kWh | 78 kWh | 181 L | 207 L |

Los paneles ahorran entre un 13 % y un 26 % del diésel según el día.

## 6. Combustible

Curva de consumo: 0,03 L/h por kW nominal en vacío + 0,24 L por kWh entregado (≈ 30 L/h al 100 %, 16,5 L/h al
50 %, 3,3 L/h en vacío).

**Tanque de 600 L**: 2 días del día de diseño sin sol (2 × 285 L) o casi 3 días con paneles.

## 7. Limitaciones a tener en cuenta

- **Baja carga de noche y en fin de semana.** Con el edificio vacío la planta entrega 3–9 kW (3–8 % de su
  potencia). Es aceptable en cortes cortos; en cortes de varios días conviene una prueba mensual con carga o un
  banco de carga para limpiar el motor.
- **En fin de semana casi toda la energía solar se recorta**, porque la carga del edificio ya está por debajo
  del mínimo de la planta. Un banco de baterías pequeño permitiría apagar la planta en esas horas; no está
  incluido en este diseño.
- Las cifras son de un gemelo digital validado contra EnergyPlus con datos simulados; la selección final de
  equipos debe confirmarse con el proveedor (curva de consumo real, altitud y temperatura de operación).

## 8. Cómo se ve y cómo se prueba

- **Panel 3D**: la planta está dibujada en el patio técnico junto al edificio (grupo electrógeno, tanque con su
  nivel y tablero de transferencia) y la tarjeta «Fuentes de energía» muestra por dónde circula la potencia.
- **Dashboard «Tiempo real» → pestaña «Respaldo»**: fuente actual, potencia y carga de la planta, combustible,
  autonomía, las tres fuentes (red, planta y paneles) y la ficha de diseño.
- **Simular un corte**: panel → pestaña «Simular» → «Corte de energía». Para probar el caso sin planta, lanzar
  además «Falla de la planta de respaldo».
- Pruebas automáticas: `tests/test_ems.py` (`test_corte_con_planta_de_respaldo_y_paneles`,
  `test_corte_sin_planta_solo_ups_de_servidores`) y `tests/test_eventos.py`.
