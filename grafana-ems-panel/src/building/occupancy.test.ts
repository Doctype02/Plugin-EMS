import { applyOccupancy, toPayload, validateOccupancy } from './control';
import { simulate } from './simulator';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const base = { limitKw: 30, demoIncidents: false };
const occ = (zone: string, v: { people?: number; pct?: number }, from = at(8), until = at(18)) => ({
  [zone]: { ...v, since: from, until },
});

describe('control de la cantidad de personas', () => {
  it('fija las personas de una zona y su efecto en luces, HVAC y potencia', () => {
    const normal = simulate(at(11), base);
    const vacia = simulate(at(11), { ...base, occupancy: occ('Z03', { people: 0 }) });
    const llena = simulate(at(11), { ...base, occupancy: occ('Z03', { people: 40 }) });
    expect(vacia.zones.Z03.occupants).toBe(0);
    expect(vacia.zones.Z03.occupied).toBe(false);
    expect(llena.zones.Z03.occupants).toBe(40);
    expect(llena.zones.Z03.peopleForced).toBe(true);
    expect(llena.zones.Z03.pHvac).toBeGreaterThan(vacia.zones.Z03.pHvac);
    expect(normal.zones.Z02.occupants).toBe(llena.zones.Z02.occupants);
  });

  it('escala la ocupación de todo el edificio y de noche funciona por zona', () => {
    const ppl = (s: ReturnType<typeof simulate>) => Object.values(s.zones).reduce((a, z) => a + z.occupants, 0);
    const n = ppl(simulate(at(11), base));
    expect(ppl(simulate(at(11), { ...base, occupancy: occ('*', { pct: 0 }) }))).toBe(0);
    expect(ppl(simulate(at(11), { ...base, occupancy: occ('*', { pct: 50 }) }))).toBeLessThan(n * 0.65);
    const noche = simulate(at(22), { ...base, occupancy: occ('Z02', { people: 6 }, at(21), at(23)) });
    expect(noche.zones.Z02.occupants).toBe(6);
    expect(noche.zones.Z02.lights).toBeGreaterThan(0);
  });

  it('valida, aplica y envía los comandos', () => {
    expect(validateOccupancy({ kind: 'occupancy', zone: 'Z03', people: 41, durationMin: 30 })).toBeDefined();
    expect(validateOccupancy({ kind: 'occupancy', zone: 'Z09', people: 1, durationMin: 30 })).toBeDefined();
    expect(validateOccupancy({ kind: 'occupancy', zone: '*', pct: 250, durationMin: 30 })).toBeDefined();
    expect(validateOccupancy({ kind: 'occupancy', zone: 'Z03', people: 25, durationMin: 30 })).toBeUndefined();
    const o = applyOccupancy({}, { kind: 'occupancy', zone: 'Z03', people: 25, durationMin: 30 }, 0);
    expect(o.Z03).toEqual({ people: 25, pct: undefined, since: 0, until: 1_800_000, user: undefined });
    expect(applyOccupancy(o, { kind: 'occupancy_release', zone: 'Z03' }, 0)).toEqual({});
    expect(toPayload({ kind: 'occupancy', zone: '*', pct: 50, durationMin: 60 }, 'ana')).toEqual({
      tipo: 'ocupacion',
      zona: '*',
      porcentaje: 50,
      duracion_min: 60,
      usuario: 'ana',
    });
  });
});
