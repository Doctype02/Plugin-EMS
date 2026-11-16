/**
 * Encuadre de la escena y resumen por planta (lógica pura, sin React).
 *
 * El SVG de la escena se dibuja en unidades isométricas (iso.scale por metro). Para que la planta elegida
 * ocupe el área disponible sin recortarse y los rótulos tengan siempre el mismo tamaño en pantalla, el
 * viewBox se calcula con el tamaño real del área (px) y márgenes en px reservados para los controles que
 * flotan sobre la escena (barra de herramientas arriba, leyenda abajo).
 */
import { FLOORS, VRF_UNITS, ZONES, Zone } from './model';
import { EmsAlarm, Snapshot, Status } from './telemetry';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Fit {
  /** viewBox que llena exactamente el área de w × h px. */
  viewBox: Box;
  /** px de pantalla por unidad del SVG. */
  k: number;
}

/**
 * Ajusta la geometría `geom` (unidades) al área de `px` con márgenes en px. Devuelve un viewBox con la
 * misma proporción que el área (sin bandas de `meet`), centrado en el espacio libre, y la escala k.
 * `maxK` evita que una planta sola se amplíe sin límite en pantallas enormes.
 */
export function fitView(geom: Box, px: { w: number; h: number }, pad: Insets, maxK = 6): Fit {
  const W = Math.max(px.w, 1);
  const H = Math.max(px.h, 1);
  const freeW = Math.max(W - pad.left - pad.right, W * 0.35);
  const freeH = Math.max(H - pad.top - pad.bottom, H * 0.35);
  const k = Math.max(0.05, Math.min(freeW / Math.max(geom.w, 1e-6), freeH / Math.max(geom.h, 1e-6), maxK));
  // centro de la geometría alineado con el centro del espacio libre
  const cxPx = pad.left + freeW / 2;
  const cyPx = pad.top + freeH / 2;
  const x = geom.x + geom.w / 2 - cxPx / k;
  const y = geom.y + geom.h / 2 - cyPx / k;
  return { viewBox: { x, y, w: W / k, h: H / k }, k };
}

