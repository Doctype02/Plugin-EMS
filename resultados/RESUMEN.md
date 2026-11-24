# Resumen de resultados (generado automáticamente)

## Auditoría energética (línea base)

- **area_m2**: 1,980.000
- **energia_semana_kwh**: 43,631.854
- **energia_anual_mwh**: 568.772
- **eui_kwh_m2_anio**: 287.259
- **demanda_max_15min_kw**: 131.582
- **factor_carga**: 0.493
- **fp_medio**: 0.909
- **costo_anual_usd**: 112,870.198
- **co2_anual_t**: 176.319
- **confort_pct**: 100.000

## Clasificación de cargas

| uso | clasificacion | e_kwh | participacion_pct | e_anual_mwh |
|---|---|---|---|---|
| HVAC (zonas no críticas) | no crítica / diferible | 30,831.42 | 70.67 | 401.91 |
| Iluminación (zonas no críticas) | no crítica / atenuable | 4,640.43 | 10.64 | 60.49 |
| Enchufes y equipos (zonas no críticas) | no crítica / deslastrable | 5,528.10 | 12.67 | 72.06 |
| Cuarto de servidores (Z06) | crítica | 1,819.24 | 4.17 | 23.71 |
| Cargas fijas del edificio | crítica / mixta | 811.50 | 1.86 | 10.58 |

## Validación del gemelo digital contra EnergyPlus (año completo)

- **NMBE horario (%)**: 5.611
- **CV(RMSE) horario (%)**: 13.454
- **Cumple ASHRAE Guideline 14**: True
- **Energía anual E+ (kWh)**: 552,472.200
- **Energía anual modelo (kWh)**: 521,410.064

## Escenarios (4 semanas tipo con el EPW de Panamá, mismo clima y ocupación)

| escenario | energia_kwh | demanda_max_15min_kw | confort_pct | ahorro_pct | energia_ahorrada_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | co2_evitado_t_anio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 43,631.85 | 131.58 | 100.00 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas | 21,740.22 | 129.69 | 97.73 | 50.17 | 21,891.64 | 1.90 | 45,065.64 | 241,435.11 | 1.51 | 621.95 | 0.04 | 88.47 |
| reglas_dr | 21,740.22 | 129.69 | 97.73 | 50.17 | 21,891.64 | 1.90 | 45,065.64 | 241,435.11 | 1.51 | 621.95 | 0.04 | 88.47 |
| mpc | 21,620.02 | 139.75 | 98.20 | 50.45 | 22,011.83 | -8.17 | 43,495.27 | 230,040.23 | 1.56 | 595.00 | 0.04 | 88.95 |
| baseline_fv | 36,322.61 | 112.16 | 100.00 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas_fv | 16,250.59 | 111.30 | 97.73 | 55.26 | 20,072.02 | 0.86 | 43,533.84 | 230,320.09 | 1.56 | 595.66 | 0.05 | 81.11 |
| reglas_dr_fv | 16,250.59 | 111.30 | 97.73 | 55.26 | 20,072.02 | 0.86 | 43,533.84 | 230,320.09 | 1.56 | 595.66 | 0.05 | 81.11 |
| mpc_fv | 16,131.78 | 126.63 | 98.20 | 55.59 | 20,190.83 | -14.47 | 41,012.20 | 212,022.67 | 1.67 | 552.39 | 0.05 | 81.59 |

## Pronóstico día siguiente

