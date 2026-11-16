import {
  autoFloor,
  declutter,
  fitView,
  floorSummary,
  occupancyOf,
  roofSummary,
  shortZoneName,
  worstStatus,
} from './layout';
import { FLOORS, ZONES, ZONE_BY_ID } from './model';
import { simulate } from './simulator';
import { Status, zoneStatuses } from './telemetry';

const allOk = (): Record<string, Status> => Object.fromEntries(ZONES.map((z) => [z.id, 'ok' as Status]));

describe('encuadre de la escena', () => {
  it('llena el área con la misma proporción y respeta los márgenes', () => {
    const geom = { x: -100, y: -50, w: 400, h: 200 };
    const px = { w: 1000, h: 600 };
    const pad = { top: 60, right: 10, bottom: 40, left: 10 };
    const { viewBox, k } = fitView(geom, px, pad);
    expect(viewBox.w / viewBox.h).toBeCloseTo(px.w / px.h);
    // limitado por el ancho libre (980 px / 400)
    expect(k).toBeCloseTo(980 / 400);
    // la geometría queda dentro del área libre (en px)
    const toPx = (x: number, y: number) => ({ x: (x - viewBox.x) * k, y: (y - viewBox.y) * k });
    const a = toPx(geom.x, geom.y);
    const b = toPx(geom.x + geom.w, geom.y + geom.h);
    expect(a.x).toBeGreaterThanOrEqual(pad.left - 0.01);
    expect(a.y).toBeGreaterThanOrEqual(pad.top - 0.01);
    expect(b.x).toBeLessThanOrEqual(px.w - pad.right + 0.01);
    expect(b.y).toBeLessThanOrEqual(px.h - pad.bottom + 0.01);
  });

  it('no amplía más allá de maxK', () => {
    expect(
      fitView({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 1000 }, { top: 0, right: 0, bottom: 0, left: 0 }, 3).k
    ).toBe(3);
  });
});

describe('rótulos sin encimarse', () => {
  it('baja los rótulos que chocan y deja los demás en su sitio', () => {
    const off = declutter([
      { id: 'a', x: 0, y: 0, w: 100, h: 20 },
      { id: 'b', x: 10, y: 5, w: 100, h: 20 },
      { id: 'c', x: 500, y: 5, w: 100, h: 20 },
    ]);
    expect(off.a).toBe(0);
    expect(off.c).toBe(0);
    expect(off.b).toBeGreaterThanOrEqual(15);
  });

  it('en cascada ninguna pareja queda encimada (también con escalas no enteras)', () => {
    for (const k of [1, 2.412360149174214, 0.37]) {
      const boxes = Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        x: 0,
        y: (-214 + i * 41) * k,
        w: 150 * k,
        h: 24 * k,
      }));
      const off = declutter(boxes, 3 * k);
      const ys = boxes.map((b) => b.y + off[b.id]).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(24 * k - 1e-6);
      }
    }
  });
});

describe('resumen por planta', () => {
  const snap = simulate(Date.parse('2026-11-04T15:00:00Z'), {
    limitKw: 75,
    spOccupied: 24,
    overrides: {},
    events: [],
    demoIncidents: false,
    occupancy: {},
    pv: true,
    controller: 'reglas_dr',
  });

  it('agrega temperatura, kW y peor estado de cada planta', () => {
    const st = { ...allOk(), Z14: 'warning' as Status };
    const p2 = floorSummary(2, snap, st);
    expect(p2.short).toBe('P2');
    expect(p2.status).toBe('warning');
    expect(p2.zones).toBe(ZONES.filter((z) => z.floor === 2).length);
    expect(p2.temp).toBeGreaterThan(15);
    const kw = ZONES.filter((z) => z.floor === 2).reduce((a, z) => a + snap.zones[z.id].pTotal, 0);
    expect(p2.kw).toBeCloseTo(kw);
    expect(floorSummary(0, snap, st).status).toBe('ok');
  });

  it('la azotea suma la potencia de las VRF y lleva la FV', () => {
    const roof = roofSummary(snap, zoneStatuses(snap));
    expect(roof.key).toBe('roof');
    expect(roof.kw).toBeGreaterThanOrEqual(0);
    expect(roof.pv).toBe(snap.meter?.pPv);
  });

  it('elige la planta de la alarma más grave (sin alarmas, PB)', () => {
    expect(autoFloor(allOk())).toBe(FLOORS[0].level);
    expect(autoFloor({ ...allOk(), Z18: 'warning' })).toBe(ZONE_BY_ID.Z18.floor);
    expect(autoFloor({ ...allOk(), Z18: 'warning', Z09: 'critical' })).toBe(ZONE_BY_ID.Z09.floor);
  });

  it('peor estado: crítico > alerta > normal > sin datos', () => {
    expect(worstStatus(['ok', 'offline', 'warning'])).toBe('warning');
    expect(worstStatus(['ok', 'critical'])).toBe('critical');
    expect(worstStatus([])).toBe('offline');
  });

  it('nombre corto sin el sufijo de planta', () => {
    expect(shortZoneName(ZONE_BY_ID.Z07)).toBe('Oficina 1');
    expect(shortZoneName(ZONE_BY_ID.Z06)).toBe('Servidores');
    expect(shortZoneName(ZONE_BY_ID.Z10)).toBe('Pasillo');
  });
});

describe('ocupación por planta', () => {
  const at = (h: number) => Date.UTC(2026, 10, 3, h + 5, 0);

  it('suma las personas de las zonas de cada planta frente a su aforo', () => {
    const snap = simulate(at(11), { limitKw: 170, demoIncidents: false });
    const st = zoneStatuses(snap);
    let total = 0;
    for (const f of FLOORS) {
      const s = floorSummary(f.level, snap, st);
      const zs = ZONES.filter((z) => z.floor === f.level);
      expect(s.capacity).toBe(zs.reduce((a, z) => a + z.occupants, 0));
      expect(s.people).toBe(zs.reduce((a, z) => a + snap.zones[z.id].occupants, 0));
      total += s.people!;
    }
    const b = occupancyOf(snap);
    expect(b.known).toBe(true);
    expect(b.people).toBe(total);
    expect(b.capacity).toBe(ZONES.reduce((a, z) => a + z.occupants, 0));
    expect(b.pct).toBeCloseTo((100 * total) / b.capacity);
    // la azotea no tiene personas
    expect(roofSummary(snap, st).people).toBeUndefined();
  });

  it('refleja la ocupación forzada y queda sin dato si no hay telemetría', () => {
    const occ = { Z09: { people: 30, since: at(0), until: at(23) } };
    const snap = simulate(at(11), { limitKw: 170, demoIncidents: false, occupancy: occ });
    const p1 = floorSummary(1, snap, zoneStatuses(snap));
    const sinZ09 = ZONES.filter((z) => z.floor === 1 && z.id !== 'Z09').reduce(
      (a, z) => a + snap.zones[z.id].occupants,
      0
    );
    expect(p1.people).toBe(sinZ09 + 30);
    const empty = { time: 0, zones: {}, alarms: [] };
    expect(floorSummary(1, empty, {}).people).toBeUndefined();
    expect(occupancyOf(empty).known).toBe(false);
  });
});
