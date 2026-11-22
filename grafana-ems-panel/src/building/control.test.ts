import {
  SP_RANGE,
  applyLocal,
  describe as describeCmd,
  feedbackFor,
  prune,
  resolveControlUrl,
  secureControlUrl,
  toPayload,
  validate,
  validateCommand,
  validateParams,
} from './control';
import { LIMIT_KW, LIMIT_RANGE } from './model';
import { simulate } from './simulator';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);

describe('comandos del operador', () => {
  it('valida rangos y zonas críticas', () => {
    expect(validate({ zone: 'Z02', setpoint: 23, durationMin: 60 })).toBeUndefined();
    expect(validate({ zone: 'Z06', hvac: 'off', durationMin: 60 })).toMatch(/crítica/);
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

describe('parámetros del EMS', () => {
  it('el límite de diseño es 170 kW y el rango el de Node-RED', () => {
    expect(LIMIT_KW).toBe(170);
    expect(LIMIT_RANGE).toEqual([42, 561]);
    expect(SP_RANGE).toEqual([20, 28]);
  });

  it('valida limite_kw y sp_ocupado', () => {
    expect(validateParams({ limitKw: 170 })).toBeUndefined();
    expect(validateParams({ limitKw: 42, spOccupied: 20 })).toBeUndefined();
    expect(validateParams({ limitKw: 561, spOccupied: 28 })).toBeUndefined();
    expect(validateParams({ limitKw: 41 })).toMatch(/42 y 561/);
    expect(validateParams({ limitKw: 562 })).toMatch(/42 y 561/);
    expect(validateParams({ limitKw: NaN })).toMatch(/límite/);
    expect(validateParams({ spOccupied: 19.5 })).toMatch(/20 y 28/);
    expect(validateParams({ spOccupied: 28.5 })).toMatch(/20 y 28/);
    expect(validateParams({})).toMatch(/cambios/);
  });

  it('validateCommand cubre todos los tipos', () => {
    expect(validateCommand({ kind: 'params', params: { limitKw: 600 } })).toMatch(/límite/);
    expect(validateCommand({ kind: 'override', cmd: { zone: 'Z06', hvac: 'off', durationMin: 5 } })).toMatch(/crítica/);
    expect(validateCommand({ kind: 'occupancy', zone: '*', pct: 250, durationMin: 60 })).toMatch(/porcentaje/);
    expect(validateCommand({ kind: 'release', zone: '*' })).toBeUndefined();
  });

  it('resume el resultado del envío', () => {
    expect(feedbackFor({ ok: 1, failed: 0, errors: [] }, false)).toEqual({
      phase: 'ok',
      text: 'Comando aplicado en el simulador',
    });
    expect(feedbackFor({ ok: 20, failed: 0, errors: [] }, true).text).toBe(
      '20 comandos aplicados · confirmado por Node-RED'
    );
    const err = feedbackFor({ ok: 0, failed: 1, errors: ['HTTP 500: caído'] }, true);
    expect(err).toEqual({ phase: 'error', text: 'HTTP 500: caído' });
    expect(feedbackFor({ ok: 3, failed: 1, errors: ['x'] }, true).text).toBe('1 de 4 comandos fallaron: x');
  });
});

describe('overrides en el simulador', () => {
  const t0 = at(10, 0);
  const t = at(11, 0);
  const base = { limitKw: 170 };

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
        Z06: { hvac: 'off', since: t0, until: t0 + 3_600_000 * 3 },
      },
    });
    expect(s.zones.Z03.lights).toBe(0);
    expect(s.zones.Z03.pLights).toBe(0);
    expect(s.zones.Z06.override).toBe(false);
    expect(s.zones.Z06.hvacEnable).toBe(true);
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

describe('resolveControlUrl', () => {
  it('reemplaza {host} por el host de Grafana', () => {
    expect(resolveControlUrl('http://{host}:1880/ems/control', '192.168.0.30')).toBe(
      'http://192.168.0.30:1880/ems/control'
    );
    expect(resolveControlUrl('http://{host}:1880/ems/control', 'fe80::1')).toBe('http://[fe80::1]:1880/ems/control');
    expect(resolveControlUrl('http://10.0.0.5:1880/ems/control', 'otro')).toBe('http://10.0.0.5:1880/ems/control');
  });
});

describe('secureControlUrl', () => {
  it('con HTTPS las órdenes van al mismo origen; con HTTP se respeta la URL configurada', () => {
    const https = { protocol: 'https:', origin: 'https://ems.example.org' };
    const http = { protocol: 'http:', origin: 'http://192.168.0.30:3000' };
    expect(secureControlUrl('http://192.168.0.30:1880/ems/control', https)).toBe('https://ems.example.org/ems/control');
    expect(secureControlUrl('http://192.168.0.30:1880/ems/control', http)).toBe('http://192.168.0.30:1880/ems/control');
    expect(secureControlUrl('https://otro/ems/control', https)).toBe('https://otro/ems/control');
  });
});
