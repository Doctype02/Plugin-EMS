# Imagen del simulador / gemelo digital del EMS (servicio `simulador` del docker-compose de infra/)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ems/ ems/
COPY config/ config/
COPY nodered/ nodered/

# Variables del contrato (docs/CONTRATO.md §1); se sobrescriben desde docker-compose
ENV MQTT_HOST=mosquitto MQTT_PORT=1883 EMS_EDIFICIO=edificio1 EMS_CONTROL=externo \
    EMS_VELOCIDAD=300 EMS_DIAS=0 INFLUX_ORG=utp INFLUX_BUCKET=ems

# Por defecto: modo live. Otros usos:
#   docker compose run --rm simulador python -m ems todo
#   docker compose run --rm simulador python -m ems exportar
CMD ["python", "-m", "ems", "live"]
