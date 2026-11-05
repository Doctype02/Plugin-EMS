import { ZONES } from './model';
import { clock, incident, simulate, simulateHistory } from './simulator';

// martes 3 nov 2026 (hora de Panamá = UTC-5)
const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const opts = { limitKw: 145 };

describe('simulador del edificio', () => {
  it('usa la hora de Panamá', () => {
    const c = clock(at(10, 30));
    expect(c.h).toBeCloseTo(10.5);
    expect(c.weekday).toBe(true);
  });

  it('es determinista', () => {
    expect(simulate(at(11), opts)).toEqual(simulate(at(11), opts));
  });

  it('el edificio está ocupado de día y vacío de madrugada', () => {
    const dia = simulate(at(10), opts);
    const noche = simulate(at(3), opts);
    const personas = (s: ReturnType<typeof simulate>) =>
      ZONES.filter((z) => !z.critical).reduce((a, z) => a + s.zones[z.id].occupants, 0);
    expect(personas(dia)).toBeGreaterThan(100);
    expect(personas(noche)).toBe(0);
    expect(dia.meter!.pTotal).toBeGreaterThan(noche.meter!.pTotal * 1.8);
  });

  it('respeta el límite de demanda salvo zonas que ya están al borde del confort', () => {
    for (let m = 0; m < 24 * 60; m += 20) {
      const s = simulate(at(0, m), opts);
      expect(s.meter!.pTotal).toBeLessThan(opts.limitKw + 25);
    }
  });

  it('las zonas críticas nunca se deslastran', () => {
    for (let h = 0; h < 24; h += 1) {
      const s = simulate(at(h), opts);
      expect(s.zones.Z09.drForced).toBeFalsy();
      expect(s.zones.Z09.hvacEnable).toBe(true);
      expect(s.zones.Z09.temp).toBeLessThan(27);
    }
  });

  it('balance del medidor: P total = suma de usos + cargas fijas, S² = P² + Q²', () => {
    const m = simulate(at(14), opts).meter!;
    expect(m.pHvac + m.pLights + m.pPlugs + m.pFixed).toBeCloseTo(m.pTotal, 6);
    expect(Math.hypot(m.pTotal, m.q)).toBeCloseTo(m.s, 6);
    expect(m.pf).toBeGreaterThan(0.8);
    expect(m.pf).toBeLessThanOrEqual(1);
  });

  it('cada día laborable tiene un incidente que genera alarma', () => {
    for (const day of [2, 3, 4]) {
      const inc = [...Array(48).keys()].map((i) => incident(at(0, i * 30, day))).find(Boolean);
      expect(inc).toBeDefined();
      const s = simulate(at(Math.floor(inc!.from + 0.9), Math.round(((inc!.from + 0.9) % 1) * 60), day), opts);
      expect(s.alarms.some((a) => a.zone === inc!.zone)).toBe(true);
    }
  });

  it('genera tendencias con el número de puntos pedido', () => {
    const h = simulateHistory(at(12), 3600000, 13, opts);
    expect(h.Z02.temp).toHaveLength(13);
    expect(h.EDIF.pTotal).toHaveLength(13);
  });
});
