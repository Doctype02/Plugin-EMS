# Despliegue en Arch Linux (servicios nativos con systemd)

Destino: una máquina Arch Linux con **Grafana ya instalado** (paquete `grafana`). Todo corre como
servicios systemd, sin Docker. Plantillas en [`deploy/arch/`](../deploy/arch/). Contrato de interfaces:
[`CONTRATO.md`](CONTRATO.md).

```
navegador ──3000──► Grafana ──Flux──► InfluxDB 2 :8086 ◄── simulador (ems-simulador.service)
   │   panel doctype02-ems-panel                                   │  ▲
   └──1880 POST /ems/control──► Node-RED (node-red-ems.service) ◄──┴──┘ MQTT :1883 (mosquitto)
```

| Servicio | Unidad systemd | Puerto | Escucha |
|---|---|---|---|
| Mosquitto | `mosquitto.service` | 1883 | 127.0.0.1 |
| InfluxDB 2 | `influxdb.service` | 8086 | 127.0.0.1 (recomendado) |
| Node-RED (reglas EMS + endpoint de control) | `node-red-ems.service` | 1880 | ver paso 6 |
| Simulador / gemelo digital | `ems-simulador.service` | — | — |
| Grafana (ya instalado) | `grafana.service` | 3000 | según `grafana.ini` |

Convenciones: repositorio en `/opt/Plugin-EMS`, usuario de servicio `ems`, secretos en `/etc/ems/`.

---

## 0. Comprobaciones previas

```bash
pacman -Q grafana nodejs python
```

- **Grafana ≥ 13.2**: el plugin declara `grafanaDependency >=13.2.0`. Si la versión instalada es menor,
  **detente y avísale al agente de código**: hay que ajustar la dependencia y volver a probar el panel.
- **Node.js ≥ 22**, para compilar el plugin y para Node-RED 4.
- **Python 3.12 o 3.13.** Si es 3.14 y `pip` no encuentra ruedas para `statsmodels` o `scipy`, usa el
  paso 3b.

## 1. Paquetes

```bash
sudo pacman -Syu --needed git nodejs npm python mosquitto influxdb influx-cli
```

```bash
influxd version
```

Debe ser **InfluxDB 2.x**. Si el repositorio entrega 1.x o 3.x, instala 2.7 desde el binario oficial de
InfluxData (o el paquete AUR equivalente) y documenta cuál usaste. El esquema y las consultas son Flux de
InfluxDB 2.

## 2. Usuario de servicio y repositorio

```bash
sudo useradd --system --create-home --home-dir /var/lib/ems --shell /usr/bin/nologin ems
```

```bash
sudo git clone -b claude/focused-ramanujan-y99jeb https://github.com/Doctype02/Plugin-EMS /opt/Plugin-EMS
```

```bash
sudo chown -R ems:ems /opt/Plugin-EMS
```

```bash
sudo install -d -m 750 -o root -g ems /etc/ems
```

## 3. Entorno Python del simulador

```bash
sudo -u ems python -m venv /opt/Plugin-EMS/.venv
```

```bash
sudo -u ems /opt/Plugin-EMS/.venv/bin/pip install -r /opt/Plugin-EMS/requirements.txt
```

```bash
cd /opt/Plugin-EMS && sudo -u ems .venv/bin/python -m pytest -q
```

Las pruebas que exigen `mosquitto` y `node` se saltan si todavía no están instalados. Vuelve a correrlas al
final del paso 7: deben pasar todas.

**3b.** Sólo si el paso anterior falla por la versión de Python. Instala `uv` y crea el entorno con 3.12:

```bash
sudo pacman -S --needed uv
```

```bash
sudo -u ems uv venv --python 3.12 /opt/Plugin-EMS/.venv
```

```bash
sudo -u ems uv pip install --python /opt/Plugin-EMS/.venv/bin/python -r /opt/Plugin-EMS/requirements.txt
```

## 4. Mosquitto

`/etc/mosquitto/mosquitto.conf` debe contener la línea `include_dir /etc/mosquitto/conf.d`. Agrégala si
no existe.

```bash
sudo install -d /etc/mosquitto/conf.d
```

```bash
sudo install -m 644 /opt/Plugin-EMS/deploy/arch/mosquitto-ems.conf /etc/mosquitto/conf.d/ems.conf
```

```bash
sudo systemctl enable --now mosquitto
```

Verificación: en una terminal deja escuchando el broker; en otra, publica un mensaje. Debe aparecer
`ems/prueba {"ok":1}`.

```bash
mosquitto_sub -h 127.0.0.1 -t 'ems/#' -v
```

```bash
mosquitto_pub -h 127.0.0.1 -t ems/prueba -m '{"ok":1}'
```

## 5. InfluxDB 2: organización, bucket y tokens

```bash
sudo systemctl enable --now influxdb
```

Elige una contraseña propia para el administrador:

```bash
influx setup --org utp --bucket ems --username admin --password 'CAMBIAR-ESTA-CLAVE' --retention 30d --force
```

