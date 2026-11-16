# Resumen de resultados (generado automáticamente)

## Auditoría energética (línea base)

- **area_m2**: 1,980.000
- **energia_semana_kwh**: 39,447.807
- **energia_anual_mwh**: 514.230
- **eui_kwh_m2_anio**: 259.712
- **demanda_max_15min_kw**: 138.013
- **factor_carga**: 0.425
- **fp_medio**: 0.911
- **costo_anual_usd**: 141,727.543
- **co2_anual_t**: 159.411
- **confort_pct**: 98.794

## Clasificación de cargas

| uso | clasificacion | e_kwh | participacion_pct | e_anual_mwh |
|---|---|---|---|---|
| HVAC (zonas no críticas) | no crítica / diferible | 26,662.62 | 67.59 | 347.57 |
| Iluminación (zonas no críticas) | no crítica / atenuable | 4,640.36 | 11.76 | 60.49 |
| Enchufes y equipos (zonas no críticas) | no crítica / deslastrable | 5,528.06 | 14.01 | 72.06 |
| Cuarto de servidores (Z06) | crítica | 1,803.98 | 4.57 | 23.52 |
| Cargas fijas del edificio | crítica / mixta | 811.50 | 2.06 | 10.58 |

## Validación del gemelo digital contra EnergyPlus (año completo)

- **NMBE horario (%)**: 7.526
- **CV(RMSE) horario (%)**: 21.174
- **Cumple ASHRAE Guideline 14**: True
- **Energía anual E+ (kWh)**: 552,472.200
- **Energía anual modelo (kWh)**: 510,808.182

## Escenarios (4 semanas tipo con el EPW de Panamá, mismo clima y ocupación)

| escenario | energia_kwh | demanda_max_15min_kw | confort_pct | ahorro_pct | energia_ahorrada_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | co2_evitado_t_anio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 39,447.81 | 138.01 | 98.79 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas | 19,359.07 | 109.72 | 98.93 | 50.92 | 20,088.74 | 28.30 | 58,511.52 | 339,000.58 | 1.15 | 852.72 | 0.05 | 81.18 |
| reglas_dr | 18,853.27 | 92.57 | 98.94 | 52.21 | 20,594.54 | 45.44 | 64,141.69 | 379,854.02 | 1.04 | 949.35 | 0.05 | 83.22 |
| mpc | 18,938.77 | 92.58 | 99.13 | 51.99 | 20,509.04 | 45.43 | 63,888.23 | 378,014.85 | 1.05 | 945.00 | 0.05 | 82.88 |
| baseline_fv | 32,138.56 | 110.33 | 98.79 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas_fv | 13,373.62 | 82.45 | 98.93 | 58.39 | 18,764.95 | 27.88 | 56,947.21 | 327,649.67 | 1.18 | 825.87 | 0.05 | 75.83 |
| reglas_dr_fv | 12,867.26 | 83.00 | 98.94 | 59.96 | 19,271.30 | 27.33 | 58,436.60 | 338,456.95 | 1.15 | 851.43 | 0.05 | 77.88 |
| mpc_fv | 12,922.14 | 83.36 | 99.13 | 59.79 | 19,216.42 | 26.98 | 58,137.89 | 336,289.50 | 1.15 | 846.31 | 0.05 | 77.65 |

## Pronóstico día siguiente

