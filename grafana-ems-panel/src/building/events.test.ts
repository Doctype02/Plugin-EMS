import { newEvent } from './events';
import { simulate } from './simulator';

const at = (h: number, m = 0, day = 3) => Date.UTC(2026, 10, day, h + 5, m);
const base = { limitKw: 75, demoIncidents: false };

describe('eventos simulados', () => {
  it('incendio: alarma, evacuación y paro de la climatización', () => {
    const ev = newEvent('incendio', at(10), 45, { zone: 'Z03' });
    const s = simulate(at(10, 20), { ...base, events: [ev] });
    expect(s.alarms!.some((a) => a.code === 'INCENDIO')).toBe(true);
    expect(s.ems!.fireAlarm).toBe(true);
    expect(Object.values(s.zones).every((z) => !z.hvacOn)).toBe(true);
    expect(Object.values(s.zones).reduce((a, z) => a + z.occupants, 0)).toBe(0);
    // la zona del incendio se calienta mucho más que una de otra planta (la misma planta recibe humo y calor)
    expect(s.zones.Z03.temp).toBeGreaterThan(s.zones.Z07.temp + 3);
    expect(s.zones.Z02.temp).toBeGreaterThan(s.zones.Z07.temp);
  });

  it('corte de energía: medidor en cero, UPS y luego UPS agotado', () => {
    const ev = newEvent('corte_energia', at(10), 90, { intensity: 30 });
    const a = simulate(at(10, 10), { ...base, events: [ev] });
    expect(a.meter!.pTotal).toBe(0);
    expect(a.meter!.gridOk).toBe(false);
    expect(a.meter!.upsKw).toBeGreaterThan(1);
    expect(a.alarms!.find((x) => x.code === 'EN_UPS')?.zone).toBe('EDIF');
    const b = simulate(at(10, 50), { ...base, events: [ev] });
    expect(b.alarms!.some((x) => x.code === 'UPS_AGOTADO')).toBe(true);
    expect(b.meter!.upsKw).toBeCloseTo(0, 3);
  });

  it('falla de VRF-P1: las oficinas de la planta 1 se calientan; el baño (PTAC) no', () => {
    const ev = newEvent('falla_vrf', at(10), 180, { unit: 'VRF-P1' });
    const ok = simulate(at(12), base);
    const s = simulate(at(12), { ...base, events: [ev] });
    expect(s.zones.Z07.temp).toBeGreaterThan(ok.zones.Z07.temp + 1);
    expect(s.zones.Z11.temp).toBeCloseTo(ok.zones.Z11.temp, 0);
    expect(s.zones.Z02.temp).toBeCloseTo(ok.zones.Z02.temp, 0);
    const alarm = s.alarms!.find((x) => x.code === 'FALLA_VRF');
    expect(alarm?.zone).toBe('VRF-P1');
    expect(alarm?.message).toContain('Z07, Z08, Z09, Z10');
  });

  it('falla de un PTAC: sólo su baño queda sin enfriamiento', () => {
    const ev = newEvent('falla_vrf', at(10), 180, { unit: 'PTAC-P2' });
    const s = simulate(at(12), { ...base, events: [ev] });
    expect(s.zones.Z16.events).toContain('falla_vrf');
    expect(s.zones.Z14.events).toBeUndefined();
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
