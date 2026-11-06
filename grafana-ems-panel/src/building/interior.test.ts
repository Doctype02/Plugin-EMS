import { ZONES } from './model';
import { edgesOf, interiorOf } from './interior';

describe('interior de las zonas', () => {
  it.each(ZONES.map((z) => [z.id, z]))('%s: mobiliario, puestos y difusores dentro de la zona', (_id, zone) => {
    const r = zone.rect;
    const inside = (x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d;
    const it = interiorOf(zone);
    expect(it.furniture.length).toBeGreaterThan(0);
    expect(it.seats.length).toBeGreaterThan(0);
    for (const f of it.furniture) {
      expect(inside(f.rect.x, f.rect.y) && inside(f.rect.x + f.rect.w, f.rect.y + f.rect.d)).toBe(true);
    }
    for (const p of [...it.seats, ...it.diffusers, ...it.lights, it.hub]) {
      expect(inside(p.x, p.y)).toBe(true);
    }
  });

  it('el cuarto de servidores tiene una fila de racks y oficinas y cubículos tienen puestos para su aforo', () => {
    const racks = interiorOf(ZONES.find((z) => z.id === 'Z09')!).furniture.filter((f) => f.kind === 'rack');
    expect(racks.length).toBeGreaterThanOrEqual(5);
    for (const id of ['Z02', 'Z04', 'Z05', 'Z06', 'Z07']) {
      const zone = ZONES.find((z) => z.id === id)!;
      expect(interiorOf(zone).seats.length).toBeGreaterThanOrEqual(zone.occupants);
    }
  });

  it('marca las fachadas exteriores', () => {
    const exteriores = (id: string) =>
      edgesOf(ZONES.find((z) => z.id === id)!.rect)
        .filter((e) => e.exterior)
        .map((e) => e.side)
        .sort();
    expect(exteriores('Z01')).toEqual(['e', 's']); // recepción: esquina sureste
    expect(exteriores('Z08')).toEqual(['n', 's']); // pasillo: atraviesa la planta alta
  });
});
