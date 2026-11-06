# Datos del modelo OpenStudio/EnergyPlus del edificio

Origen: proyecto "EMS_Edificio_Ultima simulacion" (OpenStudio, EnergyPlus 25.2.0, clima
Panamá-Albrook TMYx 2011–2025). Generado con `python tools/importar_energyplus.py --sql <run/eplusout.sql> --epw <files/...epw>`.

| Archivo | Contenido |
|---|---|
| `electricidad_10min.csv` | `Electricity:Facility` cada 10 min (kW), año completo |
| `zonas_horario.csv` | Por zona y hora: temperatura media, HR, ocupantes y frío entregado por el terminal VRF |
| `vrf_horario.csv` | Electricidad horaria de cada sistema VRF (VRF-A, VRF-B, VRF-C) |
| `resumen_anual.json` | Usos finales anuales, pico, horas fuera de setpoint |
| `modelo/in.idf`, `modelo/floorplan.json`, `modelo/workflow.osw` | Modelo de entrada (para el puente Python–EnergyPlus y trazabilidad) |
| `modelo/reporte_tabular_energyplus.html` | Reporte tabular de EnergyPlus (eplustbl) |

Calendario: año 2006 de la simulación (1 de enero = domingo); cada registro se etiqueta con el inicio
del intervalo. El archivo `eplusout.sql` (27 MB) no se incluye; se regenera corriendo el modelo.

Mapeo de zonas: Z01 Recepción, Z02 Cubículos, Z03 Sala de conferencias, Z04–Z07 Oficinas 1–4,
Z08 Pasillo, Z09 Cuarto de servidores ("servo"), Z10 Cuarto eléctrico.
