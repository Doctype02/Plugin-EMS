# Changelog

## 1.7.2

Nada cambia de golpe en un corte simulado (modo demostración), igual que en el gemelo:

- Durante los 15 s de arranque de la planta sólo el UPS sostiene los servidores; después la planta toma primero
  luces y ascensor.
- **Toma de carga escalonada**: tras la transferencia (y también al volver la red) los terminales esperan su
  protección de rearranque y vuelven por turnos, 2 cada 5 min; cada zona se calienta mientras espera y recupera
  su consigna poco a poco.
- Un corte fuera de horario ya no hace saltar la temperatura de las zonas que estaban apagadas.

## 1.7.1

- La «Demanda del día» se dibuja en escalones (cada escalón es un equipo que entra o sale), como las gráficas de
  potencia de los dashboards.

## 1.7.0

Planta de respaldo: el corte de red ya no deja el edificio a oscuras.

- **La planta se ve**: en la vista de conjunto, el patio técnico junto al edificio muestra el grupo electrógeno
  (con humo en el escape cuando está en marcha), el tanque de diésel con su nivel y el tablero de transferencia.
  La tarjeta «Fuentes de energía» del resumen dibuja el flujo de red, planta y paneles hacia el edificio y el
  UPS de los servidores.
- **En vivo**: lee del medidor el modo de energía, la potencia y carga de la planta, el diésel, la autonomía y
  la solar recortada; el aviso de corte distingue «en planta de respaldo» de «sólo UPS».
- **Modo demostración**: en un corte la planta alimenta los VRF, el ascensor, la iluminación y los servidores;
  los paneles se reconectan a los 5 min y se recortan para respetar la carga mínima de la planta; reglas de
  emergencia (luces al 70 %, consigna 25 °C, pasillos sin aire). Evento nuevo «Falla de la planta de respaldo».

## 1.6.3

- **Órdenes seguras con HTTPS**: cuando Grafana se sirve por HTTPS, las órdenes de control van al mismo origen
  (`/ems/control`), donde el proxy inverso sólo las deja pasar con una sesión de Grafana válida. Con HTTP (red
  local) se sigue usando la URL configurada.

## 1.6.2

Modo demostración más realista, alineado con el gemelo digital y las reglas nuevas del EMS.

- **Aire apagado fuera de horario**: noches, sábados y domingos la temperatura de cada zona sigue al clima
  exterior (modelo RC integrado hora a hora con el clima desde el último fin de jornada, con el sol y el standby):
  sube de día y baja de noche con retraso. Antes quedaba fija en 25,5 °C. Si pasa de 32 °C arranca la
  protección por calor.
- **Pre-enfriamiento escalonado con rampa**: 2 terminales arrancan cada 5 min (las plantas altas primero) y la
  consigna baja 3 °C/h desde la temperatura de la zona; la potencia de la mañana sube en rampa, sin escalón.
- **Llegada gradual**: los horarios pasan en rampas de 60 min (`scheduleTransitionMin`) y cada zona llega
  ±25 min según el día; luces y enchufes se encienden a medida que llega la gente.
- **Radiación al cielo** sólo en los opacos (muros × 0,5, techo × 1), como el gemelo 2R2C; la capacitancia
  total incluye la masa del edificio (0,095 kWh/K·m²).

## 1.6.1

Animaciones fluidas (~60 fps) y pruebas e2e al día con Grafana 13.2.

- **Movimiento a la tasa de la pantalla**: las personas que caminan, los ventiladores de las condensadoras, el
  aire de los casetes VRF, el flujo de la montante, los LEDs, el humo y la llama de un incendio y el brillo de
  la FV ya no usan SMIL (`<animate>`), que en Chrome recalculaba los estilos de todo el SVG en cada frame
  (~100 ms por frame). Cada elemento describe su animación en `data-mo` y `components/motion.ts` la ejecuta con
  Web Animations (o con un bucle `requestAnimationFrame` compartido si no hay soporte), sin re-renderizar React.
  La fase continúa entre refrescos de la simulación (sin saltos) y la velocidad cambia suavemente cuando cambia
  la carga. Las animaciones se pausan con el botón, con `prefers-reduced-motion`, fuera de pantalla
  (IntersectionObserver) y con la pestaña oculta.
