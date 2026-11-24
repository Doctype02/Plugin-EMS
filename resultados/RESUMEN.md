# Resumen de resultados (generado automáticamente)

## Auditoría energética (línea base)

- **area_m2**: 1,980.000
- **energia_semana_kwh**: 43,631.854
- **energia_anual_mwh**: 568.772
- **eui_kwh_m2_anio**: 287.259
- **demanda_max_15min_kw**: 131.582
- **factor_carga**: 0.493
- **fp_medio**: 0.909
- **costo_anual_usd**: 119,928.274
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
| reglas | 22,110.46 | 105.96 | 99.87 | 49.32 | 21,521.39 | 25.62 | 49,962.44 | 276,967.04 | 1.35 | 706.00 | 0.04 | 86.97 |
| reglas_dr | 22,110.01 | 105.96 | 99.87 | 49.33 | 21,521.84 | 25.62 | 49,964.45 | 276,981.67 | 1.35 | 706.03 | 0.04 | 86.97 |
| mpc | 21,899.70 | 111.85 | 99.93 | 49.81 | 21,732.15 | 19.74 | 49,016.40 | 270,102.43 | 1.38 | 689.76 | 0.04 | 87.82 |
| baseline_fv | 36,322.61 | 112.16 | 100.00 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas_fv | 16,620.84 | 87.62 | 99.87 | 54.24 | 19,701.77 | 24.54 | 48,363.28 | 265,363.33 | 1.40 | 678.55 | 0.05 | 79.62 |
| reglas_dr_fv | 16,620.39 | 86.27 | 99.87 | 54.24 | 19,702.22 | 25.89 | 48,680.12 | 267,662.38 | 1.39 | 683.99 | 0.05 | 79.62 |
| mpc_fv | 16,411.46 | 84.77 | 99.93 | 54.82 | 19,911.15 | 27.39 | 49,461.56 | 273,332.62 | 1.37 | 697.40 | 0.05 | 80.46 |

## Pronóstico día siguiente

| fuente | modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|---|
| EnergyPlus (año 2006, 4 semanas de validación) | regresion | 2.29 | 3.02 | 3.71 | -2.37 | 0.99 |
| EnergyPlus (año 2006, 4 semanas de validación) | persistencia | 3.31 | 4.49 | 5.41 | 0.00 | 0.98 |
| EnergyPlus (año 2006, 4 semanas de validación) | sarimax | 2.87 | 6.20 | 5.02 | 2.08 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | regresion | 3.16 | 6.72 | 27.17 | 4.22 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | persistencia | 3.41 | 7.30 | 23.01 | 5.75 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | sarimax | 14.09 | 27.49 | 194.86 | -6.48 | 0.39 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 99.95 | 92.40 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | True | 100.00 | 105.80 | confort=OK;confort_vs_baseline=OK;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno en la sala de conferencias Z03) | True | 100.00 | 91.50 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado en cubículos Z02 (4 h) | True | 100.00 | 91.50 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango en Oficina 2 P1 Z08 (85 °C) | True | 100.00 | 91.50 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso en Oficina 1 P1 Z07 (σ = 2 °C) | True | 100.00 | 91.50 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla del terminal VRF de la Oficina 1 P2 Z12 (10–14 h) | True | 99.72 | 91.50 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +25 kW en Oficina 2 P2 Z13 (13–15 h) con límite de 100 kW | True | 99.80 | 102.10 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 100.00 | 91.50 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento del cuarto de servidores (falla del VRF-SRV, 2 h) | True | 100.00 | 91.50 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 10
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 100.000
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 2.246
- **latencia_p99_ms**: 5.371

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 2
- **alarmas_nodered**: 2
- **latencia_media_nodered_ms**: 2.339

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 151.52 | 42.51 | 3.88 | 7.57 | 9.67 | 13.18 |
| 15.00 | 900,000.00 | 454.55 | 127.52 | 11.65 | 22.71 | 29.00 | 39.53 |
| 30.00 | 1,800,000.00 | 909.09 | 255.05 | 23.30 | 45.42 | 58.00 | 79.06 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 54.25 | 256,092.16 | 25.89 | 48,610.72 | 267,158.80 | 1.39 | 682.80 | 0.05 | nan |
| tarifa | 70% | 54.25 | 256,092.16 | 25.89 | 34,027.51 | 161,340.62 | 2.03 | 432.51 | 0.05 | nan |
| capex | 70% | 54.25 | 256,092.16 | 25.89 | 48,610.72 | 286,298.80 | 0.98 | 1,018.28 | 0.04 | nan |
| tarifa | 130% | 54.25 | 256,092.16 | 25.89 | 63,193.94 | 372,976.99 | 1.06 | 933.08 | 0.05 | nan |
| capex | 130% | 54.25 | 256,092.16 | 25.89 | 48,610.72 | 248,018.80 | 1.80 | 502.15 | 0.06 | nan |
| ems.setpoint_ocupado_c | 23.00 | 50.13 | 236,640.12 | 22.50 | 44,770.09 | 239,290.53 | 1.52 | 616.88 | 0.05 | 99.92 |
| ems.setpoint_ocupado_c | 25.00 | 58.31 | 275,250.87 | 29.19 | 52,365.60 | 294,404.78 | 1.29 | 747.24 | 0.05 | 98.00 |
| ems.limite_demanda_kw | 153 | 54.25 | 256,092.16 | 25.89 | 48,610.72 | 267,158.80 | 1.39 | 682.80 | 0.05 | 99.81 |
| ems.limite_demanda_kw | 187 | 54.25 | 256,092.16 | 25.89 | 48,610.72 | 267,158.80 | 1.39 | 682.80 | 0.05 | 99.81 |
| ems.equipos_desocupado_ems | 0.20 | 53.88 | 254,340.83 | 25.86 | 48,307.49 | 264,958.46 | 1.40 | 677.59 | 0.05 | 99.81 |
| ems.equipos_desocupado_ems | 0.40 | 53.15 | 250,888.38 | 25.85 | 47,720.27 | 260,697.53 | 1.42 | 667.51 | 0.05 | 99.81 |
| edificio.t_suelo_c | 24.00 | 54.80 | 250,964.25 | 25.88 | 47,811.43 | 261,358.98 | 1.42 | 669.08 | 0.05 | 99.91 |
| edificio.t_suelo_c | 30.00 | 53.64 | 260,750.13 | 25.81 | 49,310.34 | 272,235.33 | 1.37 | 694.80 | 0.05 | 99.38 |
| ocupacion | 80% | 56.18 | 263,592.53 | 26.41 | 49,908.50 | 276,575.68 | 1.35 | 705.07 | 0.05 | 99.96 |
| ocupacion | 120% | 53.30 | 252,916.18 | 24.38 | 47,761.59 | 260,997.33 | 1.42 | 668.22 | 0.05 | 99.88 |