/** Une cajas (unidades). */
export function union(...boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface LabelBox {
  id: string;
  /** Centro horizontal y vertical del rótulo. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Desencima rótulos: recorre de arriba hacia abajo y, si uno choca con otro ya colocado, lo baja justo
 * debajo. Devuelve el desplazamiento vertical de cada rótulo (misma unidad que las cajas).
 */
export function declutter(boxes: LabelBox[], gap = 2): Record<string, number> {
  const out: Record<string, number> = {};
  const placed: LabelBox[] = [];
  for (const b of [...boxes].sort((a, c) => a.y - c.y || a.x - c.x)) {
    let y = b.y;
    for (let guard = 0; guard < 12; guard++) {
      // tolerancia: tras bajar un rótulo justo al borde del otro, el redondeo no debe contarlo como choque
      const eps = 1e-6 * (1 + Math.abs(y));
      const hit = placed.find(
        (p) => Math.abs(p.x - b.x) < (p.w + b.w) / 2 + gap - eps && Math.abs(p.y - y) < (p.h + b.h) / 2 + gap / 2 - eps
      );
      if (!hit) {
        break;
      }
      y = hit.y + (hit.h + b.h) / 2 + gap / 2;
    }
    out[b.id] = y - b.y;
    placed.push({ ...b, y });
  }
  return out;
}

export interface LabelOffset {
  dx: number;
  dy: number;
}

const overlap = (a: LabelBox, b: LabelBox, gap: number) =>
  Math.max(0, (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x)) * Math.max(0, (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y));

/**
 * Coloca rótulos sin solaparse: cada uno se queda en su ancla si cabe; si no, prueba desplazamientos en
 * una rejilla alrededor (arriba/abajo primero, luego a los lados y en diagonal) y elige el más cercano
 * libre de choques y dentro de `bounds`. Si ninguno queda libre, el de menor solape. El orden de entrada
 * es la prioridad (los primeros no se mueven). Devuelve el desplazamiento de cada rótulo (mismas unidades).
 */
export function placeLabels(
  boxes: LabelBox[],
  opts: { gap?: number; bounds?: Box; obstacles?: LabelBox[]; maxSteps?: number } = {}
): Record<string, LabelOffset> {
  const gap = opts.gap ?? 2;
  const steps = opts.maxSteps ?? 3;
  const placed: LabelBox[] = [...(opts.obstacles ?? [])];
  const out: Record<string, LabelOffset> = {};
  const inside = (b: LabelBox) =>
    !opts.bounds ||
    (b.x - b.w / 2 >= opts.bounds.x &&
      b.x + b.w / 2 <= opts.bounds.x + opts.bounds.w &&
      b.y - b.h / 2 >= opts.bounds.y &&
      b.y + b.h / 2 <= opts.bounds.y + opts.bounds.h);
  for (const b of boxes) {
    const cands: LabelOffset[] = [];
    for (let ky = -steps; ky <= steps; ky++) {
      for (let kx = -2; kx <= 2; kx++) {
        cands.push({ dx: kx * (b.w / 2 + gap), dy: ky * (b.h + gap) });
      }
    }
    cands.sort((p, q) => Math.hypot(p.dx * 0.8, p.dy) - Math.hypot(q.dx * 0.8, q.dy));
    let best: { off: LabelOffset; cost: number } | undefined;
    for (const off of cands) {
      const c = { ...b, x: b.x + off.dx, y: b.y + off.dy };
      const hit = placed.reduce((a, p) => a + overlap(p, c, gap - 1e-6), 0);
      const cost = hit + (inside(c) ? 0 : 1e9);
      if (cost === 0) {
        best = { off, cost };
        break;
      }
      if (!best || cost < best.cost) {
        best = { off, cost };
      }
    }
    const off = best!.off;
    out[b.id] = off;
    placed.push({ ...b, x: b.x + off.dx, y: b.y + off.dy });
  }
  return out;
}

const SEVERITY: Record<Status, number> = { critical: 3, warning: 2, ok: 1, offline: 0 };

/** Peor estado de un conjunto (crítico > alerta > normal > sin datos). */
export function worstStatus(list: Status[]): Status {
  return list.reduce<Status>((a, s) => (SEVERITY[s] > SEVERITY[a] ? s : a), 'offline');
}

export interface LevelSummary {
  /** Nivel (0 = PB) o 'roof'. */
  key: number | 'roof';
  short: string;
  name: string;
  status: Status;
  /** Temperatura media de las zonas con dato (°C). */
  temp?: number;
  /** Potencia de la planta (kW): zonas; en la azotea, potencia de las VRF. */
  kw: number;
  crit: number;
  warn: number;
  zones: number;
  /** Generación FV (sólo azotea, kW). */
  pv?: number;
  /** Personas en la planta y aforo de diseño (no en la azotea). */
  people?: number;
  capacity?: number;
}

/** Personas actuales y aforo de un conjunto de zonas (por defecto, todo el edificio). */
export function occupancyOf(
  snapshot: Snapshot,
  zones: Zone[] = ZONES
): { people: number; capacity: number; pct: number; known: boolean } {
  let people = 0;
  let known = false;
  for (const z of zones) {
    const n = snapshot.zones[z.id]?.occupants;
    if (Number.isFinite(n)) {
      people += n as number;
      known = true;
    }
  }
  const capacity = zones.reduce((a, z) => a + z.occupants, 0);
  return { people, capacity, pct: capacity > 0 ? (100 * people) / capacity : 0, known };
}

const alarmCounts = (alarms: EmsAlarm[], zoneIds: Set<string>) => ({
  crit: alarms.filter((a) => a.level === 'crit' && zoneIds.has(a.zone)).length,
  warn: alarms.filter((a) => a.level === 'warn' && zoneIds.has(a.zone)).length,
});

/** Resumen de una planta: peor estado, temperatura media, kW y alarmas. */
export function floorSummary(level: number, snapshot: Snapshot, statuses: Record<string, Status>): LevelSummary {
  const floor = FLOORS.find((f) => f.level === level) ?? FLOORS[0];
  const zones = ZONES.filter((z) => z.floor === level);
  const states = zones.map((z) => snapshot.zones[z.id]).filter((s) => s && Number.isFinite(s.temp));
  const ids = new Set(zones.map((z) => z.id));
  return {
    key: level,
    short: floor.short,
    name: floor.name,
    status: worstStatus(zones.map((z) => statuses[z.id] ?? 'offline')),
    temp: states.length ? states.reduce((a, s) => a + s.temp, 0) / states.length : undefined,
    kw: states.reduce((a, s) => a + (Number.isFinite(s.pTotal) ? s.pTotal : 0), 0),
    zones: zones.length,
    ...alarmCounts(snapshot.alarms, ids),
    ...(() => {
      const o = occupancyOf(snapshot, zones);
      return { people: o.known ? o.people : undefined, capacity: o.capacity };
    })(),
  };
}

/** Resumen de la azotea: estado de las zonas que atienden las VRF, kW de los compresores y FV. */
export function roofSummary(snapshot: Snapshot, statuses: Record<string, Status>): LevelSummary {
  const served = VRF_UNITS.flatMap((u) => u.zones);
  const failing = served.some((id) => snapshot.zones[id]?.events?.includes('falla_vrf'));
  const kw = served.reduce((a, id) => {
    const s = snapshot.zones[id];
    return a + (s?.hvacOn && Number.isFinite(s.pHvac) ? s.pHvac : 0);
  }, 0);
  const any = served.some((id) => snapshot.zones[id] && Number.isFinite(snapshot.zones[id].temp));
  const ids = new Set(VRF_UNITS.map((u) => u.id));
  return {
    key: 'roof',
    short: 'AZ',
    name: 'Azotea',
    status: !any ? 'offline' : failing ? 'critical' : 'ok',
    kw,
    pv: snapshot.meter?.pPv,
    zones: VRF_UNITS.length,
    ...alarmCounts(snapshot.alarms, ids),
  };
}

/**
 * Planta que se muestra al abrir el panel: la de la alarma más grave (crítica, luego alerta); sin
 * alarmas, la planta baja.
 */
export function autoFloor(statuses: Record<string, Status>, snapshot?: Snapshot): number {
  const byLevel = (pred: (z: Zone) => boolean) => ZONES.find(pred)?.floor;
  const crit = snapshot?.alarms.find((a) => a.level === 'crit' && ZONES.some((z) => z.id === a.zone));
  if (crit) {
    return ZONES.find((z) => z.id === crit.zone)!.floor;
  }
  return (
    byLevel((z) => statuses[z.id] === 'critical') ?? byLevel((z) => statuses[z.id] === 'warning') ?? FLOORS[0].level
  );
}

/** Nombre corto de la zona para el rótulo (sin el sufijo de planta). */
export function shortZoneName(zone: Zone): string {
  const n = zone.name.replace(/\s+(PB|P\d)$/u, '');
  const map: Record<string, string> = {
    'Cuarto de servidores': 'Servidores',
    'Sala de conferencias': 'Conferencias',
    'Oficina abierta': 'Of. abierta',
  };
  return map[n] ?? n;
}
