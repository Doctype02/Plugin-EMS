# Resumen de resultados (generado automáticamente)

## Auditoría energética (línea base)

- **area_m2**: 2,020.000
- **energia_semana_kwh**: 16,873.812
- **energia_anual_mwh**: 879.849
- **eui_kwh_m2_anio**: 435.569
- **demanda_max_15min_kw**: 178.149
- **factor_carga**: 0.564
- **fp_medio**: 0.907
- **costo_anual_usd**: 225,593.941
- **co2_anual_t**: 272.753
- **confort_pct**: 96.888

## Clasificación de cargas

| uso | clasificacion | e_kwh | participacion_pct | e_anual_mwh |
|---|---|---|---|---|
| HVAC (zonas no críticas) | no crítica / diferible | 6,138.49 | 36.38 | 320.08 |
| Iluminación (zonas no críticas) | no crítica / atenuable | 1,416.54 | 8.39 | 73.86 |
| Enchufes y equipos (zonas no críticas) | no crítica / deslastrable | 2,401.42 | 14.23 | 125.22 |
| Servidores, seguridad, UPS (Z09, Z10) | crítica | 5,893.85 | 34.93 | 307.32 |
| Ascensores, bombas, iluminación exterior | crítica / mixta | 1,023.54 | 6.07 | 53.37 |

## Escenarios (1 semana, mismo clima y ocupación)

| escenario | energia_kwh | demanda_max_15min_kw | confort_pct | ahorro_pct | energia_ahorrada_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | co2_evitado_t_anio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 16,873.81 | 178.15 | 96.89 | nan | nan | nan | nan | nan | nan | nan | nan | nan |
| reglas | 13,126.85 | 159.67 | 98.66 | 22.21 | 3,746.96 | 18.48 | 44,533.05 | 221,342.45 | 1.85 | 488.09 | 0.08 | 60.57 |
| reglas_dr | 13,110.57 | 145.41 | 98.78 | 22.30 | 3,763.24 | 32.74 | 48,288.28 | 248,591.05 | 1.69 | 541.91 | 0.08 | 60.83 |
| mpc | 12,923.47 | 146.14 | 98.43 | 23.41 | 3,950.34 | 32.01 | 50,003.85 | 261,039.44 | 1.63 | 566.50 | 0.07 | 63.85 |

## Pronóstico día siguiente (semana de validación)

| modelo | mae_kw | rmse_kw | mape_pct | error_pico_kw | r2 |
|---|---|---|---|---|---|
| regresion | 2.46 | 3.69 | 3.22 | -0.49 | 0.99 |
| persistencia | 3.02 | 4.34 | 4.03 | 0.74 | 0.99 |
| sarimax | 11.26 | 18.64 | 18.08 | 2.69 | 0.80 |

## Pruebas normales y anómalas

| id | prueba | superada | confort_pct | demanda_max_kw | detalle_checks |
|---|---|---|---|---|---|
| P01 | Perfil normal (semana) | True | 98.78 | 145.40 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P02 | Ola de calor +4 °C | True | 98.72 | 154.70 | alarma_TEMP_ALTA=OK;confort_vs_baseline=OK;energia_menor_baseline=OK;estabilidad=OK;disponibilidad=OK |
| P03 | Ocupación fuera de horario (evento nocturno Z06) | True | 99.51 | 143.80 | recuperacion=OK;estabilidad=OK;disponibilidad=OK |
| P04 | Sensor congelado Z03 (4 h) | True | 99.96 | 144.90 | alarma_SENSOR_CONGELADO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P05 | Sensor fuera de rango Z05 (85 °C) | True | 99.96 | 144.50 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P06 | Sensor ruidoso Z02 (σ = 2 °C) | True | 99.89 | 143.80 | alarma_SENSOR_FUERA_RANGO=OK;temp_real_acotada=OK;estabilidad=OK;disponibilidad=OK |
| P07 | Falla de HVAC Z04 (10–14 h) | True | 97.20 | 144.50 | alarma_TEMP_ALTA=OK;estabilidad=OK;disponibilidad=OK |
| P08 | Pico de carga +40 kW laboratorio (13–15 h) | True | 98.44 | 173.30 | alarma_DR_ACTIVO=OK;respuesta_dr=OK;estabilidad=OK;disponibilidad=OK |
| P09 | Pérdida del 30 % de comandos | True | 100.00 | 144.50 | confort=OK;demanda_max=OK;estabilidad=OK;disponibilidad=OK |
| P10 | Sobrecalentamiento servidores (falla CRAC 1 h) | True | 99.96 | 144.60 | alarma_SERVIDOR_TEMP=OK;estabilidad=OK;disponibilidad=OK |

