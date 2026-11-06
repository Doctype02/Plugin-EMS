import { applyLocal, describe as describeCmd, prune, toPayload, validate } from './control';
import { simulate } from './simulator';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);

describe('comandos del operador', () => {
  it('valida rangos y zonas críticas', () => {
    expect(validate({ zone: 'Z02', setpoint: 23, durationMin: 60 })).toBeUndefined();
    expect(validate({ zone: 'Z09', hvac: 'off', durationMin: 60 })).toMatch(/crítica/);
    expect(validate({ zone: 'Z02', setpoint: 31, durationMin: 60 })).toMatch(/20 y 28/);
    expect(validate({ zone: 'Z02', durationMin: 60 })).toMatch(/cambios/);
    expect(validate({ zone: 'Z99', hvac: 'on', durationMin: 60 })).toMatch(/desconocida/);
  });

  it('traduce al contrato de Node-RED', () => {
    expect(
      toPayload({ kind: 'override', cmd: { zone: 'Z03', hvac: 'off', lights: 0.4, durationMin: 30 } }, 'ana')
    ).toEqual({
      tipo: 'override',
      zona: 'Z03',
      hvac_enable: false,
      luces_nivel: 0.4,
      duracion_min: 30,
      usuario: 'ana',
    });
    expect(toPayload({ kind: 'params', params: { limitKw: 135 } })).toEqual({
      tipo: 'parametros',
      limite_kw: 135,
      usuario: undefined,
    });
    expect(toPayload({ kind: 'release', zone: '*' })).toEqual({ tipo: 'liberar', zona: '*', usuario: undefined });
    expect(describeCmd({ kind: 'override', cmd: { zone: 'Z03', setpoint: 25, durationMin: 60 } })).toBe(
      'Z03: setpoint 25.0 °C por 60 min'
    );
  });

  it('aplica, vence y libera overrides', () => {
    const t = at(10);
    let ov = applyLocal({}, { kind: 'override', cmd: { zone: 'Z02', hvac: 'off', durationMin: 30 } }, t);
    expect(ov.Z02.until - ov.Z02.since).toBe(30 * 60_000);
    expect(Object.keys(prune(ov, t + 31 * 60_000))).toHaveLength(0);
    ov = applyLocal(ov, { kind: 'override', cmd: { zone: 'Z04', lights: 0, durationMin: 60 } }, t);
    expect(Object.keys(applyLocal(ov, { kind: 'release', zone: 'Z02' }, t))).toEqual(['Z04']);
    expect(applyLocal(ov, { kind: 'release', zone: '*' }, t)).toEqual({});
  });
});

describe('overrides en el simulador', () => {
  const t0 = at(10, 0);
  const t = at(11, 0);
  const base = { limitKw: 30 };

  it('apagar el HVAC de una zona la calienta y baja su potencia', () => {
    const auto = simulate(t, base);
    const off = simulate(t, { ...base, overrides: { Z02: { hvac: 'off', since: t0, until: t0 + 3 * 3_600_000 } } });
    expect(off.zones.Z02.override).toBe(true);
    expect(off.zones.Z02.hvacEnable).toBe(false);
    expect(off.zones.Z02.temp).toBeGreaterThan(auto.zones.Z02.temp + 1);
    expect(off.zones.Z02.pHvac).toBeLessThan(auto.zones.Z02.pHvac + 1e-9);
  });

  it('fija luces y enchufes, y no toca zonas críticas', () => {
    const s = simulate(t, {
      ...base,
      overrides: {
        Z03: { lights: 0, plugs: 0.1, since: t0, until: t0 + 3_600_000 * 3 },
        Z09: { hvac: 'off', since: t0, until: t0 + 3_600_000 * 3 },
      },
    });
    expect(s.zones.Z03.lights).toBe(0);
    expect(s.zones.Z03.pLights).toBe(0);
    expect(s.zones.Z09.override).toBe(false);
    expect(s.zones.Z09.hvacEnable).toBe(true);
  });

  it('el override vencido ya no aplica', () => {
    const s = simulate(t, { ...base, overrides: { Z02: { hvac: 'off', since: t0, until: t0 + 60_000 } } });
    expect(s.zones.Z02.override).toBe(false);
  });

  it('el setpoint con ocupación global cambia las zonas ocupadas', () => {
    const s = simulate(t, { ...base, spOccupied: 25 });
    expect(s.zones.Z02.setpoint).toBe(25);
  });
});
