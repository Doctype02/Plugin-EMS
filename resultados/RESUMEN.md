# Resumen de resultados (generado automáticamente)

## Auditoría energética (línea base)

- **area_m2**: 800.000
- **energia_semana_kwh**: 10,654.132
- **energia_anual_mwh**: 138.884
- **eui_kwh_m2_anio**: 173.605
- **demanda_max_15min_kw**: 51.200
- **factor_carga**: 0.310
- **fp_medio**: 0.930
- **costo_anual_usd**: 42,666.298
- **co2_anual_t**: 43.054
- **confort_pct**: 96.404

## Clasificación de cargas

| uso | clasificacion | e_kwh | participacion_pct | e_anual_mwh |
|---|---|---|---|---|
| HVAC (zonas no críticas) | no crítica / diferible | 5,396.37 | 50.65 | 70.35 |
| Iluminación (zonas no críticas) | no crítica / atenuable | 1,342.31 | 12.60 | 17.50 |
| Enchufes y equipos (zonas no críticas) | no crítica / deslastrable | 1,914.58 | 17.97 | 24.96 |
| Cuarto de servidores y cuarto eléctrico (Z09, Z10) | crítica | 2,000.17 | 18.77 | 26.07 |

## Validación del gemelo digital contra EnergyPlus (año completo)

- **NMBE horario (%)**: 3.199
- **CV(RMSE) horario (%)**: 23.016
- **Cumple ASHRAE Guideline 14**: True
- **Energía anual E+ (kWh)**: 143,994.400
- **Energía anual modelo (kWh)**: 139,368.179

## Escenarios (4 semanas tipo con el EPW de Panamá, mismo clima y ocupación)

| escenario | energia_kwh | demanda_max_15min_kw | confort_pct | ahorro_pct | energia_ahorrada_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | co2_evitado_t_anio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 10,654.13 | 51.20 | 96.40 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas | 7,225.15 | 37.29 | 97.35 | 32.18 | 3,428.98 | 13.91 | 13,375.63 | 51,894.68 | 2.72 | 294.86 | 0.15 | 13.86 |
| reglas_dr | 6,994.30 | 35.89 | 97.36 | 34.35 | 3,659.84 | 15.31 | 14,448.36 | 59,678.56 | 2.50 | 331.45 | 0.14 | 14.79 |
| mpc | 6,935.32 | 33.92 | 97.41 | 34.90 | 3,718.81 | 17.28 | 15,030.31 | 63,901.28 | 2.39 | 351.30 | 0.14 | 15.03 |

## Pronóstico día siguiente

| fuente | modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|---|
| EnergyPlus (año 2006, 4 semanas de validación) | regresion | 0.56 | 0.73 | 6.32 | -1.17 | 1.00 |
| EnergyPlus (año 2006, 4 semanas de validación) | persistencia | 0.69 | 1.31 | 3.34 | 0.00 | 0.99 |
| EnergyPlus (año 2006, 4 semanas de validación) | sarimax | 1.29 | 2.63 | 12.35 | -0.05 | 0.97 |
| Gemelo digital (reglas_dr, 1 semana de validación) | regresion | 0.89 | 1.26 | 11.13 | 0.13 | 0.98 |
| Gemelo digital (reglas_dr, 1 semana de validación) | persistencia | 1.26 | 1.83 | 14.78 | 0.62 | 0.95 |
| Gemelo digital (reglas_dr, 1 semana de validación) | sarimax | 1.87 | 3.27 | 31.44 | -1.28 | 0.83 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 97.84 | 28.00 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | True | 99.10 | 34.20 | confort=OK;confort_vs_baseline=OK;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno en la sala de conferencias Z03) | True | 97.01 | 27.60 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado en cubículos Z02 (4 h) | True | 95.52 | 27.60 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango en Oficina 2 Z05 (85 °C) | True | 96.91 | 27.60 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso en Oficina 1 Z04 (σ = 2 °C) | True | 95.43 | 27.40 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla del terminal VRF de la Oficina 3 Z06 (10–14 h) | True | 96.14 | 27.80 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +12 kW en Oficina 4 Z07 (13–15 h) | True | 96.91 | 41.80 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 96.91 | 28.20 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento del cuarto de servidores (falla del VRF-C, 1 h) | True | 96.91 | 27.60 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 10
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 100.000
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 0.244
- **latencia_p99_ms**: 0.895

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 36
- **alarmas_nodered**: 36
- **latencia_media_nodered_ms**: 1.096

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 375.00 | 18.18 | 6.48 | 5.64 | 12.04 | 5.64 |
| 15.00 | 900,000.00 | 1,125.00 | 54.54 | 19.44 | 16.91 | 36.11 | 16.91 |
| 30.00 | 1,800,000.00 | 2,250.00 | 109.07 | 38.88 | 33.82 | 72.22 | 33.81 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 34.16 | 48,550.13 | 15.31 | 14,712.00 | 61,591.55 | 2.45 | 340.44 | 0.14 | nan |
| tarifa | 70% | 34.16 | 48,550.13 | 15.31 | 10,298.40 | 29,565.76 | 3.68 | 189.89 | 0.14 | nan |
| capex | 70% | 34.16 | 48,550.13 | 15.31 | 14,712.00 | 71,221.55 | 1.73 | 529.21 | 0.11 | nan |
| tarifa | 130% | 34.16 | 48,550.13 | 15.31 | 19,125.60 | 93,617.34 | 1.84 | 491.00 | 0.14 | nan |
| capex | 130% | 34.16 | 48,550.13 | 15.31 | 14,712.00 | 51,961.55 | 3.16 | 238.80 | 0.17 | nan |
| ems.setpoint_ocupado_c | 23.00 | 30.15 | 42,852.30 | 12.82 | 12,838.64 | 47,998.18 | 2.85 | 276.54 | 0.15 | 96.87 |
| ems.setpoint_ocupado_c | 25.00 | 38.86 | 55,219.76 | 13.57 | 15,801.68 | 69,498.44 | 2.26 | 377.62 | 0.12 | 97.03 |
| ems.limite_demanda_kw | 27 | 35.93 | 51,061.09 | 13.83 | 14,946.52 | 63,293.31 | 2.41 | 348.44 | 0.13 | 96.94 |
| ems.limite_demanda_kw | 33 | 32.72 | 46,491.22 | 19.40 | 15,172.79 | 64,935.14 | 2.37 | 356.16 | 0.14 | 96.90 |
| ems.equipos_desocupado_ems | 0.20 | 33.80 | 48,028.71 | 14.29 | 14,375.70 | 59,151.31 | 2.51 | 328.97 | 0.14 | 96.97 |
| ems.equipos_desocupado_ems | 0.40 | 33.08 | 47,006.66 | 14.31 | 14,188.96 | 57,796.33 | 2.55 | 322.60 | 0.14 | 97.04 |
| edificio.t_suelo_c | 18.00 | 34.16 | 48,550.13 | 15.31 | 14,712.00 | 61,591.55 | 2.45 | 340.44 | 0.14 | 96.91 |
| edificio.t_suelo_c | 27.00 | 38.33 | 64,480.68 | 12.13 | 16,969.70 | 77,973.77 | 2.09 | 417.46 | 0.10 | 100.00 |
| ocupacion | 80% | 34.91 | 49,145.46 | 16.90 | 15,217.19 | 65,257.32 | 2.36 | 357.68 | 0.13 | 96.88 |
| ocupacion | 120% | 33.65 | 48,201.30 | 12.16 | 13,888.29 | 55,614.61 | 2.61 | 312.35 | 0.14 | 96.96 |
