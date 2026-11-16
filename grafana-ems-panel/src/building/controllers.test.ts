import { FieldType, toDataFrame } from '@grafana/data';
import {
  Command,
  applySensors,
  applyUnits,
  describe as describeCmd,
  pruneTimed,
  toPayload,
  validateCommand,
} from './control';
import {
  adjustFromForm,
  forceFromForm,
  formFromAdjust,
  formFromForce,
  needsUnitConfirm,
  unitBadge,
  unitView,
} from './controllers';
import { HVAC_BY_ID } from './model';
import { SimOptions, simulate } from './simulator';
import { SensorOverrides, UnitAdjustments, snapshotFromFrames } from './telemetry';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const MIN = 60_000;
const base: SimOptions = { limitKw: 170, demoIncidents: false };

describe('comandos de controladores', () => {
  it('valida rangos, unidad y zona, y la confirmación de lo crítico', () => {
    const unit = (adjust: object, extra: Partial<Extract<Command, { kind: 'unit' }>> = {}): Command => ({
      kind: 'unit',
      unit: 'VRF-P2',
      adjust,
      durationMin: 30,
      ...extra,
    });
    expect(validateCommand(unit({ on: false }))).toBeUndefined();
    expect(validateCommand(unit({ capPct: 120 }))).toMatch(/capacidad/);
    expect(validateCommand(unit({ setpoint: 17 }))).toMatch(/18 y 30/);
    expect(validateCommand(unit({ copFactor: 1.5 }))).toMatch(/COP/);
    expect(validateCommand(unit({}))).toMatch(/cambios/);
    expect(validateCommand(unit({ on: false }, { durationMin: 0 }))).toMatch(/Duración/);
    expect(validateCommand(unit({ on: false }, { durationMin: undefined }))).toBeUndefined();
    expect(validateCommand(unit({ on: false }, { unit: 'VRF-X' }))).toMatch(/desconocida/);
    expect(validateCommand(unit({ capPct: 50 }, { unit: 'VRF-SRV' }))).toMatch(/confirmar/);
    expect(validateCommand(unit({ capPct: 50 }, { unit: 'VRF-SRV', confirm: true }))).toBeUndefined();

    const sensor = (force: object, zone = 'Z03', confirm = false): Command => ({
      kind: 'sensor',
      zone,
      force,
      confirm,
    });
    expect(validateCommand(sensor({ tempOffset: 2 }))).toBeUndefined();
    expect(validateCommand(sensor({ tempOffset: 2, tempValue: 25 }))).toMatch(/no ambos/);
    expect(validateCommand(sensor({ tempOffset: 12 }))).toMatch(/desfase/);
    expect(validateCommand(sensor({ tempValue: 60 }))).toMatch(/fija/);
    expect(validateCommand(sensor({ rh: 120 }))).toMatch(/HR/);
    expect(validateCommand(sensor({ frozen: false }))).toMatch(/cambios/);
    expect(validateCommand(sensor({ frozen: true }, 'Z06'))).toMatch(/crítica/);
    expect(validateCommand(sensor({ frozen: true }, 'Z06', true))).toBeUndefined();
    expect(validateCommand({ kind: 'unit_release', unit: 'VRF-Q' })).toMatch(/desconocida/);
    expect(validateCommand({ kind: 'sensor_release', zone: '*' })).toBeUndefined();
  });

  it('traduce al contrato de Node-RED (tipo unidad / sensor)', () => {
    expect(
      toPayload(
        {
          kind: 'unit',
          unit: 'VRF-SRV',
          adjust: { mode: 'ventilacion', capPct: 40, setpoint: 23, copFactor: 0.7 },
          durationMin: 60,
          confirm: true,
        },
        'ana'
      )
    ).toEqual({
      tipo: 'unidad',
      unidad: 'VRF-SRV',
      usuario: 'ana',
      modo: 'ventilacion',
      capacidad_pct: 40,
      setpoint_c: 23,
      cop_factor: 0.7,
      duracion_min: 60,
      confirmar: true,
    });
    expect(toPayload({ kind: 'unit', unit: 'PTAC-P1', adjust: { on: false } })).toEqual({
      tipo: 'unidad',
      unidad: 'PTAC-P1',
      usuario: undefined,
      encendido: false,
    });
    expect(
      toPayload({
        kind: 'sensor',
        zone: 'Z03',
        force: { tempValue: 29, rh: 80, presence: false, frozen: true },
        durationMin: 15,
      })
    ).toEqual({
      tipo: 'sensor',
      zona: 'Z03',
      usuario: undefined,
      temp_c: 29,
      hr_pct: 80,
      presencia: false,
      congelado: true,
      duracion_min: 15,
    });
    expect(toPayload({ kind: 'unit_release', unit: '*' })).toEqual({
      tipo: 'unidad',
      unidad: '*',
      liberar: true,
      usuario: undefined,
    });
    expect(toPayload({ kind: 'sensor_release', zone: 'Z02' })).toEqual({
      tipo: 'sensor',
      zona: 'Z02',
      liberar: true,
      usuario: undefined,
    });
    expect(describeCmd({ kind: 'unit', unit: 'VRF-P1', adjust: { on: false } })).toBe('VRF-P1: apagada hasta liberar');
    expect(describeCmd({ kind: 'sensor', zone: 'Z02', force: { tempOffset: 2 }, durationMin: 30 })).toBe(
      'Sensor de Z02: T +2.0 °C por 30 min'
    );
  });

  it('aplica, vence (o no) y libera los ajustes locales', () => {
    const t = at(10);
    let u: UnitAdjustments = applyUnits(
      {},
      { kind: 'unit', unit: 'VRF-P1', adjust: { capPct: 50 }, durationMin: 15 },
      t
    );
    u = applyUnits(u, { kind: 'unit', unit: 'VRF-P2', adjust: { on: false } }, t);
    expect(u['VRF-P1'].until).toBe(t + 15 * MIN);
    expect(u['VRF-P2'].until).toBe(Infinity);
    expect(Object.keys(pruneTimed(u, t + 16 * MIN))).toEqual(['VRF-P2']);
    expect(applyUnits(u, { kind: 'unit_release', unit: 'VRF-P2' }, t)['VRF-P2']).toBeUndefined();
    expect(applyUnits(u, { kind: 'unit_release', unit: '*' }, t)).toEqual({});

    const frozenAt = () => ({ temp: 24.2, rh: 70, occupied: true });
    let s: SensorOverrides = applySensors(
      {},
      { kind: 'sensor', zone: 'Z02', force: { frozen: true } },
      t,
      'ana',
      frozenAt
    );
    expect(s.Z02.frozenAt).toEqual({ temp: 24.2, rh: 70, occupied: true });
    s = applySensors(s, { kind: 'sensor', zone: 'Z03', force: { tempOffset: 1 }, durationMin: 5 }, t);
    expect(s.Z03.frozenAt).toBeUndefined();
    expect(Object.keys(pruneTimed(s, t + 6 * MIN))).toEqual(['Z02']);
    expect(applySensors(s, { kind: 'sensor_release', zone: '*' }, t)).toEqual({});
  });

  it('formularios ⇄ ajustes: sólo se envía lo que difiere del automático', () => {
    expect(adjustFromForm(formFromAdjust())).toEqual({});
    expect(adjustFromForm({ ...formFromAdjust(), on: false, mode: 'frio' })).toEqual({ on: false });
    const a = { mode: 'frio' as const, capPct: 60, setpoint: 23, copFactor: 0.8 };
    expect(adjustFromForm(formFromAdjust(a))).toEqual(a);
    expect(needsUnitConfirm(HVAC_BY_ID['VRF-SRV'], { copFactor: 0.9 })).toBe(true);
    expect(needsUnitConfirm(HVAC_BY_ID['VRF-P1'], { on: false })).toBe(true);
    expect(needsUnitConfirm(HVAC_BY_ID['VRF-P1'], { capPct: 50 })).toBe(false);
    expect(forceFromForm(formFromForce(undefined))).toEqual({});
    const f = { tempValue: 28, rh: 40, presence: true };
    expect(forceFromForm(formFromForce(f))).toEqual(f);
    expect(forceFromForm({ ...formFromForce(undefined), temp: 'offset', offset: -3, frozen: true })).toEqual({
      tempOffset: -3,
      frozen: true,
    });
  });
});