## Confiabilidad, disponibilidad y latencia

- **pruebas_superadas**: 10
- **pruebas_total**: 10
- **confiabilidad_logica_pct**: 100.000
- **disponibilidad_pct**: 100.000
- **latencia_media_ms**: 0.237
- **latencia_p99_ms**: 1.037

## Paridad Python ⇄ Node-RED

- **pasos**: 2016
- **pasos_distintos**: 0
- **max_dif_kw**: 0.000
- **alarmas_python**: 85
- **alarmas_nodered**: 85
- **latencia_media_nodered_ms**: 1.083

## Escalamiento en Panamá (mejor escenario por VPN)

| adopcion_pct | area_m2 | edificios_equivalentes | energia_ahorrada_gwh_anio | demanda_evitada_mw | ahorro_musd_anio | inversion_musd | co2_evitado_kt_anio |
|---|---|---|---|---|---|---|---|
| 5.00 | 300,000.00 | 148.51 | 30.59 | 4.75 | 7.43 | 11.35 | 9.48 |
| 15.00 | 900,000.00 | 445.54 | 91.77 | 14.26 | 22.28 | 34.04 | 28.45 |
| 30.00 | 1,800,000.00 | 891.09 | 183.55 | 28.52 | 44.56 | 68.08 | 56.90 |

## Sensibilidad

| parametro | valor | ahorro_pct | energia_ahorrada_anual_kwh | pico_evitado_kw | ahorro_total_usd_anio | vpn_usd | payback_anios | roi_pct | costo_kwh_evitado_usd | confort_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| referencia | - | 22.30 | 196,226.25 | 32.74 | 48,288.28 | 248,591.05 | 1.69 | 541.91 | 0.08 | nan |
| tarifa | 70% | 22.30 | 196,226.25 | 32.74 | 33,801.80 | 143,474.77 | 2.48 | 334.29 | 0.08 | nan |
| capex | 70% | 22.30 | 196,226.25 | 32.74 | 48,288.28 | 271,511.05 | 1.19 | 817.01 | 0.06 | nan |
| tarifa | 130% | 22.30 | 196,226.25 | 32.74 | 62,774.77 | 353,707.34 | 1.28 | 749.53 | 0.08 | nan |
| capex | 130% | 22.30 | 196,226.25 | 32.74 | 48,288.28 | 225,671.05 | 2.19 | 393.78 | 0.09 | nan |
| ems.setpoint_ocupado_c | 23.00 | 20.66 | 181,769.31 | 34.00 | 45,738.83 | 230,091.76 | 1.79 | 505.37 | 0.08 | 98.86 |
| ems.setpoint_ocupado_c | 25.00 | 24.30 | 213,771.94 | 32.38 | 51,727.13 | 273,543.91 | 1.57 | 591.20 | 0.07 | 98.64 |
| ems.limite_demanda_kw | 135 | 23.61 | 207,707.98 | 32.13 | 51,071.35 | 268,785.42 | 1.59 | 581.80 | 0.07 | 98.69 |
| ems.limite_demanda_kw | 160 | 22.22 | 195,500.81 | 23.49 | 45,718.39 | 229,943.50 | 1.79 | 505.08 | 0.08 | 98.66 |
| ems.equipos_desocupado_ems | 0.20 | 21.81 | 191,911.72 | 32.74 | 47,517.23 | 242,996.17 | 1.72 | 530.86 | 0.08 | 98.82 |
| ems.equipos_desocupado_ems | 0.40 | 20.35 | 179,023.45 | 34.10 | 45,462.08 | 228,083.62 | 1.80 | 501.40 | 0.08 | 98.69 |
| clima.t_max_c | 29.50 | 23.14 | 197,039.88 | 30.36 | 47,652.53 | 243,977.92 | 1.72 | 532.80 | 0.08 | 99.36 |
| clima.t_max_c | 33.50 | 22.08 | 200,007.53 | 31.51 | 49,072.06 | 254,278.22 | 1.66 | 553.14 | 0.07 | 98.07 |
| ocupacion | 80% | 23.15 | 200,982.99 | 30.64 | 48,765.06 | 252,050.59 | 1.67 | 548.74 | 0.07 | 98.73 |
| ocupacion | 120% | 22.10 | 196,185.76 | 34.48 | 48,824.22 | 252,479.91 | 1.67 | 549.59 | 0.08 | 98.50 |