- **Reloj continuo**: con la simulación acelerada la hora y el cursor de la barra de tiempo siguen al reloj
  visual al minuto entre instantáneas (el cursor avanza de minuto en minuto, antes de 5 en 5).
- **Simulación más liviana**: la energía del día reutiliza los tramos de 15 min ya calculados y la tendencia de
  2 h avanza de punto en punto (200 s) reutilizando 36 de sus 37 instantáneas: `simulate()` pasa de ~90 ms a
  ~5 ms y la tendencia de ~115 ms a ~7 ms. La curva del día de la demostración ya no se recalcula con cada
  tendencia. La instantánea se refresca cada ~5 min simulados (1 s a 1 min/s, 500 ms a 10 min/s, 250 ms a 1 h/s)
  en una transición de React y se detiene con la pestaña oculta.
- **Medido** (Grafana 13.2.4, Playwright, 5 s por caso, fps con `requestAnimationFrame`): con Chromium con GPU
  planta 1 min/s 12 → 60 fps, planta 10 min/s 4.6 → 60, edificio 1 min/s 14 → 56, edificio 10 min/s 5.6 → 58;
  en headless (raster por software) 11 → 59, 5.0 → 58.5, 13 → 59 y 5.3 → 58.6. Scripting de 26–91 ms a
  0.4–1.7 ms por frame y estilos/layout de 43–116 ms a ~1–1.6 ms; el hilo principal deja de estar saturado
  (~100 % → 36–46 % en headless).
- **Pruebas e2e** (`tests/panel.spec.ts`) pasan contra Grafana 13.2.4: viewport de 1920×1440 (con 1280×720 el
  editor deja el panel en ~600×300 px y el panel oculta el selector de plantas y la leyenda completa), raíz del
  panel por `data-testid="ems-panel"`, espera de la primera carga del plugin, pestaña «Control» con coincidencia
  exacta (chocaba con «Controladores»), clic en la ficha de la zona (queda encima de la planta) y la montante se
  comprueba por su rótulo (es una línea vertical de ancho 0). `@grafana/plugin-e2e` 3.15.4.

## 1.6.0

Escena 3D y sistema visual con acabado de producto (gemelo digital / BMS).

- **Luz y materiales**: una sola luz direccional para toda la escena (cara superior plena, frontal en media luz,
  lateral en sombra) y paleta neutra y desaturada en los dos temas (`building/materials.ts`). Losas con canto
  y filo claro, muros con grosor y remate, ventanas con vidrio que refleja el cielo (cálido de noche con las
  luces encendidas), carpintería y muro cortina translúcido sobre el antepecho de las fachadas delanteras.
  Sombra ambiental al pie de los muros y sombras de contacto bajo muebles, equipos y unidades de la azotea.
- **Pisos con su acabado** por tipo de zona (alfombra modular, madera, piedra, porcelanato y piso técnico),
  dibujados en el plano con patrones compartidos.
- **Estado y capas sin tapar los materiales**: en _Estado_ una zona normal queda limpia; alerta y crítico
  llevan tinte translúcido, contorno grueso y rayado diagonal (no sólo color); sin datos, rayado gris. Las
  capas de datos (temperatura, ocupación, potencia, iluminación, HVAC) son un tinte translúcido con contorno.
  En la vista de volumen cada zona lleva una franja con el color de la capa al pie de la fachada.
- **Mobiliario y equipos a escala** con un mismo lenguaje: puestos con escritorio, pedestal, monitor (encendido
  si hay gente) y silla orientada; mesa de juntas con sillas alrededor; recepción con mostrador y sofás;
  racks con puerta, unidades y LEDs; baños con mamparas, inodoros y lavamanos; plantas; núcleo del ascensor
  con puertas hacia el pasillo; casetes VRF de 4 vías con LED de estado y flujo de aire; personas sentadas o
  de pie con proporciones reales.
