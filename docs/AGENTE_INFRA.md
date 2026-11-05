# Encargo para el agente de infraestructura

Copia este documento completo como instrucción para la sesión de infraestructura.

---

## Objetivo

Desplegar el EMS del Proyecto 2 en el servidor **Arch Linux** del usuario, que **ya tiene Grafana
instalado**. Todo va como servicios systemd nativos, **sin Docker**. Al terminar:
- el edificio 3D debe mostrar datos en vivo;
- debe poder controlarse desde Grafana;
- los dashboards de monitoreo y resultados deben estar cargados.

- **Repositorio:** `Doctype02/Plugin-EMS`
- **Rama:** `claude/focused-ramanujan-y99jeb`
- **Fuente de verdad:** [`docs/CONTRATO.md`](CONTRATO.md) (puertos, variables, tópicos MQTT, esquema
  InfluxDB y endpoint de control).
- **Procedimiento paso a paso con verificaciones:** [`docs/DESPLIEGUE_ARCH.md`](DESPLIEGUE_ARCH.md).
- **Plantillas listas:** [`deploy/arch/`](../deploy/arch/): config de Mosquitto, unidades systemd de
  Node-RED y del simulador, `.env` de ejemplo, datasource y proveedor de dashboards de Grafana, y el
  dashboard "EMS · Edificio 3D (en vivo)".

## Qué hay que levantar

| Componente | Cómo | Puerto |
|---|---|---|
| Mosquitto | `pacman -S mosquitto` + `deploy/arch/mosquitto-ems.conf` | 1883 (127.0.0.1) |
| InfluxDB 2.x | `pacman -S influxdb influx-cli`; `influx setup` (org `utp`, bucket `ems`, 30 d); token de escritura para el simulador y de lectura para Grafana | 8086 |
| Node-RED 4 | `npm i -g --unsafe-perm node-red` + `deploy/arch/node-red-ems.service` (carga `nodered/flows.json` del repo) | 1880 (el navegador debe llegar a `/ems/control`) |
| Simulador Python | venv en `/opt/Plugin-EMS/.venv` + `deploy/arch/ems-simulador.service` (`EMS_VELOCIDAD=1`, `EMS_INICIO=ahora`) | — |
| Plugin de Grafana `doctype02-ems-panel` | `npm ci && npm run build` en `grafana-ems-panel/`, copiar `dist/` a `/var/lib/grafana/plugins/doctype02-ems-panel`, `allow_loading_unsigned_plugins` | — |
| Grafana (ya instalado) | datasource `ems-influx` (Flux) + dashboards aprovisionados; token por `EnvironmentFile` en un override de systemd | 3000 |

## Pasos (detalle en DESPLIEGUE_ARCH.md)

0. **Comprobar versiones.** Grafana debe ser **≥ 13.2** (lo exige el plugin): si no, detente y avisa al
   agente de código. También Node ≥ 22, Python 3.12/3.13 e InfluxDB 2.x.
1. **Paquetes:** `git nodejs npm python mosquitto influxdb influx-cli`.
2. **Usuario y repositorio:** usuario de sistema `ems`, clonar la rama en `/opt/Plugin-EMS` y crear
   `/etc/ems` (750 root:ems).
3. **Python:** venv, `pip install -r requirements.txt`, `pytest -q`.
4. **Mosquitto:** configurar `conf.d/ems.conf`, habilitar el servicio y probar con `mosquitto_pub`/`mosquitto_sub`.
5. **InfluxDB:** `influx setup`, crear los 2 tokens y completar `/etc/ems/ems.env` y `/etc/ems/grafana.env`.
   Sin comentarios al final de línea: systemd los toma como parte del valor.
6. **Node-RED:** servicio y prueba del endpoint (`OPTIONS` → 204 con CORS; `POST` override → 200; zona
   Z09 → 400). Proteger el editor: `uiHost: "127.0.0.1"` si todo es local, o `adminAuth` si se accede
   desde la LAN.
7. **Simulador:** servicio, logs `[live] conectado; control=externo`, datos en Influx (`influx query …
   count()`) y repetir `pytest -q`, que ahora incluye la integración MQTT.
8. **Plugin:** compilar, `npm run test:ci`, copiar a la carpeta de plugins y configurar `grafana.ini`
   (`[plugins] allow_loading_unsigned_plugins` y `[paths] provisioning`).
9. **Aprovisionamiento:** datasource y proveedor de dashboards; `systemctl edit grafana` →
   `EnvironmentFile=/etc/ems/grafana.env`; **reiniciar Grafana**. Verificar con la API: plugin cargado y
   datasource `OK`.