```bash
influx bucket list --org utp --name ems
```

Con el `ID` del bucket que muestra el comando anterior, crea dos tokens:

```bash
influx auth create --org utp --read-bucket <ID> --write-bucket <ID> --description "ems-simulador"
```

```bash
influx auth create --org utp --read-bucket <ID> --description "grafana-ems"
```

Copia las plantillas a `/etc/ems` y pega los tokens en lugar de `REEMPLAZAR_…`:

```bash
sudo install -m 640 -o root -g ems /opt/Plugin-EMS/deploy/arch/ems.env.example /etc/ems/ems.env
```

```bash
sudo install -m 640 -o root -g grafana /opt/Plugin-EMS/deploy/arch/grafana.env.example /etc/ems/grafana.env
```

```bash
sudoedit /etc/ems/ems.env /etc/ems/grafana.env
```

- `ems.env` → `INFLUX_TOKEN` = token de **escritura** (`ems-simulador`).
- `grafana.env` → `INFLUX_TOKEN_GRAFANA` = token de **lectura** (`grafana-ems`).
- **No** pongas comentarios al final de una línea: systemd los toma como parte del valor.

## 6. Node-RED (reglas del EMS y endpoint de control)

Instalación global recomendada por Node-RED:

```bash
sudo npm install -g --unsafe-perm node-red
```

```bash
sudo install -d -o ems -g ems /var/lib/node-red-ems
```

```bash
sudo install -m 644 /opt/Plugin-EMS/deploy/arch/node-red-ems.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now node-red-ems
```

Verifica que `journalctl -u node-red-ems` muestre `Connected to broker` y el flujo "EMS Edificio
(Proyecto 2)". Después prueba el endpoint de control. El preflight CORS debe responder 204 con
`Access-Control-Allow-Origin: *`:

```bash
curl -i -X OPTIONS http://127.0.0.1:1880/ems/control
```

Un override válido debe responder 200 con `"ok": true`:

```bash
curl -s -X POST http://127.0.0.1:1880/ems/control -H 'Content-Type: application/json' -d '{"tipo":"override","zona":"Z02","hvac_enable":false,"duracion_min":5}'
```

Una zona crítica debe responder 400:

```bash
curl -s -X POST http://127.0.0.1:1880/ems/control -H 'Content-Type: application/json' -d '{"tipo":"override","zona":"Z09","hvac_enable":false}'
```

**Seguridad del editor de Node-RED.** El navegador de quien usa el panel debe poder llegar a
`/ems/control`.

- Si el dashboard sólo se usa en esta misma máquina: en `/var/lib/node-red-ems/settings.js` (se crea en el
  primer arranque) pon `uiHost: "127.0.0.1"` y reinicia.
- Si se abre desde otros equipos de la red: deja Node-RED escuchando en la LAN, **protege el editor** con
  `adminAuth` en `settings.js` (el endpoint `/ems/control` sigue abierto) y abre el puerto 1880 en el
  firewall si lo hay. En la opción *URL de control* del panel usa `http://<ip-del-servidor>:1880/ems/control`.

## 7. Simulador (gemelo digital en vivo)

```bash
sudo install -m 644 /opt/Plugin-EMS/deploy/arch/ems-simulador.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ems-simulador
```

Verificación:

- `journalctl -u ems-simulador -f` muestra `[live] conectado; control=externo …` y `pronóstico publicado`.
- `mosquitto_sub -h 127.0.0.1 -t 'ems/edificio1/#' -v` muestra telemetría, comandos y `ems/estado`.
- Este conteo debe ser mayor que 0 y crecer cada 5 min (con `EMS_VELOCIDAD=1`):

```bash
influx query --org utp 'from(bucket:"ems") |> range(start:-15m) |> filter(fn:(r)=>r._measurement=="medidor" and r._field=="p_total_kw") |> count()'
```

Repite las pruebas Python, que ahora deben pasar todas, incluida la integración MQTT:

```bash
cd /opt/Plugin-EMS && sudo -u ems .venv/bin/python -m pytest -q
```

**Grabación del video:** pon `EMS_VELOCIDAD=60` en `/etc/ems/ems.env` y reinicia `ems-simulador`. Así un
día dura 24 min. En el dashboard usa el rango `now` → `now+1d`. Al terminar, vuelve a `1`.

## 8. Plugin de Grafana `doctype02-ems-panel`

Compila con el webpack de `.config` (no modificar esa carpeta):

```bash
cd /opt/Plugin-EMS/grafana-ems-panel && sudo -u ems npm ci && sudo -u ems npm run build
```

```bash
sudo -u ems npm run test:ci
```

Las pruebas unitarias deben pasar todas. Confirma las rutas de Grafana:

```bash
grep -nE '^\s*(data|plugins|provisioning)\s*=' /etc/grafana.ini
```

Si no hay valores explícitos, en Arch los datos están en `/var/lib/grafana` y los plugins en
`/var/lib/grafana/plugins`. Instala el plugin:

```bash
sudo install -d -o grafana -g grafana /var/lib/grafana/plugins/doctype02-ems-panel
```

