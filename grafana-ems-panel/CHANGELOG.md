# Changelog

## 1.4.0

Interfaz más clara en el panel 3D y en los controles de operación.

- **Límite de demanda / potencia máxima del edificio: 170 kW** (regenerado desde `config/edificio.yaml`;
  rango de Node-RED 42–561 kW). Es el valor por defecto de la opción _Límite de demanda_ y del dashboard de
  ejemplo.
- **Medidor de demanda** en el Resumen: potencia (o importación neta con FV) frente al límite con barra,
  franja de alerta desde el 85 %, marca del límite y de la demanda de 15 min, margen restante y fichas de
  respuesta a la demanda (en espera / activa · etapa), FV, red y consumo. Indicadores del encabezado con
  barra de potencia/límite, ficha de FV y estado DR.
- **Controles de operación**: deslizador + campo numérico + botones ± con el rango visible (límite 42–561 kW,
  setpoint con ocupación 20–28 °C, antes 22–26), aviso de valor fuera de rango y «actual → nuevo»;
  confirmación en línea antes de aplicar parámetros, acciones rápidas, ocupación del edificio, _Todo a
  automático_ y apagar el HVAC de una zona; aviso de envío (_Enviando…_ / aplicado / error con el motivo)
  y controles deshabilitados mientras se envía. Los parámetros se validan antes de enviarlos
  (`validateParams`). Control de zona agrupado en _Climatización_, _Iluminación y enchufes_ y _Personas_.
- **Zonas**: paso del mouse con contorno discontinuo y tinte del color primario, selección con relleno; el
  rótulo de la zona se resalta. Detalle de zona con cabecera de estado y fichas (temperatura frente al
  setpoint, potencia, ocupantes, HVAC) con tendencia.
- **Paneles pequeños**: encabezado y barra de tiempo compactos (sin velocidad ni días) en paneles bajos o
  angostos; el título de la planta ya no queda bajo la leyenda. Gráfico de demanda sin rótulos encimados.

## 1.3.1

- Visualización más legible: vista por defecto de **una planta grande** (la de la alarma más grave, si no la
  PB; nueva opción _Planta inicial_) con un **selector de plantas en corte** (Edificio, Azotea, P4…PB: peor
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
- Fotovoltaica: campos FV en la azotea (opción _Fotovoltaica en la azotea_: automático/con/sin FV; en vivo
  se detecta por `p_fv_kw`), generación y red neta en el medidor y el resumen, curva FV del día, demanda y
  limitador sobre la importación neta.
- Simulador: ocupación 8–18 h, pre-enfriamiento de 60 min, ascensor y extractores, 480 V, opción
  _Control simulado_ con la línea base de E+ (22 °C 24 h, baños 24 °C).
- Límite de demanda por defecto 75 kW (rango 19–248 kW como Node-RED); `EN_UPS` en la zona `EDIF`.
- Vista explotada legible con 5 plantas (rótulos escalados y sin encimarse), plano de zonas en 3 columnas,
  selector de unidades en la pestaña Simular.

## 1.1.0

Edificio del modelo OpenStudio/EnergyPlus del proyecto: 2 plantas, 10 zonas, 3 unidades VRF en la azotea,
interiores por tipo de zona, horarios de E+ en el modo demostración, interiores animados y control del edificio.

## 1.0.0

Versión inicial: edificio de 3 niveles y 10 zonas en 3D, seis vistas, alarmas, medidor y modo demostración.
