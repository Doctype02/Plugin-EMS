import ref from './__fixtures__/thermal_ref.json';
import {
  BUILDING,
  CRITICAL_ZONES,
  FLOORS,
  HVAC_SYSTEMS,
  LIMIT_KW,
  LIMIT_RANGE,
  PTAC_UNITS,
  PV,
  VRF_UNITS,
  ZONES,
  pvPowerKw,
  thermal,
} from './model';
import { pvRows } from '../components/Rooftop';

type Ref = Record<
  string,
  { ua: number; g_inf: number; ua_arriba: number; ua_abajo: number; ua_suelo: number; c: number; cop: number }
>;

describe('modelo del edificio (config/edificio.yaml)', () => {
  it('5 plantas, 26 zonas, una sola crítica y núcleo del elevador en cada planta', () => {
    expect(BUILDING.floors).toBe(5);
    expect(FLOORS.map((f) => f.short)).toEqual(['PB', 'P1', 'P2', 'P3', 'P4']);
    expect(ZONES).toHaveLength(26);
    expect(CRITICAL_ZONES).toEqual(['Z06']);
    expect(FLOORS.every((f) => f.extras.some((e) => e.label === 'Elevador'))).toBe(true);
    for (const f of FLOORS) {
      const area = ZONES.filter((z) => z.floor === f.level).reduce((a, z) => a + z.area, 0);
      const extras = f.extras.reduce((a, e) => a + e.rect.w * e.rect.d, 0);
      expect(area + extras).toBeCloseTo(BUILDING.width * BUILDING.depth, 6);
    }
  });

  it('las partes de cada zona suman su área', () => {
    for (const z of ZONES) {
      expect(z.rects.reduce((a, r) => a + r.w * r.d, 0)).toBeCloseTo(z.area, 6);
    }
  });

  it('6 VRF en la azotea (sin solaparse entre sí) y 5 PTAC, uno por baño', () => {
    expect(VRF_UNITS.map((u) => u.id)).toEqual(['VRF-PB', 'VRF-P1', 'VRF-P2', 'VRF-P3', 'VRF-P4', 'VRF-SRV']);
    expect(PTAC_UNITS).toHaveLength(5);
    expect(PTAC_UNITS.every((p) => ZONES.find((z) => z.id === p.zone)?.type === 'bano')).toBe(true);
    expect(HVAC_SYSTEMS).toHaveLength(11);
    for (const [i, a] of VRF_UNITS.entries()) {
      expect(a.rect.x).toBeGreaterThan(0.25);
      expect(a.rect.x + a.rect.w).toBeLessThan(BUILDING.width - 0.25);
      for (const b of VRF_UNITS.slice(i + 1)) {
        expect(a.rect.x + a.rect.w <= b.rect.x || b.rect.x + b.rect.w <= a.rect.x).toBe(true);
      }
    }
    for (const z of ZONES) {
      expect(HVAC_SYSTEMS.find((s) => s.id === z.system)?.zones).toContain(z.id);
    }
  });

  it('thermal replica ems/config.py::zonas (ua, infiltración, losas, terreno, capacitancia, COP)', () => {
    const r = (ref as { zonas: Ref }).zonas;
    for (const z of ZONES) {
      const th = thermal(z);
      const p = r[z.id];
      expect(th.ua).toBeCloseTo(p.ua, 9);
      expect(th.gInf).toBeCloseTo(p.g_inf, 9);
      expect(th.uaUp).toBeCloseTo(p.ua_arriba, 9);
      expect(th.uaDown).toBeCloseTo(p.ua_abajo, 9);
      expect(th.uaGround).toBeCloseTo(p.ua_suelo, 9);
      expect(th.c).toBeCloseTo(p.c, 9);
      expect(z.cop).toBeCloseTo(p.cop, 9);
    }
  });

  it('FV: P = Σárea × 0.6 × 0.24 × 0.96 × G/1000 (≈ 55 kW a 1000 W/m²), igual que Python', () => {
    expect(pvPowerKw(1000)).toBeCloseTo((ref as { fv_kw_1000: number }).fv_kw_1000, 6);
    expect(pvPowerKw(1000)).toBeCloseTo(55.3, 1);
    expect(pvPowerKw(-5)).toBe(0);
  });

  it('las filas de módulos cubren ≈ la fracción activa de cada campo y esquivan obstáculos', () => {
    const f = PV.fields.find((x) => x.id === 'FV-2')!;
    const rows = pvRows(f.rect, []);
    const area = rows.reduce((a, r) => a + r.w * r.d, 0);
    expect(area / (f.rect.w * f.rect.d)).toBeGreaterThan(0.45);
    expect(area / (f.rect.w * f.rect.d)).toBeLessThan(0.65);
    const obstacle = { x: 14, y: 12, w: 3, d: 3 };
    for (const r of pvRows(f.rect, [obstacle])) {
      const overlap =
        r.x < obstacle.x + obstacle.w &&
        obstacle.x < r.x + r.w &&
        r.y < obstacle.y + obstacle.d &&
        obstacle.y < r.y + r.d;
      expect(overlap).toBe(false);
    }
  });

  it('límite de demanda y rango aceptado por Node-RED', () => {
    expect(Math.abs(LIMIT_RANGE[0] - 0.25 * LIMIT_KW)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(LIMIT_RANGE[1] - 3.3 * LIMIT_KW)).toBeLessThanOrEqual(0.5);
  });
});
