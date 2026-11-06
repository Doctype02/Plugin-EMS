import { PanelPlugin } from '@grafana/data';
import { EmsOptions } from './types';
import { EmsPanel } from './components/EmsPanel';
import { VIEW_LABELS, ViewMode } from './building/views';

export const plugin = new PanelPlugin<EmsOptions>(EmsPanel).setPanelOptions((builder) =>
  builder
    .addRadio({
      path: 'defaultView',
      name: 'Vista inicial',
      defaultValue: 'status',
      settings: {
        options: (Object.keys(VIEW_LABELS) as ViewMode[]).map((value) => ({ value, label: VIEW_LABELS[value] })),
      },
    })
    .addRadio({
      path: 'azimuth',
      name: 'Orientación inicial',
      description: 'Rotación del edificio en la vista isométrica',
      defaultValue: 0,
      settings: {
        options: [
          { value: 0, label: 'Sur-este' },
          { value: 90, label: 'Sur-oeste' },
          { value: 180, label: 'Nor-oeste' },
          { value: 270, label: 'Nor-este' },
        ],
      },
    })
    .addBooleanSwitch({
      path: 'exploded',
      name: 'Vista explotada',
      description: 'Separa los pisos para ver las zonas de cada nivel',
      defaultValue: true,
    })
    .addNumberInput({
      path: 'limitKw',
      name: 'Límite de demanda (kW)',
      description: 'Límite del EMS para la respuesta a la demanda (si los datos no traen limite_kw)',
      defaultValue: 30,
      settings: { min: 10 },
    })
    .addBooleanSwitch({
      path: 'demoMode',
      name: 'Datos de demostración',
      description:
        'Simula el edificio en el navegador. Apagado, usa las consultas del panel (InfluxDB, docs/CONTRATO.md)',
      defaultValue: true,
    })
    .addNumberInput({
      path: 'demoSpeed',
      name: 'Velocidad de simulación',
      description: '1 = hora real de Panamá; 60 = un día cada 24 minutos',
      defaultValue: 60,
      settings: { min: 1, integer: true },
      showIf: (c) => c.demoMode,
    })
    .addNumberInput({
      path: 'refreshSeconds',
      name: 'Intervalo de simulación (s)',
      defaultValue: 2,
      settings: { min: 1, integer: true },
      showIf: (c) => c.demoMode,
    })
    .addBooleanSwitch({
      path: 'animations',
      name: 'Animaciones',
      description:
        'Personas, aire de los difusores, ventiladores, LEDs y flujo eléctrico (se apagan si el sistema pide menos movimiento)',
      defaultValue: true,
    })
    .addBooleanSwitch({
      path: 'allowControl',
      name: 'Permitir control del edificio',
      description: 'Overrides por zona y parámetros del EMS (requiere rol Editor o Admin)',
      defaultValue: true,
    })
    .addTextInput({
      path: 'controlUrl',
      name: 'URL de control (Node-RED)',
      description: 'Endpoint HTTP que publica los comandos por MQTT en modo en vivo',
      defaultValue: 'http://localhost:1880/ems/control',
      showIf: (c) => c.allowControl && !c.demoMode,
    })
    .addBooleanSwitch({ path: 'showSummary', name: 'Mostrar encabezado', defaultValue: true })
    .addBooleanSwitch({
      path: 'showSidebar',
      name: 'Mostrar panel lateral',
      description: 'Alarmas, medidor y detalle de zona (en paneles anchos)',
      defaultValue: true,
    })
);
