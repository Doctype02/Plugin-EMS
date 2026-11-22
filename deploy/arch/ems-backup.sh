#!/usr/bin/env bash
# Copia de seguridad del EMS: InfluxDB (histórico), Grafana (usuarios y ediciones), Node-RED y /etc/ems.
# Lo lanza ems-backup.timer cada noche. Conserva EMS_BACKUP_DIAS días (7 por defecto) en EMS_BACKUP_DIR.
# Restaurar: ver deploy/seguridad/README.md.
set -euo pipefail

DIR="${EMS_BACKUP_DIR:-/var/backups/ems}"
DIAS="${EMS_BACKUP_DIAS:-7}"
DEST="$DIR/$(date +%F_%H%M)"
umask 077
mkdir -p "$DEST"
trap 'rm -rf "$DEST"' EXIT
export HOME="${HOME:-/root}"

# InfluxDB: copia en caliente. Necesita un token de operador: INFLUX_TOKEN_BACKUP en /etc/ems/backup.env
# o, si no existe, la configuración del cliente `influx` del usuario root (la deja `influx setup`).
if command -v influx >/dev/null; then
    if [ -n "${INFLUX_TOKEN_BACKUP:-}" ]; then
        influx backup "$DEST/influx" --host "${INFLUX_URL:-http://127.0.0.1:8086}" --token "$INFLUX_TOKEN_BACKUP" >/dev/null
    else
        # sin las variables del simulador (su token sólo escribe): usa la configuración del cliente de root
        env -u INFLUX_TOKEN -u INFLUX_URL -u INFLUX_ORG -u INFLUX_BUCKET influx backup "$DEST/influx" >/dev/null
    fi
fi

# Grafana: base SQLite (copia consistente) si existe
DB=/var/lib/grafana/grafana.db
if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
    sqlite3 "$DB" ".backup '$DEST/grafana.db'"
fi

# Configuración y secretos, flujo de Node-RED y estado del gemelo
tar -czf "$DEST/config.tar.gz" --ignore-failed-read -C / \
    etc/ems etc/grafana/grafana.ini var/lib/node-red-ems/settings.js \
    opt/Plugin-EMS/nodered/flows.json var/lib/ems 2>/dev/null || true

tar -czf "$DEST.tar.gz" -C "$DIR" "$(basename "$DEST")"
find "$DIR" -maxdepth 1 -name '*.tar.gz' -mtime "+$DIAS" -delete
echo "[ems-backup] $(du -h "$DEST.tar.gz" | cut -f1) en $DEST.tar.gz; copias guardadas: $(ls "$DIR"/*.tar.gz | wc -l)"
