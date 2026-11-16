# Datos del modelo OpenStudio/EnergyPlus del edificio

Origen: proyectos OpenStudio **Edificio_Sin_EMS** (edificio de 5 plantas, 26 zonas acondicionadas + 5 núcleos de
elevador) y **Edificio_Sin_EMS_ConPV** (mismo edificio con 6 campos fotovoltaicos en la azotea), EnergyPlus 25.2.0,
clima Panamá-Albrook TMYx 2011–2025. Generado con:

    python tools/importar_energyplus.py --proyecto <Edificio_Sin_EMS> --proyecto-fv <Edificio_Sin_EMS_ConPaneles>

| Archivo | Contenido |
|---|---|
| `electricidad_10min.csv` | `Electricity:Facility` cada 10 min (kW), año completo (consumo, igual en ambas variantes) |
| `zonas_horario.csv` | Por zona del EMS y hora: temperatura media, HR y electricidad de equipos |
| `fv_horario.csv` | Generación DC horaria de los 6 campos FV (variante ConPV) |
| `resumen_anual.json` | Usos finales anuales, pico, FV, horas fuera de setpoint |
| `modelo_parametros.json` | Zonas (huella, envolvente por orientación, cargas, terminal), VRF, PTAC, FV y horarios extraídos del IDF/SQL/floorplan: fuente de `config/edificio.yaml` |
| `modelo/in.idf`, `modelo/in_fv.idf`, `modelo/floorplan.json` | Modelos de entrada (puente Python–EnergyPlus y trazabilidad) |
| `modelo/reporte_tabular_energyplus_fv.html` | Reporte tabular de EnergyPlus de la variante ConPV |

El modelo sólo exporta `Electricity:Facility`, temperatura/HR y equipos por zona y la FV: no hay series por
sistema VRF ni de ocupación, por eso la validación compara el total, los equipos, la FV y las temperaturas.

Calendario: año 2006 de la simulación (1 de enero = domingo); cada registro se etiqueta con el inicio del
intervalo. Los `eplusout.sql` (25–50 MB) no se incluyen; se regeneran corriendo los modelos.

Mapeo de zonas (E+ → EMS): PB: Z01 Recepción, Z02 Cubículos, Z03 Sala de conferencias, Z04 Pasillo, Z05 Baños,
Z06 Cuarto de servidores (crítica). P1–P4 (Z07–Z11, Z12–Z16, Z17–Z21, Z22–Z26): Oficina 1, Oficina 2,
Oficina abierta ("Office Grande"), Pasillo, Baños.