- **Azotea**: membrana con juntas y sombra en el parapeto, módulos FV con celdas y brillo según la
  generación, condensadoras VRF con serpentín de lamas, bancada metálica, ventiladores con rejilla y tuberías.
- **Fichas de zona** compactas (marca de estado + código + nombre + valor de la capa, «M» si está en manual)
  con **anti-solape 2D** (`placeLabels`: prueba desplazamientos alrededor del ancla, prioriza la zona
  seleccionada y las alarmas, respeta los márgenes de la escena y esquiva los marcadores de eventos) y línea
  guía al ancla; se pueden pulsar y pasar el mouse como la zona. El detalle queda en la ventana emergente.
  En escalas diminutas se omiten las fichas.
- **Accesibilidad**: la marca de estado tiene forma propia (círculo normal, triángulo alerta, rombo crítico,
  anillo sin datos) en las fichas y en la leyenda.
- **Sistema visual común**: pestañas del panel lateral compactas (ya no se corta «Controladores»), periodo
  del día fuera de la regla de la barra de tiempo (ya no se encima con «24»), insignia de alarmas del botón
  _Edificio_ que no empuja la ocupación, radios del tema en el selector de plantas, rótulos de la vista de
  conjunto y de la azotea con el mismo estilo de ficha.
- **Paneles pequeños**: cabecera en una sola fila con la capa en un desplegable, barra de herramientas
  reducida, título corto de la planta y la escena aprovecha más alto.

## 1.5.0

Simulación y modificación de los **controladores** del edificio, en vivo (gemelo vía Node-RED) y en el modo
simulado local.

- **Pestaña «Controladores»**: las 11 unidades (6 VRF + 5 PTAC) con su estado real — potencia, carga %, COP
  real, modo, zonas servidas (con su temperatura) — y un editor por unidad: encender/apagar, modo (_Auto_
  obedece al EMS, _Frío local_ con termostato propio que ignora el deslastre, _Ventilación_ sin compresor),
  **capacidad máxima** 0–100 %, **setpoint propio** de sus zonas (18–30 °C) y **factor de COP** 0.5–1.2
  (degradación). Duración 15 min / 1 h / 4 h o _sin límite_ (hasta liberar), _Automático_ por unidad,
  _Liberar todo_ y botón _Falla_ que reutiliza el evento `falla_vrf`. Se confirma en línea al apagar una
  unidad y siempre en **VRF-SRV** (zona crítica Z06), que se envía con `confirmar: true`.
- **Datos del sensor** en el detalle de cada zona (también en Z06, con confirmación): tabla _lee el
  controlador_ frente a _real_ (temperatura, HR, presencia) y forzado de la lectura: desfase (−10…10 °C) o
  valor fijo (5–50 °C), HR fija, presencia ocupada/vacía y sensor congelado. El EMS y el termostato reaccionan
  al dato forzado; la física sigue con el valor real.
- **Simulador local**: las unidades ajustadas cambian la física (libre flotación sin frío, tope de capacidad,
  COP), quedan fuera del limitador de demanda en control local y se informan en `snapshot.units`; los
  sensores forzados mueven la regulación (con +x °C la zona real queda x °C bajo el setpoint), disparan
  `TEMP_ALTA`, `SENSOR_CONGELADO` (a los 30 min → modo seguro) y `AJUSTE_CRITICO`.
- **En vivo**: lee la measurement `unidad` y los campos de zona `temp_real_c`, `hr_pct`, `hr_real_pct`,
  `ocupado_real`, `sensor_*` (docs/CONTRATO.md). El dashboard de ejemplo agrega la consulta E (`unidad`).
- **Selector de plantas con ocupación**: cada planta muestra personas / aforo con una barrita de % en el borde
  inferior; el botón _Edificio_ muestra el total y su tooltip el porcentaje.
- Azotea: estado _Apagada (manual)_ y, en la ventana de la unidad, COP real y ajuste manual vigente.
- `modelData.ts` incluye `critical` por unidad y `CONTROLLER_LIMITS` (rangos de `ems/controladores.py`).

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
