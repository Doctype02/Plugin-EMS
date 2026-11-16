import { ZONES } from './model';
import { edgesOf, interiorOf, zoneEdges } from './interior';

describe('interior de las zonas', () => {
  it.each(ZONES.map((z) => [z.id, z]))('%s: mobiliario, puestos y difusores dentro de la zona', (_id, zone) => {
    const inside = (x: number, y: number) =>
      zone.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d);
    const it = interiorOf(zone);
    expect(it.furniture.length).toBeGreaterThan(0);
    expect(it.seats.length).toBeGreaterThan(0);
    for (const f of it.furniture) {
      expect(inside(f.rect.x, f.rect.y) && inside(f.rect.x + f.rect.w, f.rect.y + f.rect.d)).toBe(true);
    }
    for (const p of [...it.seats, ...it.chairs, ...it.diffusers, ...it.lights, it.hub]) {
      expect(inside(p.x, p.y)).toBe(true);
    }
  });

  it('el cuarto de servidores tiene una fila de racks y oficinas y cubículos tienen puestos para su aforo', () => {
    const racks = interiorOf(ZONES.find((z) => z.id === 'Z06')!).furniture.filter((f) => f.kind === 'rack');
    expect(racks.length).toBeGreaterThanOrEqual(3);
    for (const id of ['Z01', 'Z02', 'Z07', 'Z08', 'Z09', 'Z24']) {
      const zone = ZONES.find((z) => z.id === id)!;
      expect(interiorOf(zone).seats.length).toBeGreaterThanOrEqual(zone.occupants);
    }
  });

  it('los puestos de oficina y la mesa de juntas tienen silla orientada hacia la mesa', () => {
    const office = interiorOf(ZONES.find((z) => z.id === 'Z07')!);
    expect(office.chairs.length).toBe(office.furniture.filter((f) => f.kind === 'desk').length);
    expect(office.chairs.every((c) => c.facing === 'n')).toBe(true);
    const conf = interiorOf(ZONES.find((z) => z.id === 'Z03')!);
    const table = conf.furniture.find((f) => f.kind === 'table')!.rect;
    for (const c of conf.chairs) {
      const cx = table.x + table.w / 2;
      const cy = table.y + table.d / 2;
      // mirar hacia la mesa: el vector de la silla al centro coincide con la orientación
      const dir = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[c.facing];
      expect(dir[0] * (cx - c.x) + dir[1] * (cy - c.y)).toBeGreaterThan(0);
    }
  });

  it('marca las fachadas exteriores', () => {
    const exteriores = (id: string) =>
      edgesOf(ZONES.find((z) => z.id === id)!.rect)
        .filter((e) => e.exterior)
        .map((e) => e.side)
        .sort();
    expect(exteriores('Z01')).toEqual(['n', 'w']); // recepción: esquina noroeste
    expect(exteriores('Z04')).toEqual(['n']); // pasillo: del núcleo del elevador a la fachada norte
    expect(exteriores('Z02')).toEqual(['e', 'n', 's']); // cubículos: todo el lado este de la PB
  });

  it('los baños tienen cubículos y lavamanos', () => {
    const kinds = interiorOf(ZONES.find((z) => z.id === 'Z11')!).furniture.map((f) => f.kind);
    expect(kinds).toContain('stall');
    expect(kinds).toContain('sink');
  });

  it('la sala de conferencias en L no tiene muro entre sus dos partes', () => {
    const z03 = ZONES.find((z) => z.id === 'Z03')!;
    expect(z03.rects).toHaveLength(2);
    const edges = zoneEdges(z03);
    // el borde este de la parte principal (x = 6) sólo queda entre y = 4 y y = 8 (junto a los servidores)
    const east = edges.filter((e) => e.side === 'e' && e.a.x === 6);
    expect(east).toHaveLength(1);
    expect([east[0].a.y, east[0].b.y].sort((a, b) => a - b)).toEqual([4, 8]);
    expect(edges.some((e) => e.side === 'w' && e.a.x === 6)).toBe(false);
    // perímetro de la L = 2 × (9 + 10)
    const len = edges.reduce((a, e) => a + Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y), 0);
    expect(len).toBeCloseTo(38);
  });
});
