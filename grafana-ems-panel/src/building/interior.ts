/**
 * Interior de cada zona para la vista en corte: mobiliario, puestos de las personas, punto de paso
 * (hacia el pasillo/puerta), difusores de aire y luminarias. Todo en metros del plano y determinista.
 */
import { BUILDING, Rect, Zone } from './model';

export type FurnitureKind =
  'desk' | 'table' | 'tableRound' | 'counter' | 'sofa' | 'bench' | 'rack' | 'cabinet' | 'plant' | 'stall' | 'sink';

export interface Furniture {
  kind: FurnitureKind;
  rect: Rect;
  h: number;
}

export interface P2 {
  x: number;
  y: number;
}

export interface Interior {
  furniture: Furniture[];
  seats: P2[];
  hub: P2;
  diffusers: P2[];
  lights: P2[];
}

const M = 1.1; // margen a los muros (se reduce en cuartos pequeños)
const margin = (r: Rect) => Math.min(M, Math.min(r.w, r.d) / 4);

/** Distribuye `n` posiciones a lo largo de [a, b] (centros de celdas iguales). */
function spread(a: number, b: number, n: number): number[] {
  const step = (b - a) / n;
  return Array.from({ length: n }, (_, i) => a + step * (i + 0.5));
}

/** Rejilla de luminarias / difusores según el área. */
function grid(r: Rect, every: number): P2[] {
  const nx = Math.max(1, Math.round(r.w / every));
  const ny = Math.max(1, Math.round(r.d / every));
  return spread(r.x, r.x + r.w, nx).flatMap((x) => spread(r.y, r.y + r.d, ny).map((y) => ({ x, y })));
}

function offices(r: Rect, stepX = 3, stepY = 2.7): Pick<Interior, 'furniture' | 'seats'> {
  const furniture: Furniture[] = [];
  const seats: P2[] = [];
  const cols = Math.max(1, Math.floor((r.w - 2 * M) / stepX));
  const rows = Math.max(1, Math.floor((r.d - 2 * M) / stepY));
  for (const cx of spread(r.x + M, r.x + r.w - M, cols)) {
    for (const cy of spread(r.y + M, r.y + r.d - M, rows)) {
      furniture.push({ kind: 'desk', rect: { x: cx - 0.8, y: cy - 0.1, w: 1.6, d: 0.75 }, h: 0.75 });
      seats.push({ x: cx, y: cy - 0.55 });
    }
  }
  return { furniture, seats };
}

function conference(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const long = r.d >= r.w;
  const tw = long ? Math.min(2.2, r.w * 0.35) : r.w * 0.6;
  const td = long ? r.d * 0.6 : Math.min(2.2, r.d * 0.35);
  const tx = r.x + (r.w - tw) / 2;
  const ty = r.y + (r.d - td) / 2;
  const seats: P2[] = [];
  const n = Math.floor((long ? td : tw) / 1.1);
  for (const s of spread(long ? ty : tx, long ? ty + td : tx + tw, n)) {
    if (long) {
      seats.push({ x: tx - 0.5, y: s }, { x: tx + tw + 0.5, y: s });
    } else {
      seats.push({ x: s, y: ty - 0.5 }, { x: s, y: ty + td + 0.5 });
    }
  }
  return { furniture: [{ kind: 'table', rect: { x: tx, y: ty, w: tw, d: td }, h: 0.75 }], seats };
}

function servers(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const furniture: Furniture[] = [];
  const m = margin(r);
  const long = r.w >= r.d;
  const short = long ? r.d : r.w;
  const rows = short - 2 * m >= 3.2 ? 2 : 1; // cuarto angosto: una sola fila de racks
  const centers =
    rows === 1
      ? [(long ? r.y : r.x) + m + 0.55]
      : spread(long ? r.y + m : r.x + m, long ? r.y + r.d - m : r.x + r.w - m, rows);
  for (const c of centers) {
    const len = (long ? r.w : r.d) - 2 * m;
    const start = (long ? r.x : r.y) + m;
    const n = Math.floor(len / 0.7);
    for (let i = 0; i < n; i++) {
      const s = start + i * 0.7;
      furniture.push({
        kind: 'rack',
        rect: long ? { x: s, y: c - 0.55, w: 0.6, d: 1.1 } : { x: c - 0.55, y: s, w: 1.1, d: 0.6 },
        h: 2.1,
      });
    }
  }
  return { furniture, seats: [{ x: r.x + r.w / 2, y: r.y + r.d - m }] };
}