describe('controladores en el simulador local', () => {
  const t0 = at(11);

  it('apagar una unidad deja sin frío ni ventilador a todas sus zonas', () => {
    const units: UnitAdjustments = { 'VRF-P2': { on: false, since: t0, until: Infinity } };
    const ref = simulate(t0 + 60 * MIN, base);
    const s = simulate(t0 + 60 * MIN, { ...base, units });
    for (const id of HVAC_BY_ID['VRF-P2'].zones) {
      expect(s.zones[id].pHvac).toBe(0);
      expect(s.zones[id].hvacOn).toBe(false);
      expect(s.zones[id].temp).toBeGreaterThan(ref.zones[id].temp);
    }
    expect(s.units!['VRF-P2']).toMatchObject({ mode: 'apagado', on: false, forced: true, pKw: 0, qKw: 0 });
    expect(s.units!['VRF-P2'].remainingMin).toBeUndefined();
    expect(unitBadge(s.units!['VRF-P2']).text).toBe('Apagada');
    expect(s.zones.Z07.pHvac).toBeCloseTo(ref.zones.Z07.pHvac);
    expect(s.meter!.pHvac).toBeLessThan(ref.meter!.pHvac);
  });

  it('el tope de capacidad, la ventilación y el factor de COP cambian potencia y frío', () => {
    const units: UnitAdjustments = {
      'VRF-P4': { capPct: 10, since: t0, until: t0 + 120 * MIN },
      'VRF-P3': { copFactor: 0.5, since: t0, until: Infinity },
      'VRF-P1': { mode: 'ventilacion', since: t0, until: Infinity },
    };
    const t = t0 + 30 * MIN;
    const ref = simulate(t, base);
    const s = simulate(t, { ...base, units });
    expect(s.units!['VRF-P4'].qKw).toBeLessThan(ref.units!['VRF-P4'].qKw);
    expect(s.units!['VRF-P4'].remainingMin).toBeCloseTo(90);
    expect(s.units!['VRF-P3'].cop).toBeCloseTo(ref.units!['VRF-P3'].cop! * 0.5, 1);
    expect(s.units!['VRF-P3'].pKw).toBeGreaterThan(ref.units!['VRF-P3'].pKw);
    expect(s.units!['VRF-P1'].qKw).toBe(0);
    expect(s.units!['VRF-P1'].pKw).toBeGreaterThan(0); // ventiladores
    // vence: vuelve al automático
    expect(simulate(t0 + 3 * 60 * MIN, { ...base, units }).units!['VRF-P4'].forced).toBe(false);
  });

  it('setpoint local de la unidad y unidades fuera del limitador', () => {
    const units: UnitAdjustments = { 'VRF-PB': { setpoint: 21, mode: 'frio', since: t0, until: Infinity } };
    const s = simulate(t0, { ...base, units });
    for (const id of ['Z01', 'Z02', 'Z03', 'Z04']) {
      expect(s.zones[id].setpoint).toBe(21);
      expect(s.zones[id].drForced).toBeFalsy();
    }
    expect(s.zones.Z07.setpoint).not.toBe(21);
  });

  it('el control reacciona al sensor forzado y la física sigue con el valor real', () => {
    const sensors: SensorOverrides = {
      Z09: { tempOffset: 3, since: t0, until: Infinity },
      Z14: { presence: false, since: t0, until: Infinity },
      Z13: { rh: 35, since: t0, until: Infinity },
    };
    const ref = simulate(t0 + 30 * MIN, base);
    const s = simulate(t0 + 30 * MIN, { ...base, sensors });
    // desfase +3: la lectura sigue al setpoint y la zona real queda ≈ 3 °C por debajo
    expect(s.zones.Z09.temp).toBeCloseTo(s.zones.Z09.tempReal! + 3, 1);
    expect(s.zones.Z09.tempReal!).toBeLessThan(ref.zones.Z09.temp - 2);
    expect(s.zones.Z09.pHvac).toBeGreaterThan(ref.zones.Z09.pHvac);
    expect(s.zones.Z09.sensorForce).toEqual({ tempOffset: 3 });
    // presencia forzada a vacía: el EMS apaga luces aunque haya gente
    expect(s.zones.Z14.occupiedReal).toBe(true);
    expect(s.zones.Z14.occupied).toBe(false);
    expect(s.zones.Z14.occupants).toBeGreaterThan(0);
    expect(s.zones.Z14.lights).toBe(0);
    // HR fija sólo cambia la lectura
    expect(s.zones.Z13.rh).toBe(35);
    expect(s.zones.Z13.rhReal).toBeGreaterThan(50);
  });

  it('un valor fijo alto dispara TEMP_ALTA y uno congelado se detecta a los 30 min', () => {
    const sensors: SensorOverrides = {
      Z12: { tempValue: 29.5, since: t0, until: Infinity },
      Z18: { frozen: true, since: t0, until: Infinity, frozenAt: { temp: 24.1, rh: 70, occupied: true } },
    };
    const early = simulate(t0 + 10 * MIN, { ...base, sensors });
    expect(early.zones.Z18.temp).toBe(24.1);
    expect(early.zones.Z18.sensorFault).toBeFalsy();
    expect(early.alarms.some((a) => a.code === 'TEMP_ALTA' && a.zone === 'Z12')).toBe(true);
    // enfría a plena capacidad: la zona real baja de su setpoint
    expect(early.zones.Z12.tempReal!).toBeLessThan(early.zones.Z12.setpoint);
    const late = simulate(t0 + 40 * MIN, { ...base, sensors });
    expect(late.zones.Z18.sensorFault).toBe(true);
    expect(late.ems!.safeMode).toContain('Z18');
    expect(late.alarms.some((a) => a.code === 'SENSOR_CONGELADO' && a.zone === 'Z18')).toBe(true);
  });

  it('avisa de los ajustes en la zona crítica', () => {
    const s = simulate(t0, {
      ...base,
      units: { 'VRF-SRV': { capPct: 50, since: t0, until: Infinity } },
      sensors: { Z06: { tempOffset: -2, since: t0, until: Infinity } },
    });
    const codes = s.alarms.filter((a) => a.code === 'AJUSTE_CRITICO').map((a) => a.zone);
    expect(codes.sort()).toEqual(['VRF-SRV', 'Z06']);
  });
});

