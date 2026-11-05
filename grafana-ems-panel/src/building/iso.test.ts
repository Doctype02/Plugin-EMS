import { Pt, bounds, placement, prism, rotate } from './iso';
import { BUILDING } from './model';

describe('proyección isométrica', () => {
  it('rota alrededor del centro del edificio', () => {
    const p = rotate(0, 0, 90);
    expect(p.x).toBeCloseTo(BUILDING.depth / 2);
    expect(p.y).toBeCloseTo(-BUILDING.width / 2);
    const c = rotate(BUILDING.width / 2, BUILDING.depth / 2, 270);
    expect(Math.abs(c.x) + Math.abs(c.y)).toBeCloseTo(0);
  });

  it('identifica las fachadas visibles según la orientación', () => {
    const rect = { x: 0, y: 0, w: 10, d: 5 };
    const edges = (az: 0 | 90 | 180 | 270) =>
      prism(rect, 0, 3, { azimuth: az, layout: 'stacked', scale: 10 }).sides.map((s) => s.edge);
    expect(edges(0)).toEqual(['s', 'e']);
    expect(edges(90)).toEqual(['w', 's']);
    expect(edges(180)).toEqual(['n', 'w']);
    expect(edges(270)).toEqual(['e', 'n']);
  });

  it('en la vista explotada los niveles no se superponen en pantalla', () => {
    const inside = (pt: Pt, poly: Pt[]) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [a, b] = [poly[i], poly[j]];
        if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
          c = !c;
        }
      }
      return c;
    };
    for (const azimuth of [0, 90, 180, 270] as const) {
      const cfg = { azimuth, layout: 'exploded' as const, scale: 10 };
      const full = { x: 0, y: 0, w: BUILDING.width, d: BUILDING.depth };
      const p0 = placement(0, cfg);
      const p1 = placement(1, cfg);
      const lower = prism(full, p0.z, 3, cfg, 0, p0.dy);
      const upper = prism(full, p1.z, 3, cfg, 0, p1.dy);
      for (const face of [upper.top, ...upper.sides.map((sd) => sd.points)]) {
        for (let u = 0.02; u < 1; u += 0.08) {
          for (let v = 0.02; v < 1; v += 0.08) {
            const [a, b, , d] = face;
            const pt = { x: a.x + (b.x - a.x) * u + (d.x - a.x) * v, y: a.y + (b.y - a.y) * u + (d.y - a.y) * v };
            expect(inside(pt, lower.top)).toBe(false);
          }
        }
      }
    }
    const cfg = { azimuth: 0 as const, layout: 'exploded' as const, scale: 10 };
    expect(bounds(cfg, 4).h).toBeGreaterThan(bounds({ ...cfg, layout: 'stacked' }, 4).h);
  });

  it('ordena de atrás hacia adelante: la zona sur queda delante de la norte', () => {
    const cfg = { azimuth: 0 as const, layout: 'stacked' as const, scale: 10 };
    const sur = prism({ x: 0, y: 0, w: 27, d: 9 }, 0, 3, cfg);
    const norte = prism({ x: 0, y: 11, w: 27, d: 9 }, 0, 3, cfg);
    expect(norte.depth).toBeGreaterThan(sur.depth);
  });
});
