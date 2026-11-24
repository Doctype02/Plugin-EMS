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
| reglas | 21,924.50 | 125.68 | 99.31 | 49.75 | 21,707.35 | 5.91 | 45,729.04 | 246,248.83 | 1.48 | 633.34 | 0.04 | 87.72 |
| reglas_dr | 21,924.50 | 125.68 | 99.31 | 49.75 | 21,707.35 | 5.91 | 45,729.04 | 246,248.83 | 1.48 | 633.34 | 0.04 | 87.72 |
| mpc | 21,783.18 | 117.80 | 99.50 | 50.08 | 21,848.67 | 13.78 | 47,860.43 | 261,714.52 | 1.41 | 669.92 | 0.04 | 88.29 |
| baseline_fv | 36,322.61 | 112.16 | 100.00 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas_fv | 16,434.88 | 115.28 | 99.31 | 54.75 | 19,887.73 | -3.12 | 42,271.34 | 221,159.19 | 1.61 | 574.00 | 0.05 | 80.37 |
| reglas_dr_fv | 16,434.88 | 115.28 | 99.31 | 54.75 | 19,887.73 | -3.12 | 42,271.34 | 221,159.19 | 1.61 | 574.00 | 0.05 | 80.37 |
| mpc_fv | 16,294.94 | 104.42 | 99.50 | 55.14 | 20,027.67 | 7.74 | 45,100.22 | 241,686.05 | 1.51 | 622.55 | 0.05 | 80.93 |

## Pronóstico día siguiente

| fuente | modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|---|
| EnergyPlus (año 2006, 4 semanas de validación) | regresion | 2.29 | 3.02 | 3.71 | -2.37 | 0.99 |
| EnergyPlus (año 2006, 4 semanas de validación) | persistencia | 3.31 | 4.49 | 5.41 | 0.00 | 0.98 |
| EnergyPlus (año 2006, 4 semanas de validación) | sarimax | 2.87 | 6.20 | 5.02 | 2.08 | 0.96 |
| Gemelo digital (reglas_dr, 1 semana de validación) | regresion | 2.80 | 6.06 | 8.51 | 37.13 | 0.97 |
| Gemelo digital (reglas_dr, 1 semana de validación) | persistencia | 3.10 | 6.70 | 6.27 | 40.21 | 0.97 |
| Gemelo digital (reglas_dr, 1 semana de validación) | sarimax | 9.81 | 18.50 | 133.03 | -10.34 | 0.74 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 99.95 | 93.80 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | True | 99.61 | 110.40 | confort=OK;confort_vs_baseline=OK;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno en la sala de conferencias Z03) | True | 100.00 | 93.30 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado en cubículos Z02 (4 h) | True | 100.00 | 93.30 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango en Oficina 2 P1 Z08 (85 °C) | True | 100.00 | 93.30 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso en Oficina 1 P1 Z07 (σ = 2 °C) | True | 100.00 | 93.30 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla del terminal VRF de la Oficina 1 P2 Z12 (10–14 h) | True | 99.69 | 93.30 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +25 kW en Oficina 2 P2 Z13 (13–15 h) con límite de 100 kW | True | 99.80 | 102.20 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 100.00 | 93.30 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento del cuarto de servidores (falla del VRF-SRV, 2 h) | True | 100.00 | 93.30 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 10
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 100.000
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 1.923
- **latencia_p99_ms**: 3.320

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 19
- **alarmas_nodered**: 19
- **latencia_media_nodered_ms**: 5.535

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 151.52 | 43.15 | 2.09 | 7.25 | 9.67 | 13.38 |
| 15.00 | 900,000.00 | 454.55 | 129.46 | 6.26 | 21.75 | 29.00 | 40.13 |
| 30.00 | 1,800,000.00 | 909.09 | 258.92 | 12.53 | 43.51 | 58.00 | 80.27 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 54.82 | 258,773.02 | -3.23 | 42,217.57 | 220,769.04 | 1.61 | 573.07 | 0.05 | nan |
| tarifa | 70% | 54.82 | 258,773.02 | -3.23 | 29,552.30 | 128,867.78 | 2.37 | 355.71 | 0.05 | nan |
| capex | 70% | 54.82 | 258,773.02 | -3.23 | 42,217.57 | 239,909.04 | 1.14 | 861.53 | 0.04 | nan |
| tarifa | 130% | 54.82 | 258,773.02 | -3.23 | 54,882.84 | 312,670.29 | 1.23 | 790.44 | 0.05 | nan |
| capex | 130% | 54.82 | 258,773.02 | -3.23 | 42,217.57 | 201,629.04 | 2.09 | 417.75 | 0.06 | nan |
| ems.setpoint_ocupado_c | 23.00 | 51.18 | 241,612.81 | -20.35 | 35,522.20 | 172,186.33 | 1.94 | 458.16 | 0.05 | 99.25 |
| ems.setpoint_ocupado_c | 25.00 | 58.52 | 276,239.92 | 18.52 | 50,023.20 | 277,407.94 | 1.35 | 707.04 | 0.05 | 97.02 |
| ems.limite_demanda_kw | 153 | 54.82 | 258,779.63 | -3.12 | 42,244.19 | 220,962.20 | 1.61 | 573.53 | 0.05 | 99.14 |
| ems.limite_demanda_kw | 187 | 54.82 | 258,779.63 | -3.12 | 42,244.19 | 220,962.20 | 1.61 | 573.53 | 0.05 | 99.14 |
| ems.equipos_desocupado_ems | 0.20 | 54.46 | 257,101.72 | -4.27 | 41,690.61 | 216,945.35 | 1.64 | 564.03 | 0.05 | 99.13 |
| ems.equipos_desocupado_ems | 0.40 | 53.73 | 253,654.85 | -6.03 | 40,694.54 | 209,717.66 | 1.68 | 546.94 | 0.05 | 99.11 |
| edificio.t_suelo_c | 24.00 | 55.20 | 252,834.97 | -0.90 | 41,837.38 | 218,010.36 | 1.63 | 566.55 | 0.05 | 99.64 |
| edificio.t_suelo_c | 30.00 | 54.48 | 264,808.10 | -8.09 | 42,014.09 | 219,292.54 | 1.62 | 569.58 | 0.05 | 97.23 |
| ocupacion | 80% | 56.86 | 266,800.56 | -2.67 | 43,606.23 | 230,845.38 | 1.56 | 596.91 | 0.05 | 99.52 |
| ocupacion | 120% | 53.86 | 255,561.07 | -4.20 | 41,487.51 | 215,471.65 | 1.64 | 560.54 | 0.05 | 99.10 |
