import { DEMAND_WARN, demandLevel, gaugeScale } from './demand';
import { LIMIT_KW } from './model';

describe('nivel de demanda', () => {
  it('clasifica frente al límite de 170 kW', () => {
    expect(demandLevel(100, LIMIT_KW)).toBe('ok');
    expect(demandLevel(LIMIT_KW * DEMAND_WARN, LIMIT_KW)).toBe('warning');
    expect(demandLevel(170, LIMIT_KW)).toBe('warning');
    expect(demandLevel(170.1, LIMIT_KW)).toBe('critical');
    expect(demandLevel(50, 0)).toBe('ok');
    expect(demandLevel(NaN, 170)).toBe('ok');
  });

  it('la escala deja ver el límite y la sobrecarga', () => {
    expect(gaugeScale(10, 170)).toBeCloseTo(200.6);
    expect(gaugeScale(300, 170)).toBeCloseTo(315);
    expect(170 / gaugeScale(10, 170)).toBeLessThan(0.9);
  });
});
