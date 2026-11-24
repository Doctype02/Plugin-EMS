# Seguridad y operación del servidor

Lo que protege un despliegue público del EMS y cómo instalarlo. Los secretos viven sólo en `/etc/ems/` y
`/etc/caddy/`, nunca en el repositorio.

## HTTPS y control protegido (`Caddyfile`)

Caddy publica Grafana por HTTPS (certificado de Let's Encrypt automático) y deja pasar las órdenes de control
sólo si quien las envía tiene una sesión de Grafana válida.

```bash
sudo apt install caddy                                  # Arch: pacman -S caddy
echo "EMS_DOMINIO=ems.miempresa.com" | sudo tee /etc/caddy/ems.env   # sin dominio: <IP-con-guiones>.sslip.io
sudo cp deploy/seguridad/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/caddy/ems.env\n' | sudo tee /etc/systemd/system/caddy.service.d/ems.conf
sudo systemctl daemon-reload && sudo systemctl enable --now caddy
```

En `/etc/grafana/grafana.ini`: `[server] domain`, `root_url = https://<dominio>/`, `http_addr = 127.0.0.1` y
`[security] cookie_secure = true`. En el cortafuegos, abrir 80 y 443 y cerrar 3000 y 1880. El panel (≥ 1.6.3)
detecta HTTPS y envía las órdenes a `https://<dominio>/ems/control`.

El editor de Node-RED deja de estar publicado: `ssh -L 1880:127.0.0.1:1880 usuario@servidor` y abrir
`http://localhost:1880`.

## Auditoría

Cada orden que llega a `POST /ems/control` (aceptada o rechazada) queda en la medida `auditoria` de InfluxDB con
usuario, tipo, objetivo, resultado y detalle. Se consulta en el dashboard **Alarmas → Auditoría**.

## Copias de seguridad

```bash
sudo cp deploy/arch/ems-backup.service deploy/arch/ems-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ems-backup.timer
sudo systemctl start ems-backup.service        # primera copia
```

Cada noche (03:30) guarda en `/var/backups/ems/` InfluxDB, la base de Grafana, el flujo de Node-RED y
`/etc/ems`; conserva 7 días (`EMS_BACKUP_DIAS`). InfluxDB necesita un token de operador: la configuración del
cliente `influx` de root, `/etc/ems/influx-configs` o `INFLUX_TOKEN_BACKUP` en `/etc/ems/backup.env`.

Restaurar: descomprimir la copia, `influx restore <dir>/influx --full`, copiar `grafana.db` a
`/var/lib/grafana/` con el servicio detenido y extraer `config.tar.gz` en `/`.

## Alertas

```bash
sudo cp deploy/arch/grafana/alertas-ems.yaml /etc/grafana/provisioning/alerting/ && sudo systemctl restart grafana
```

Cuatro reglas: cuarto de servidores caliente, demanda sobre el límite, zona por encima de 32 °C y EMS sin datos.
Para recibirlas por correo o Telegram, configurar el punto de contacto en Grafana → Alerting → Contact points.

## Pendiente del operador

- Cambiar la contraseña de root del servidor y entrar con claves SSH.
- Con dominio propio, cambiar `EMS_DOMINIO` y `root_url`.