```bash
sudo cp -r /opt/Plugin-EMS/grafana-ems-panel/dist/. /var/lib/grafana/plugins/doctype02-ems-panel/
```

```bash
sudo chown -R grafana:grafana /var/lib/grafana/plugins/doctype02-ems-panel
```

En `/etc/grafana.ini`:

```ini
[paths]
provisioning = /etc/grafana/provisioning

[plugins]
allow_loading_unsigned_plugins = doctype02-ems-panel
```

Si ya había una ruta de `provisioning` configurada, consérvala y usa esa misma ruta en el paso 9.

## 9. Datasource, dashboards y token para Grafana

```bash
sudo install -d /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards
```

```bash
sudo install -m 640 -o root -g grafana /opt/Plugin-EMS/deploy/arch/grafana/datasource-ems-influx.yaml /etc/grafana/provisioning/datasources/ems-influx.yaml
```

```bash
sudo install -m 644 /opt/Plugin-EMS/deploy/arch/grafana/dashboards-ems.yaml /etc/grafana/provisioning/dashboards/ems.yaml
```

Grafana debe leer el token desde el entorno. Abre el override del servicio:

```bash
sudo systemctl edit grafana
```

y agrega:

```ini
[Service]
EnvironmentFile=/etc/ems/grafana.env
```

```bash
sudo systemctl restart grafana
```

Cada cambio en el plugin o en su `plugin.json` exige reiniciar Grafana.

Verificación (con tu usuario administrador de Grafana):

```bash
journalctl -u grafana -b | grep -iE 'doctype02-ems-panel|ems-influx|provision'
```

El plugin debe responder con JSON y `"type":"panel"`:

```bash
curl -s -u admin:<clave> http://127.0.0.1:3000/api/plugins/doctype02-ems-panel/settings
```

El datasource debe responder `"status":"OK"`:

```bash
curl -s -u admin:<clave> http://127.0.0.1:3000/api/datasources/uid/ems-influx/health
```

Abre **Dashboards → EMS Edificio → "EMS · Edificio 3D (en vivo)"**. Debe verse el edificio con datos reales
(sin la etiqueta *Simulado*), personas moviéndose, alarmas cuando ocurran y el medidor con valores.

## 10. Escenarios offline para la comparación de resultados

Una sola vez (tarda ~1 min). Escribe los escenarios `baseline`, `reglas`, `reglas_dr` y `mpc`, los KPIs y el
pronóstico, con fechas del 28 sep al 9 nov de 2026:

```bash
sudo -u ems bash -c 'set -a; . /etc/ems/ems.env; cd /opt/Plugin-EMS && .venv/bin/python -m ems exportar'
```

## 11. Dashboards adicionales (los construye infraestructura)

Guárdalos como JSON en `deploy/arch/grafana/dashboards/`, que el aprovisionamiento ya carga. Lo que debe
contener cada uno está en [`AGENTE_INFRA.md`](AGENTE_INFRA.md#dashboards): Tiempo real, Zonas, Alarmas y
Resultados. Todos usan el datasource `ems-influx` y la variable `escenario`.

## 12. Prueba de aceptación (demo)

1. En el panel 3D, haz clic en **Z02 → Control → HVAC: Apagar → Aplicar**. Debe aparecer la insignia **M**
   sobre Z02. `mosquitto_sub -t 'ems/edificio1/ems/override'` muestra el comando y, en el siguiente paso,
   los `cmd` de Z02 llegan con `"hvac_enable": false`.
2. **Volver a automático**: la insignia desaparece.
3. Haz clic en **Z09**: aparece "Carga crítica", sin controles.
4. En la pestaña **Control**: *Deslastre manual*. Las 8 zonas pasan a manual y el registro muestra los
   comandos como enviados.
5. Cambia el **límite de demanda** a 135 kW: `ems/estado` informa `limite_kw: 135`.
6. Reinicia la máquina: los 4 servicios vuelven solos y el panel sigue mostrando datos.

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| El panel no aparece en la lista de visualizaciones | Plugin sin firmar o Grafana < 13.2 | `allow_loading_unsigned_plugins`, reiniciar; revisar `journalctl -u grafana` |
| Panel con todas las zonas "Sin datos" | Consultas sin datos o rango de tiempo fuera | Revisar el paso 7 (`influx query`); rango `now-6h → now` con `EMS_VELOCIDAD=1` |
| "Failed to fetch" al aplicar un control | El navegador no llega a Node-RED | URL de control con la IP correcta, puerto 1880 accesible (paso 6) |
| "Se requiere rol Editor o Admin" | Usuario Viewer | Dar rol Editor al usuario de la demo |
| El simulador reinicia en bucle | Token o URL de Influx incorrectos | `journalctl -u ems-simulador`; revisar `/etc/ems/ems.env` |
| `${MQTT_HOST}` sin resolver en Node-RED | Variables no cargadas | `EnvironmentFile=/etc/ems/ems.env` en `node-red-ems.service` |
