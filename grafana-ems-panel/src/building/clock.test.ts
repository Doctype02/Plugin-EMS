import {
  atHour,
  atWeekday,
  formatClock,
  initialClock,
  localParts,
  setSpeed,
  simNow,
  tickMs,
  togglePlay,
} from './clock';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);

describe('reloj de simulación', () => {
  it('refresca la instantánea cada ~5 min simulados, entre 250 ms y 1 s', () => {
    const c = initialClock(0, 1);
    expect(tickMs(c)).toBe(1000);
    expect(tickMs(setSpeed(c, 60, 0))).toBe(1000);
    expect(tickMs(setSpeed(c, 600, 0))).toBe(500);
    expect(tickMs(setSpeed(c, 3600, 0))).toBe(250);
    expect(tickMs(togglePlay(setSpeed(c, 3600, 0), 0))).toBe(1000);
  });

  it('avanza a la velocidad elegida y se pausa', () => {
    let s = initialClock(1000, 60);
    expect(simNow(s, 2000)).toBe(1000 + 60_000);
    s = togglePlay(s, 2000);
    expect(simNow(s, 9000)).toBe(61_000);
    s = setSpeed(s, 3600, 9000);
    expect(simNow(s, 10_000)).toBe(61_000 + 3_600_000);
  });

  it('elige hora y día de la semana en hora de Panamá', () => {
    const t = at(10, 30); // martes
    expect(localParts(t).dow).toBe(1);
    expect(localParts(atHour(t, 15.5)).hour).toBeCloseTo(15.5);
    const sab = atWeekday(t, 5);
    expect(localParts(sab).dow).toBe(5);
    expect(localParts(sab).hour).toBeCloseTo(10.5);
    expect(formatClock(t)).toEqual({ time: '10:30', day: 'martes', date: '3/11' });
  });
});