/** Baños: fila de cubículos contra el muro exterior más largo y lavamanos enfrente. */
function bathroom(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const furniture: Furniture[] = [];
  const long = r.w >= r.d;
  const len = (long ? r.w : r.d) - 1;
  const n = Math.max(1, Math.floor(len / 1.3));
  for (let i = 0; i < n; i++) {
    const s = (long ? r.x : r.y) + 0.5 + i * 1.3;
    furniture.push({
      kind: 'stall',
      rect: long ? { x: s, y: r.y + 0.2, w: 1.15, d: 1.5 } : { x: r.x + 0.2, y: s, w: 1.5, d: 1.15 },
      h: 2.0,
    });
  }
  const sinks = Math.max(1, Math.floor(len / 2.2));
  for (const c of spread((long ? r.x : r.y) + 0.5, (long ? r.x + r.w : r.y + r.d) - 0.5, sinks)) {
    furniture.push({
      kind: 'sink',
      rect: long
        ? { x: c - 0.45, y: r.y + r.d - 0.75, w: 0.9, d: 0.55 }
        : { x: r.x + r.w - 0.75, y: c - 0.45, w: 0.55, d: 0.9 },
      h: 0.85,
    });
  }
  const seats = spread((long ? r.x : r.y) + 1, (long ? r.x + r.w : r.y + r.d) - 1, 3).map((c) =>
    long ? { x: c, y: r.y + r.d * 0.62 } : { x: r.x + r.w * 0.62, y: c }
  );
  return { furniture, seats };
}

/** Oficina abierta: bancadas de escritorios y plantas entre islas. */
function openOffice(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const base = offices(r, 2.1, 2.4);
  const plants: Furniture[] = [0.2, 0.8].map((f) => ({
    kind: 'plant',
    rect: { x: r.x + 0.3, y: r.y + r.d * f - 0.25, w: 0.5, d: 0.5 },
    h: 1.3,
  }));
  return { furniture: [...base.furniture, ...plants], seats: base.seats };
}

function corridor(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const long = r.d >= r.w;
  const plants = [0.12, 0.5, 0.88].map((f) =>
    long
      ? { kind: 'plant' as const, rect: { x: r.x + r.w / 2 - 0.25, y: r.y + r.d * f - 0.25, w: 0.5, d: 0.5 }, h: 1.2 }
      : { kind: 'plant' as const, rect: { x: r.x + r.w * f - 0.25, y: r.y + r.d / 2 - 0.25, w: 0.5, d: 0.5 }, h: 1.2 }
  );
  const seats = spread(long ? r.y + 1 : r.x + 1, long ? r.y + r.d - 1 : r.x + r.w - 1, 6).map((s) =>
    long ? { x: r.x + r.w / 2, y: s } : { x: s, y: r.y + r.d / 2 }
  );
  return { furniture: plants, seats };
}

function reception(r: Rect): Pick<Interior, 'furniture' | 'seats'> {
  const furniture: Furniture[] = [
    { kind: 'counter', rect: { x: r.x + r.w * 0.5, y: r.y + r.d * 0.45, w: 3.2, d: 0.9 }, h: 1.1 },
    { kind: 'sofa', rect: { x: r.x + M, y: r.y + M + 0.5, w: 0.9, d: 2.4 }, h: 0.8 },
    { kind: 'sofa', rect: { x: r.x + M, y: r.y + r.d - M - 2.9, w: 0.9, d: 2.4 }, h: 0.8 },
    { kind: 'plant', rect: { x: r.x + r.w - M - 0.6, y: r.y + M, w: 0.6, d: 0.6 }, h: 1.4 },
    { kind: 'plant', rect: { x: r.x + r.w - M - 0.6, y: r.y + r.d - M - 0.6, w: 0.6, d: 0.6 }, h: 1.4 },
  ];
  const seats: P2[] = [
    { x: r.x + r.w * 0.5 + 1.6, y: r.y + r.d * 0.45 + 1.3 },
    ...spread(r.y + M + 0.5, r.y + M + 2.9, 2).map((y) => ({ x: r.x + M + 1.3, y })),
    ...spread(r.x + 2.5, r.x + r.w - 2.5, 3).map((x) => ({ x, y: r.y + r.d * 0.25 })),
  ];
  return { furniture, seats };
}

/** Punto de paso: el lado de la zona más cercano al centro del edificio (pasillo o núcleo). */
function hubOf(r: Rect): P2 {
  const cx = BUILDING.width / 2;
  const cy = BUILDING.depth / 2;
  const x = Math.min(Math.max(cx, r.x + M), r.x + r.w - M);
  const y = Math.min(Math.max(cy, r.y + M), r.y + r.d - M);
  return { x, y };
}

const CACHE = new Map<string, Interior>();

