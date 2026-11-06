import { pmv, ppd, xFactor, batteryLifeFactor } from './comfort';
import { freeFloatCurve, projectHeatwave, projectZone } from './projection';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);

describe('confort y proyección', () => {
  it('PMV de referencia ISO 7730 (ta=tr=22, HR 60 %, 0.1 m/s, 1.2 met, 0.5 clo ≈ −0.75)', () => {
    const v = pmv({ ta: 22, rh: 60, vel: 0.1, met: 1.2, clo: 0.5 });
    expect(v).toBeGreaterThan(-0.9);
    expect(v).toBeLessThan(-0.6);
    expect(ppd(0)).toBeCloseTo(5, 1);
  });

  it('factor X y baterías', () => {
    expect(xFactor(20)).toBeCloseTo(1);
    expect(xFactor(30)).toBeCloseTo(1.42);
    expect(batteryLifeFactor(33)).toBeCloseTo(0.5);
  });

  it('una oficina a 29 °C durante 8 h pierde rendimiento y tiene muchos insatisfechos', () => {
    const p = projectZone('Z04', 29, 8);
    expect(p.productivityLoss).toBeCloseTo(8);
    expect(p.ppd).toBeGreaterThan(30);
    expect(p.energyKwh).toBeLessThan(0);
  });

  it('servidores a 31 °C: fuera del recomendado, más fallas y baterías degradadas', () => {
    const p = projectZone('Z09', 31, 24);
    expect(p.it!.cls).toBe('admisible');
    expect(p.it!.extraFailuresPct).toBeGreaterThan(10);
    expect(p.it!.batteryLife).toBeLessThan(0.7);
  });

  it('sin enfriamiento el cuarto de servidores supera 27 °C en poco tiempo', () => {
    const r = freeFloatCurve('Z09', at(11), 4, { limitKw: 30 });
    expect(r.thresholds[0].minutes).toBeDefined();
    expect(r.thresholds[0].minutes!).toBeLessThan(120);
    expect(r.final).toBeGreaterThan(r.series[0][1]);
  });

  it('una ola de calor de 3 días aumenta la energía y el pico', () => {
    const r = projectHeatwave(at(0), 72, 5, { limitKw: 30, demoIncidents: false });
    expect(r.energyHot).toBeGreaterThan(r.energyBase * 1.05);
    expect(r.peakHot).toBeGreaterThanOrEqual(r.peakBase);
  });
});
