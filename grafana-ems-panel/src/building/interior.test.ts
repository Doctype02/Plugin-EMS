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

  it('el cuarto de servidores tiene filas de racks y las oficinas escritorios para su aforo', () => {
    const racks = interiorOf(ZONES.find((z) => z.id === 'Z09')!).furniture.filter((f) => f.kind === 'rack');
    expect(racks.length).toBeGreaterThanOrEqual(20);
    const z02 = ZONES.find((z) => z.id === 'Z02')!;
    expect(interiorOf(z02).seats.length).toBeGreaterThanOrEqual(14);
  });

  it('marca las fachadas exteriores', () => {
    const lobby = edgesOf(ZONES.find((z) => z.id === 'Z01')!.rect);
    expect(
      lobby
        .filter((e) => e.exterior)
        .map((e) => e.side)
        .sort()
    ).toEqual(['n', 's', 'w']);
  });
});
