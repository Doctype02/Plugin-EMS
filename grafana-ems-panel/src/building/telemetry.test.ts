import { FieldType, toDataFrame } from '@grafana/data';
import { activeAlarms, snapshotFromFrames, zoneStatus } from './telemetry';
import { ZONE_BY_ID } from './model';

const t0 = Date.parse('2026-11-03T15:00:00Z');

describe('lectura de data frames (contrato InfluxDB)', () => {
  it('lee formato ancho (pivot) de la medición zona', () => {
    const frame = toDataFrame({
      fields: [
        { name: '_time', type: FieldType.time, values: [t0 - 300000, t0] },
        { name: 'zona', type: FieldType.string, values: ['Z02', 'Z02'] },
        { name: 'temp_c', type: FieldType.number, values: [24.1, 24.6] },
        { name: 'ocupantes', type: FieldType.number, values: [20, 22] },
        { name: 'hvac_on', type: FieldType.number, values: [0, 1] },
        { name: 'p_total_kw', type: FieldType.number, values: [9.5, 11.2] },
      ],
    });
    const { snapshot, history } = snapshotFromFrames([frame]);
    expect(snapshot.zones.Z02.temp).toBe(24.6);
    expect(snapshot.zones.Z02.occupants).toBe(22);
    expect(snapshot.zones.Z02.occupied).toBe(false); // el campo ocupado no vino
    expect(snapshot.zones.Z02.hvacOn).toBe(true);
    expect(history.Z02.temp).toHaveLength(2);
  });

  it('lee formato largo con etiquetas _field / _measurement', () => {
    const frames = [
      toDataFrame({
        fields: [
          { name: 'Time', type: FieldType.time, values: [t0] },
          {
            name: '_value',
            type: FieldType.number,
            values: [152.3],
            labels: { _field: 'p_total_kw', _measurement: 'medidor' },
          },
        ],
      }),
      toDataFrame({
        fields: [
          { name: 'Time', type: FieldType.time, values: [t0] },
          {
            name: '_value',
            type: FieldType.number,
            values: [148],
            labels: { _field: 'demanda_15min_kw', _measurement: 'medidor' },
          },
        ],
      }),
      toDataFrame({
        fields: [
          { name: 'Time', type: FieldType.time, values: [t0] },
          { name: 'temp_c', type: FieldType.number, values: [27.4], labels: { zona: 'Z06', _measurement: 'zona' } },
        ],
      }),
    ];
    const { snapshot } = snapshotFromFrames(frames);
    expect(snapshot.meter?.pTotal).toBe(152.3);
    expect(snapshot.meter?.demand15).toBe(148);
    expect(snapshot.zones.Z06.temp).toBe(27.4);
  });

  it('lee alarmas y las deduplica por zona y código', () => {
    const frame = toDataFrame({
      fields: [
        { name: '_time', type: FieldType.time, values: [t0 - 600000, t0] },
        { name: 'codigo', type: FieldType.string, values: ['TEMP_ALTA', 'TEMP_ALTA'] },
        { name: 'nivel', type: FieldType.string, values: ['warn', 'warn'] },
        { name: 'zona', type: FieldType.string, values: ['Z04', 'Z04'] },
        { name: 'mensaje', type: FieldType.string, values: ['a', 'b'] },
      ],
    });
    const { snapshot } = snapshotFromFrames([frame]);
    expect(snapshot.alarms).toHaveLength(1);
    expect(snapshot.alarms[0].message).toBe('b');
    expect(activeAlarms(snapshot.alarms, t0 + 2 * 3600000)).toHaveLength(0);
  });

  it('clasifica el estado de la zona', () => {
    const base = {
      temp: 24,
      setpoint: 24,
      occupants: 10,
      occupied: true,
      lux: 500,
      lights: 1,
      plugs: 1,
      hvacOn: true,
      hvacEnable: true,
      pLights: 1,
      pPlugs: 1,
      pHvac: 1,
      pTotal: 3,
      updatedAt: t0,
    };
    expect(zoneStatus(ZONE_BY_ID.Z02, base, [])).toBe('ok');
    expect(zoneStatus(ZONE_BY_ID.Z02, { ...base, temp: 26.5 }, [])).toBe('warning');
    expect(zoneStatus(ZONE_BY_ID.Z02, { ...base, sensorFault: true }, [])).toBe('critical');
    expect(zoneStatus(ZONE_BY_ID.Z09, { ...base, temp: 28 }, [])).toBe('critical');
    expect(zoneStatus(ZONE_BY_ID.Z02, undefined, [])).toBe('offline');
  });
});
