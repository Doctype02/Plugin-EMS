import { LIGHT, blend, faceColor, floorFinish, lit, luminance, materials, zoneMark } from './materials';
import { ZONES } from './model';

describe('materiales y luz de la escena', () => {
  it('la cara superior es la más clara y la lateral la más oscura', () => {
    expect(LIGHT.top).toBeGreaterThan(LIGHT.front);
    expect(LIGHT.front).toBeGreaterThan(LIGHT.side);
    const c = '#8090a0';
    expect(luminance(faceColor(c, 'top'))).toBeGreaterThan(luminance(faceColor(c, 'front')));
    expect(luminance(faceColor(c, 'front'))).toBeGreaterThan(luminance(faceColor(c, 'side')));
  });

  it('lit y blend devuelven #rrggbb válidos y acotados', () => {
    expect(lit('#ffffff', 2)).toBe('#ffffff');
    expect(lit('#808080', 0)).toBe('#000000');
    expect(lit('#abc', 1)).toBe('#aabbcc');
    expect(blend('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('cada tipo de zona tiene acabado de piso en los dos temas', () => {
    for (const z of ZONES) {
      for (const dark of [true, false]) {
        expect(floorFinish(z.type, dark).color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('la arquitectura es neutra: piso más oscuro que el muro en el tema oscuro, al revés no satura', () => {
    const d = materials(true);
    const l = materials(false);
    expect(luminance(d.wall)).toBeGreaterThan(luminance(floorFinish('oficina', true).color));
    expect(luminance(l.skyBottom)).toBeGreaterThan(0.8);
    expect(luminance(d.skyTop)).toBeLessThan(0.05);
  });

  it('el estado no tapa el material: normal sin tinte, alerta/crítico con rayado y tinte translúcido', () => {
    expect(zoneMark('status', 'ok', '#0f0').tintOpacity).toBe(0);
    const crit = zoneMark('status', 'critical', '#f00');
    expect(crit.hatch).toBe('alert');
    expect(crit.tintOpacity).toBeLessThan(0.5);
    expect(zoneMark('status', 'warning', '#fa0').hatch).toBe('alert');
    expect(zoneMark('status', 'offline', '#888').hatch).toBe('offline');
    const data = zoneMark('data', 'ok', '#36c');
    expect(data.tintOpacity).toBeGreaterThan(0);
    expect(data.tintOpacity).toBeLessThan(1);
  });
});