| fuente | modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|---|
| EnergyPlus (año 2006, 4 semanas de validación) | regresion | 2.29 | 3.02 | 3.71 | -2.37 | 0.99 |
| EnergyPlus (año 2006, 4 semanas de validación) | persistencia | 3.31 | 4.49 | 5.41 | 0.00 | 0.98 |
| EnergyPlus (año 2006, 4 semanas de validación) | sarimax | 2.87 | 6.20 | 5.02 | 2.08 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | regresion | 3.23 | 5.34 | 21.08 | 2.01 | 0.97 |
| Gemelo digital (reglas_dr, 1 semana de validación) | persistencia | 3.70 | 6.45 | 17.40 | 5.71 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | sarimax | 8.83 | 17.60 | 76.27 | -6.62 | 0.68 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 99.30 | 90.70 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | True | 99.67 | 94.00 | confort=OK;confort_vs_baseline=OK;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno en la sala de conferencias Z03) | True | 99.11 | 90.70 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado en cubículos Z02 (4 h) | True | 98.85 | 90.70 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango en Oficina 2 P1 Z08 (85 °C) | True | 99.05 | 90.70 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso en Oficina 1 P1 Z07 (σ = 2 °C) | True | 98.95 | 90.70 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla del terminal VRF de la Oficina 1 P2 Z12 (10–14 h) | True | 98.62 | 90.70 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +25 kW en Oficina 2 P2 Z13 (13–15 h) | True | 98.64 | 94.00 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 99.05 | 90.70 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento del cuarto de servidores (falla del VRF-SRV, 2 h) | True | 99.05 | 90.70 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 10
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 100.000
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 1.832
- **latencia_p99_ms**: 3.001

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 17
- **alarmas_nodered**: 17
- **latencia_media_nodered_ms**: 3.472

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 151.52 | 40.68 | 6.89 | 9.72 | 9.67 | 12.61 |
| 15.00 | 900,000.00 | 454.55 | 122.03 | 20.66 | 29.16 | 29.00 | 37.83 |
| 30.00 | 1,800,000.00 | 909.09 | 244.06 | 41.31 | 58.31 | 58.00 | 75.66 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 58.22 | 244,020.36 | 27.88 | 56,908.25 | 327,366.99 | 1.18 | 825.20 | 0.05 | nan |
| tarifa | 70% | 58.22 | 244,020.36 | 27.88 | 39,835.77 | 203,486.35 | 1.72 | 532.20 | 0.05 | nan |
| capex | 70% | 58.22 | 244,020.36 | 27.88 | 56,908.25 | 346,506.99 | 0.83 | 1,221.72 | 0.04 | nan |
| tarifa | 130% | 58.22 | 244,020.36 | 27.88 | 73,980.72 | 451,247.64 | 0.90 | 1,118.21 | 0.05 | nan |
| capex | 130% | 58.22 | 244,020.36 | 27.88 | 56,908.25 | 308,226.99 | 1.53 | 611.70 | 0.06 | nan |
| ems.setpoint_ocupado_c | 23.00 | 54.43 | 228,125.81 | 23.87 | 52,497.43 | 295,361.37 | 1.28 | 749.50 | 0.05 | 98.77 |
| ems.setpoint_ocupado_c | 25.00 | 61.80 | 259,004.43 | 31.83 | 61,231.49 | 358,737.14 | 1.09 | 899.40 | 0.05 | 95.82 |
| ems.limite_demanda_kw | 27 | 65.37 | 273,992.55 | 25.97 | 63,276.57 | 373,576.57 | 1.06 | 934.50 | 0.05 | 98.41 |
| ems.limite_demanda_kw | 33 | 65.10 | 272,862.23 | 29.77 | 63,940.50 | 378,394.17 | 1.05 | 945.90 | 0.05 | 98.45 |
| ems.equipos_desocupado_ems | 0.20 | 57.70 | 241,837.53 | 27.82 | 56,459.19 | 324,108.58 | 1.19 | 817.50 | 0.05 | 98.47 |
| ems.equipos_desocupado_ems | 0.40 | 56.70 | 237,633.39 | 27.83 | 55,613.94 | 317,975.28 | 1.21 | 802.99 | 0.05 | 98.50 |
| edificio.t_suelo_c | 18.00 | 58.22 | 244,020.36 | 27.88 | 56,908.25 | 327,366.99 | 1.18 | 825.20 | 0.05 | 98.45 |
| edificio.t_suelo_c | 27.00 | 58.84 | 278,522.33 | 27.92 | 63,042.77 | 371,880.03 | 1.06 | 930.49 | 0.04 | 98.33 |
| ocupacion | 80% | 60.57 | 251,768.16 | 30.87 | 59,428.79 | 345,656.45 | 1.13 | 868.46 | 0.05 | 99.32 |
| ocupacion | 120% | 57.08 | 240,851.03 | 26.56 | 55,849.46 | 319,684.22 | 1.20 | 807.03 | 0.05 | 98.72 |
