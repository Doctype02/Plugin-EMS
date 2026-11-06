import { newEvent } from './events';
import { simulate } from './simulator';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const base = { limitKw: 30, demoIncidents: false };

describe('eventos simulados', () => {
  it('incendio: alarma, evacuación y paro de la climatización', () => {
    const ev = newEvent('incendio', at(10), 45, { zone: 'Z03' });
    const s = simulate(at(10, 20), { ...base, events: [ev] });
    expect(s.alarms!.some((a) => a.code === 'INCENDIO')).toBe(true);
    expect(s.ems!.fireAlarm).toBe(true);
    expect(Object.values(s.zones).every((z) => !z.hvacOn)).toBe(true);
    expect(Object.values(s.zones).reduce((a, z) => a + z.occupants, 0)).toBe(0);
    expect(s.zones.Z03.temp).toBeGreaterThan(s.zones.Z02.temp + 3);
  });

  it('corte de energía: medidor en cero, UPS y luego UPS agotado', () => {
    const ev = newEvent('corte_energia', at(10), 90, { intensity: 30 });
    const a = simulate(at(10, 10), { ...base, events: [ev] });
    expect(a.meter!.pTotal).toBe(0);
    expect(a.meter!.gridOk).toBe(false);
    expect(a.meter!.upsKw).toBeGreaterThan(1);
    expect(a.alarms!.some((x) => x.code === 'EN_UPS')).toBe(true);
    const b = simulate(at(10, 50), { ...base, events: [ev] });
    expect(b.alarms!.some((x) => x.code === 'UPS_AGOTADO')).toBe(true);
    expect(b.meter!.upsKw).toBeCloseTo(0, 3);
  });

  it('falla de VRF-A: las oficinas de la planta alta se calientan', () => {
    const ev = newEvent('falla_vrf', at(10), 180, { unit: 'VRF-A' });
    const ok = simulate(at(12), base);
    const s = simulate(at(12), { ...base, events: [ev] });
    expect(s.zones.Z04.temp).toBeGreaterThan(ok.zones.Z04.temp + 2);
    expect(s.zones.Z02.temp).toBeCloseTo(ok.zones.Z02.temp, 0);
    expect(s.alarms!.some((x) => x.code === 'FALLA_VRF')).toBe(true);
  });

  it('ola de calor y puerta abierta aumentan el consumo de HVAC', () => {
    const ok = simulate(at(14), base);
    const calor = simulate(at(14), { ...base, events: [newEvent('ola_calor', at(8), 600, { intensity: 6 })] });
    expect(calor.meter!.tExt).toBeGreaterThan(ok.meter!.tExt + 5);
    const puerta = simulate(at(14), {
      ...base,
      events: [newEvent('puerta_abierta', at(13), 120, { zone: 'Z03', intensity: 100 })],
    });
    expect(puerta.zones.Z03.temp).toBeGreaterThan(ok.zones.Z03.temp);
  });
});