10. **Escenarios offline:** `python -m ems exportar` una sola vez, para la comparación de resultados.
11. **Dashboards adicionales:** ver la siguiente sección.
12. **Prueba de aceptación:** los 6 puntos del final de DESPLIEGUE_ARCH.md (control de Z02, zona crítica
    bloqueada, deslastre, límite de demanda y reinicio de la máquina).

## Dashboards

Guárdalos como JSON en `deploy/arch/grafana/dashboards/` (el proveedor aprovisionado ya apunta ahí),
carpeta "EMS Edificio".
- Datasource: `ems-influx` (Flux).
- Variable `escenario`: `import "influxdata/influxdb/schema" schema.tagValues(bucket: "ems", tag:
  "escenario")`, por defecto `live`.
- Estilo: guíate por el BMS de Grafana (`Doctype02/Plugin-BMS`), **sin usar el plano del MMROOM**.

- **EMS · Edificio 3D (en vivo)**: ya está hecho (`ems-edificio-3d.json`). Sólo ajusta la opción *URL de
  control* si Node-RED no está en `localhost:1880` para el navegador del usuario.
- **EMS · Tiempo real**:
  - potencia total, crítica y no crítica (series);
  - demanda de 15 min frente a `limite_kw` (umbral);
  - tensión, corriente, FP, kVA y energía acumulada;
  - temperatura exterior y precio;
  - estado de cargas por zona (state timeline de `hvac_on`, `luces_nivel`, `equipos_nivel`);
  - tabla de las 10 zonas (temperatura, setpoint, ocupantes, kW);
  - DR activo y latencia (medición `ems`).
- **EMS · Zonas**: temperatura de las 10 zonas con banda de confort 21–26 °C, ocupación, lux y potencia
  por uso; panel repetido por `zona`.
- **EMS · Alarmas**:
  - tabla de `alarma` (ts, nivel, código, zona, mensaje) coloreada por nivel;
  - conteo por código;
  - pulso del sistema = `count` de `medidor` por minuto (disponibilidad).
- **EMS · Resultados**:
  - comparación de escenarios desde `kpi` (energía, ahorro %, pico evitado, ahorro USD/año, VPN, payback,
    costo del kWh evitado);
  - pronóstico (`pronostico`: `p_kw_pred` frente a `p_kw_real`);
  - perfiles de `medidor` superpuestos por escenario.
  - Rango absoluto `2026-09-28` → `2026-11-09`.
- **Rangos de tiempo:** con `EMS_VELOCIDAD=1` y `EMS_INICIO=ahora`, los dashboards en vivo usan rangos
  normales (`now-6h` → `now`). Para grabar el video con `EMS_VELOCIDAD=60`, usa `now` → `now+1d`.

## Entregables

1. Servicios `mosquitto`, `influxdb`, `node-red-ems`, `ems-simulador` y `grafana` habilitados y activos tras
   un reinicio.
2. Los 4 dashboards adicionales en `deploy/arch/grafana/dashboards/*.json`.
3. Si escribes scripts de ayuda (instalación, verificación, respaldo de Influx), van en `deploy/arch/`.
4. Un informe en `deploy/arch/INFORME.md`:
   - versiones instaladas (Grafana, InfluxDB, Mosquitto, Node-RED, Node, Python);
   - salida de cada verificación;
   - resultado de la prueba de aceptación;
   - desviaciones respecto al procedimiento (por ejemplo, de dónde salió InfluxDB 2 si no venía del
     repositorio).
5. Commit y push a la misma rama con sólo esos archivos.

## Reglas

- **No tocar** `ems/`, `nodered/`, `config/`, `tests/`, `tools/`, `grafana-ems-panel/` (incluida su carpeta
  `.config`), `Dockerfile` ni las plantillas existentes de `deploy/arch/`. Son del agente de código.
- Si necesitas cambiar un tópico, un campo, una medición, un puerto o una plantilla, avísale al agente de
  código y actualiza primero `docs/CONTRATO.md`.
- **Secretos** (tokens de Influx, claves de Grafana o de Node-RED) sólo en `/etc/ems/`, nunca en el
  repositorio.
- Cualquier cambio en el plugin o en su `plugin.json` requiere **reiniciar Grafana**.
- Docker es opcional. El `Dockerfile` del simulador sigue disponible, pero el despliegue de referencia es
  el nativo con systemd.