| fuente | modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|---|
| EnergyPlus (año 2006, 4 semanas de validación) | regresion | 2.29 | 3.02 | 3.71 | -2.37 | 0.99 |
| EnergyPlus (año 2006, 4 semanas de validación) | persistencia | 3.31 | 4.49 | 5.41 | 0.00 | 0.98 |
| EnergyPlus (año 2006, 4 semanas de validación) | sarimax | 2.87 | 6.20 | 5.02 | 2.08 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | regresion | 2.60 | 5.48 | 7.88 | 34.13 | 0.98 |
| Gemelo digital (reglas_dr, 1 semana de validación) | persistencia | 2.88 | 6.19 | 5.55 | 37.40 | 0.97 |
| Gemelo digital (reglas_dr, 1 semana de validación) | sarimax | 15.05 | 31.27 | 209.90 | -6.56 | 0.27 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 99.52 | 97.40 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | False | 97.21 | 123.70 | confort=OK;confort_vs_baseline=FALLA;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno en la sala de conferencias Z03) | True | 99.57 | 97.00 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado en cubículos Z02 (4 h) | True | 99.56 | 97.00 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango en Oficina 2 P1 Z08 (85 °C) | True | 99.56 | 97.00 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso en Oficina 1 P1 Z07 (σ = 2 °C) | True | 99.56 | 97.00 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla del terminal VRF de la Oficina 1 P2 Z12 (10–14 h) | True | 99.25 | 97.00 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +25 kW en Oficina 2 P2 Z13 (13–15 h) con límite de 100 kW | True | 99.37 | 102.70 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 99.56 | 97.00 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento del cuarto de servidores (falla del VRF-SRV, 2 h) | True | 99.56 | 97.00 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 9
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 97.368
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 2.363
- **latencia_p99_ms**: 3.865

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 14
- **alarmas_nodered**: 14
- **latencia_media_nodered_ms**: 4.918

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 151.52 | 43.24 | 0.29 | 6.83 | 9.67 | 13.40 |
| 15.00 | 900,000.00 | 454.55 | 129.72 | 0.86 | 20.48 | 29.00 | 40.21 |
| 30.00 | 1,800,000.00 | 909.09 | 259.43 | 1.72 | 40.97 | 58.00 | 80.42 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 55.31 | 261,103.42 | 0.86 | 43,494.29 | 230,033.15 | 1.56 | 594.99 | 0.05 | nan |
| tarifa | 70% | 55.31 | 261,103.42 | 0.86 | 30,446.00 | 135,352.66 | 2.29 | 371.04 | 0.05 | nan |
| capex | 70% | 55.31 | 261,103.42 | 0.86 | 43,494.29 | 249,173.15 | 1.10 | 892.84 | 0.04 | nan |
| tarifa | 130% | 55.31 | 261,103.42 | 0.86 | 56,542.58 | 324,713.64 | 1.19 | 818.93 | 0.05 | nan |
| capex | 130% | 55.31 | 261,103.42 | 0.86 | 43,494.29 | 210,893.15 | 2.03 | 434.60 | 0.06 | nan |
| ems.setpoint_ocupado_c | 23.00 | 51.77 | 244,403.05 | -12.35 | 38,493.96 | 193,749.93 | 1.78 | 509.17 | 0.05 | 97.50 |
| ems.setpoint_ocupado_c | 25.00 | 58.90 | 278,047.52 | 16.78 | 48,998.61 | 269,973.36 | 1.38 | 689.45 | 0.04 | 94.05 |
| ems.limite_demanda_kw | 153 | 55.31 | 261,103.42 | 0.86 | 43,494.29 | 230,033.15 | 1.56 | 594.99 | 0.05 | 97.23 |
| ems.limite_demanda_kw | 187 | 55.31 | 261,103.42 | 0.86 | 43,494.29 | 230,033.15 | 1.56 | 594.99 | 0.05 | 97.23 |
| ems.equipos_desocupado_ems | 0.20 | 54.96 | 259,433.38 | 0.48 | 43,141.16 | 227,470.78 | 1.58 | 588.93 | 0.05 | 97.21 |
| ems.equipos_desocupado_ems | 0.40 | 54.23 | 256,008.73 | -0.24 | 42,430.60 | 222,314.84 | 1.61 | 576.73 | 0.05 | 97.16 |
| edificio.t_suelo_c | 24.00 | 55.68 | 255,029.26 | 4.09 | 43,130.50 | 227,393.40 | 1.58 | 588.74 | 0.05 | 98.17 |
| edificio.t_suelo_c | 30.00 | 54.99 | 267,309.65 | -3.55 | 43,658.84 | 231,227.15 | 1.56 | 597.81 | 0.05 | 94.19 |
| ocupacion | 80% | 57.31 | 268,913.03 | 4.57 | 45,386.56 | 243,763.73 | 1.50 | 627.46 | 0.05 | 98.20 |
| ocupacion | 120% | 54.36 | 257,906.09 | 0.29 | 42,890.03 | 225,648.54 | 1.59 | 584.62 | 0.05 | 97.12 |
