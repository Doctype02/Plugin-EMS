# Changelog

## 1.3.1

- Visualización más legible: vista por defecto de **una planta grande** (la de la alarma más grave, si no la
  PB; nueva opción *Planta inicial*) con un **selector de plantas en corte** (Edificio, Azotea, P4…PB: peor
  estado, °C media, kW y alarmas); **azotea** a tamaño completo con kW de cada VRF y generación de cada campo
  FV; **vista de conjunto** como volumen apilado con las plantas separadas en franjas coloreadas y una
  tarjeta por planta (reemplaza las 5 plantas diminutas en diagonal). Encuadre calculado con el tamaño real
  del área (nada recortado), rótulos de zona más grandes con nombre corto y sin encimarse, más contraste en
  losas, muros y estado de las zonas (oscuro y claro), mobiliario atenuado a escala pequeña, leyenda y
  brújula compactas que no tapan la planta.

## 1.3.0

Edificio nuevo de **5 plantas** (PB, P1–P4, 20 × 20 m, 2000 m²) y **26 zonas** (Z01–Z26) del modelo
OpenStudio/EnergyPlus; Z06 (cuarto de servidores) es la única zona crítica.

- Datos del edificio generados desde `config/edificio.yaml` con `tools/generar_modelo_panel.py`
  (`src/building/modelData.ts`): zonas con varias partes (sala de conferencias en L), núcleo del elevador en
  cada planta, nuevos tipos `bano` y `oficina_abierta` con su interior, envolvente nueva, horarios de E+,
  cargas fijas, tarifa y reglas del EMS. `thermal()` replica `ems/config.py::zonas` (losas entre plantas
  `ua_arriba`/`ua_abajo`, `factor_cop`) y una prueba lo compara con Python.
- Climatización: 6 unidades VRF en una franja de la azotea y 5 PTAC de pared en los baños (dibujados en la
  fachada y en el interior); el evento `falla_vrf` acepta cualquier sistema (VRF o PTAC).
- Fotovoltaica: campos FV en la azotea (opción *Fotovoltaica en la azotea*: automático/con/sin FV; en vivo
  se detecta por `p_fv_kw`), generación y red neta en el medidor y el resumen, curva FV del día, demanda y
  limitador sobre la importación neta.
- Simulador: ocupación 8–18 h, pre-enfriamiento de 60 min, ascensor y extractores, 480 V, opción
  *Control simulado* con la línea base de E+ (22 °C 24 h, baños 24 °C).
- Límite de demanda por defecto 75 kW (rango 19–248 kW como Node-RED); `EN_UPS` en la zona `EDIF`.
- Vista explotada legible con 5 plantas (rótulos escalados y sin encimarse), plano de zonas en 3 columnas,
  selector de unidades en la pestaña Simular.

## 1.1.0

Edificio del modelo OpenStudio/EnergyPlus del proyecto: 2 plantas, 10 zonas, 3 unidades VRF en la azotea,
interiores por tipo de zona, horarios de E+ en el modo demostración, interiores animados y control del edificio.

## 1.0.0

Versión inicial: edificio de 3 niveles y 10 zonas en 3D, seis vistas, alarmas, medidor y modo demostración.