export function interiorOf(zone: Zone): Interior {
  const hit = CACHE.get(zone.id);
  if (hit) {
    return hit;
  }
  const r = zone.rect;
  const base =
    zone.type === 'oficina'
      ? offices(r, 2.2, 2.5)
      : zone.type === 'cubiculos'
        ? offices(r, 2.2, 2.0)
        : zone.type === 'conferencia'
          ? conference(r)
          : zone.type === 'servidores'
            ? servers(r)
            : zone.type === 'bano'
              ? bathroom(r)
              : zone.type === 'oficina_abierta'
                ? openOffice(r)
                : zone.type === 'pasillo'
                  ? corridor(r)
                  : reception(r);
  const nDiff = Math.min(4, Math.max(1, Math.round(zone.area / 90)));
  const long = r.w >= r.d;
  const diffusers = spread(long ? r.x : r.y, long ? r.x + r.w : r.y + r.d, nDiff).map((s) =>
    long ? { x: s, y: r.y + r.d / 2 } : { x: r.x + r.w / 2, y: s }
  );
  const result: Interior = { ...base, hub: hubOf(r), diffusers, lights: zone.rects.flatMap((p) => grid(p, 5)) };
  CACHE.set(zone.id, result);
  return result;
}

/** Bordes de la zona y si cada uno es fachada exterior. */
export function edgesOf(r: Rect): Array<{ side: 'n' | 's' | 'e' | 'w'; a: P2; b: P2; exterior: boolean }> {
  const eps = 0.01;
  return [
    { side: 's', a: { x: r.x, y: r.y }, b: { x: r.x + r.w, y: r.y }, exterior: r.y < eps },
    {
      side: 'e',
      a: { x: r.x + r.w, y: r.y },
      b: { x: r.x + r.w, y: r.y + r.d },
      exterior: r.x + r.w > BUILDING.width - eps,
    },
    {
      side: 'n',
      a: { x: r.x + r.w, y: r.y + r.d },
      b: { x: r.x, y: r.y + r.d },
      exterior: r.y + r.d > BUILDING.depth - eps,
    },
    { side: 'w', a: { x: r.x, y: r.y + r.d }, b: { x: r.x, y: r.y }, exterior: r.x < eps },
  ];
}

export interface ZoneEdge {
  side: 'n' | 's' | 'e' | 'w';
  a: P2;
  b: P2;
  exterior: boolean;
  /** Parte de la zona a la que pertenece el borde. */
  part: Rect;
}

/** Resta de intervalos [a0, a1] − cortes (todos sobre la misma recta). */
function subtract(a0: number, a1: number, cuts: Array<[number, number]>): Array<[number, number]> {
  let out: Array<[number, number]> = [[Math.min(a0, a1), Math.max(a0, a1)]];
  for (const [c0, c1] of cuts) {
    out = out.flatMap(([s, e]) => {
      if (c1 <= s || c0 >= e) {
        return [[s, e] as [number, number]];
      }
      const keep: Array<[number, number]> = [];
      if (c0 > s) {
        keep.push([s, c0]);
      }
      if (c1 < e) {
        keep.push([c1, e]);
      }
      return keep;
    });
  }
  return out.filter(([s, e]) => e - s > 0.01);
}

/**
 * Contorno de una zona de una o varias partes: los bordes de cada parte menos los tramos compartidos con
 * otra parte de la misma zona (p. ej. la sala de conferencias en L no tiene muro entre sus dos partes).
 */
export function zoneEdges(zone: Pick<Zone, 'rects'>): ZoneEdge[] {
  const parts = zone.rects;
  const out: ZoneEdge[] = [];
  const eps = 0.01;
  parts.forEach((r, i) => {
    const others = parts.filter((_, j) => j !== i);
    for (const e of edgesOf(r)) {
      const vertical = e.side === 'e' || e.side === 'w';
      const line = vertical ? e.a.x : e.a.y;
      const cuts: Array<[number, number]> = [];
      for (const o of others) {
        const oe = edgesOf(o).find((x) => {
          const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[e.side];
          return x.side === opp && Math.abs((vertical ? x.a.x : x.a.y) - line) < eps;
        });
        if (oe) {
          cuts.push(
            vertical
              ? [Math.min(oe.a.y, oe.b.y), Math.max(oe.a.y, oe.b.y)]
              : [Math.min(oe.a.x, oe.b.x), Math.max(oe.a.x, oe.b.x)]
          );
        }
      }
      const a0 = vertical ? e.a.y : e.a.x;
      const a1 = vertical ? e.b.y : e.b.x;
      const reversed = a0 > a1;
      for (const [s0, s1] of subtract(a0, a1, cuts)) {
        const [p, q] = reversed ? [s1, s0] : [s0, s1];
        out.push({
          side: e.side,
          a: vertical ? { x: line, y: p } : { x: p, y: line },
          b: vertical ? { x: line, y: q } : { x: q, y: line },
          exterior: e.exterior,
          part: r,
        });
      }
    }
  });
  return out;
}
