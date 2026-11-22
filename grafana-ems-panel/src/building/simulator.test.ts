import { ZONES } from './model';
import { clock, incident, instant, simulate, simulateHistory } from './simulator';

// martes 3 nov 2026 (hora de Panamá = UTC-5)
const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const opts = { limitKw: 75 };

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
    expect(personas(dia)).toBeGreaterThan(110); // aforo de diseño del modelo: 172 personas
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
      expect(s.zones.Z06.drForced).toBeFalsy();
      expect(s.zones.Z06.hvacEnable).toBe(true);
      expect(s.zones.Z06.setpoint).toBe(22);
      expect(s.zones.Z06.temp).toBeLessThan(27);
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

  it('línea base del modelo E+: setpoints de horario 24 h, pico ≈ 110–140 kW y sin limitador', () => {
    const o = { ...opts, demoIncidents: false, controller: 'baseline' as const };
    let peak = 0;
    for (let m = 0; m < 24 * 60; m += 15) {
      peak = Math.max(peak, instant(at(0, m), o).pTotal);
    }
    expect(peak).toBeGreaterThan(110);
    expect(peak).toBeLessThan(140);
    const noche = simulate(at(3), o);
    expect(noche.zones.Z07.setpoint).toBe(22); // oficinas: TEMP_Refrigeracion
    expect(noche.zones.Z11.setpoint).toBe(24); // baños: TEMP_HVAC BANO
    expect(noche.zones.Z06.setpoint).toBe(22); // servidores: fijo
    expect(simulate(at(14), o).ems!.drActive).toBe(false);
  });

  it('el EMS con limitador queda por debajo del pico de la línea base', () => {
    let peak = 0;
    for (let m = 6 * 60; m < 20 * 60; m += 15) {
      peak = Math.max(peak, instant(at(0, m), { ...opts, demoIncidents: false }).pTotal);
    }
    expect(peak).toBeLessThan(opts.limitKw + 5);
  });

  it('ocupación de 8 a 18 h y ascensor según su horario', () => {
    const o = { ...opts, demoIncidents: false };
    // la llegada y la salida son graduales (rampa de 60 min ± 25 min por zona y día)
    expect(simulate(at(7), o).zones.Z07.occupants).toBe(0);
    expect(simulate(at(10), o).zones.Z07.occupants).toBeGreaterThan(0);
    expect(simulate(at(19), o).zones.Z07.occupants).toBe(0);
    // Ascensor 14.86 kW × 0.2 (8–18 h) + extractores 0.075 kW
    expect(simulate(at(10), o).meter!.pFixed).toBeCloseTo(14.86 * 0.2 + 0.075, 6);
    expect(simulate(at(3), o).meter!.pFixed).toBe(0);
  });

  it('variante con FV: generación, red neta y demanda sobre la importación', () => {
    const o = { ...opts, demoIncidents: false, pv: true };
    const m = simulate(at(12), o).meter!;
    const irr = m.irr;
    expect(m.pPv).toBeCloseTo((irr * 400 * 0.6 * 0.24 * 0.96) / 1000, 6);
    expect(m.pGrid).toBeCloseTo(m.pTotal - m.pPv!, 6);
    expect(m.ePv).toBeGreaterThan(0);
    expect(m.demand15).toBeLessThan(m.pTotal);
    expect(simulate(at(12), opts).meter!.pPv).toBeUndefined();
    expect(simulate(at(2), o).meter!.pPv).toBe(0);
  });

  it('genera tendencias con el número de puntos pedido', () => {
    const h = simulateHistory(at(12), 3600000, 13, opts);
    expect(h.Z02.temp).toHaveLength(13);
    expect(h.EDIF.pTotal).toHaveLength(13);
  });
});