describe('estado de controladores en vivo (InfluxDB)', () => {
  const t = Date.parse('2026-11-03T16:00:00Z');

  it('lee la measurement unidad y los campos sensor_* de la zona', () => {
    const unidad = toDataFrame({
      fields: [
        { name: '_time', type: FieldType.time, values: [t - 300_000, t] },
        { name: '_measurement', type: FieldType.string, values: ['unidad', 'unidad'] },
        { name: 'unidad', type: FieldType.string, values: ['VRF-P2', 'VRF-P2'] },
        { name: 'modo', type: FieldType.string, values: ['auto', 'apagado'] },
        { name: 'p_kw', type: FieldType.number, values: [6.1, 0] },
        { name: 'q_frio_kw', type: FieldType.number, values: [12, 0] },
        { name: 'carga_pct', type: FieldType.number, values: [20, 0] },
        { name: 'cop', type: FieldType.number, values: [2.4, null] },
        { name: 'encendido', type: FieldType.number, values: [1, 0] },
        { name: 'forzado', type: FieldType.number, values: [0, 1] },
        { name: 'restante_min', type: FieldType.number, values: [null, -1] },
        { name: 'capacidad_pct', type: FieldType.number, values: [100, 100] },
        { name: 'cop_factor', type: FieldType.number, values: [1, 1] },
        { name: 'falla', type: FieldType.number, values: [0, 0] },
      ],
    });
    const zona = toDataFrame({
      fields: [
        { name: '_time', type: FieldType.time, values: [t - 300_000, t] },
        { name: 'zona', type: FieldType.string, values: ['Z09', 'Z09'] },
        { name: 'temp_c', type: FieldType.number, values: [27.1, 26.9] },
        { name: 'temp_real_c', type: FieldType.number, values: [24.1, 23.0] },
        { name: 'hr_pct', type: FieldType.number, values: [90, 91] },
        { name: 'hr_real_pct', type: FieldType.number, values: [90, 91] },
        { name: 'ocupado', type: FieldType.number, values: [1, 0] },
        { name: 'ocupado_real', type: FieldType.number, values: [1, 1] },
        { name: 'sensor_forzado', type: FieldType.number, values: [1, 1] },
        { name: 'sensor_temp_offset_c', type: FieldType.number, values: [3, 3] },
        { name: 'sensor_presencia', type: FieldType.number, values: [null, 0] },
        { name: 'sensor_restante_min', type: FieldType.number, values: [30, 25] },
      ],
    });
    const { snapshot } = snapshotFromFrames([unidad, zona]);
    const u = snapshot.units!['VRF-P2'];
    expect(u).toMatchObject({ mode: 'apagado', on: false, forced: true, pKw: 0, capPct: 100 });
    expect(u.remainingMin).toBeUndefined(); // −1 = sin vencimiento
    expect(u.cop).toBeUndefined();
    const z = snapshot.zones.Z09;
    expect(z.temp).toBe(26.9);
    expect(z.tempReal).toBe(23.0);
    expect(z.occupied).toBe(false);
    expect(z.occupiedReal).toBe(true);
    expect(z.sensorForce).toEqual({ tempOffset: 3, presence: false });
    expect(z.sensorRemainingMin).toBe(25);
    // liberado: la fila más reciente trae sensor_forzado = 0
    const libre = toDataFrame({
      fields: [
        { name: '_time', type: FieldType.time, values: [t + 300_000] },
        { name: 'zona', type: FieldType.string, values: ['Z09'] },
        { name: 'temp_c', type: FieldType.number, values: [23.4] },
        { name: 'sensor_forzado', type: FieldType.number, values: [0] },
      ],
    });
    expect(snapshotFromFrames([zona, libre]).snapshot.zones.Z09.sensorForce).toBeUndefined();
    // la vista usa el estado del gemelo si llega
    expect(unitView(HVAC_BY_ID['VRF-P2'], snapshot).mode).toBe('apagado');
  });
});
