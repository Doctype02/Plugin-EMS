/**
 * Proyección isométrica del edificio (SVG, sin dependencias 3D).
 *
 * El plano (x este, y norte, z arriba, en metros) se rota alrededor del centro en pasos de 90° y se
 * proyecta con ejes isométricos de 30°. Como todas las cajas quedan alineadas con los ejes rotados,
 * las caras visibles son siempre las de x' máximo y y' mínimo, y el orden de pintado (de atrás hacia
 * adelante) es por piso y luego por profundidad del centro.
 */
import { BUILDING, Rect } from './model';

export type Azimuth = 0 | 90 | 180 | 270;

export interface IsoConfig {
  azimuth: Azimuth;
  /**
   * `stacked`: pisos apilados como el edificio real (vista exterior).
   * `exploded`: axonometría escalonada — cada nivel se desplaza hacia el fondo y hacia arriba para
   * que su planta quede completamente visible.
   */
  layout: 'stacked' | 'exploded';
  scale: number;
}

/** Separación horizontal entre niveles en la vista explotada (m). */
export const EXPLODE_GAP = 4;

export interface Pt {
  x: number;
  y: number;
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

/** Rota un punto del plano alrededor del centro del edificio. */
export function rotate(x: number, y: number, az: Azimuth): Pt {
  const cx = BUILDING.width / 2;
  const cy = BUILDING.depth / 2;
  const dx = x - cx;
  const dy = y - cy;
  switch (az) {
    case 90:
      return { x: -dy, y: dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: dy, y: -dx };
    default:
      return { x: dx, y: dy };
  }
}

/** Plano rotado (x', y') + altura z → pantalla. y' crece hacia el fondo (norte en azimut 0). */
export function project(xr: number, yr: number, z: number, scale: number): Pt {
  return { x: (xr + yr) * COS30 * scale, y: (yr - xr) * SIN30 * scale * -1 - z * scale };
}

/** Extensión del edificio en el eje y' (fondo) según la orientación. */
export function depthSpan(az: Azimuth): number {
  return az === 90 || az === 270 ? BUILDING.width : BUILDING.depth;
}

/** Posición de un nivel: altura z y desplazamiento hacia el fondo dy (en ejes rotados). */
export function placement(level: number, cfg: IsoConfig): { z: number; dy: number } {
  if (cfg.layout === 'exploded') {
    return { z: level * BUILDING.floorHeight * 0.9, dy: level * (depthSpan(cfg.azimuth) + EXPLODE_GAP) };
  }
  return { z: level * BUILDING.floorHeight, dy: 0 };
}

export interface Prism {
  top: Pt[];
  /** Caras laterales visibles (frente y costado) en orden de pintado. */
  sides: Array<{ points: Pt[]; facing: 'front' | 'side'; edge: 'n' | 's' | 'e' | 'w' }>;
  center: Pt;
  depth: number;
}

/** Lado cardinal del rectángulo original que queda en cada borde del rectángulo rotado. */
function cardinal(face: 'xmax' | 'ymin', az: Azimuth): 'n' | 's' | 'e' | 'w' {
  const order: Array<'e' | 'n' | 'w' | 's'> = ['e', 'n', 'w', 's'];
  const base = face === 'xmax' ? 0 : 3; // azimut 0: x'max = este, y'min = sur
  return order[(base - az / 90 + 4) % 4];
}

export function prism(rect: Rect, z0: number, height: number, cfg: IsoConfig, inset = 0, dy = 0): Prism {
  const corners = [
    rotate(rect.x + inset, rect.y + inset, cfg.azimuth),
    rotate(rect.x + rect.w - inset, rect.y + inset, cfg.azimuth),
    rotate(rect.x + rect.w - inset, rect.y + rect.d - inset, cfg.azimuth),
    rotate(rect.x + inset, rect.y + rect.d - inset, cfg.azimuth),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys) + dy;
  const y1 = Math.max(...ys) + dy;
  const s = cfg.scale;
  const z1 = z0 + height;
  const P = (x: number, y: number, z: number) => project(x, y, z, s);
  const top = [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
  const front = [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)];
  const side = [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)];
  return {
    top,
    sides: [
      { points: front, facing: 'front', edge: cardinal('ymin', cfg.azimuth) },
      { points: side, facing: 'side', edge: cardinal('xmax', cfg.azimuth) },
    ],
    center: P((x0 + x1) / 2, (y0 + y1) / 2, z1),
    // más adelante = y' menor y x' mayor
    depth: (y0 + y1) / 2 - (x0 + x1) / 2,
  };
}

export const path = (pts: Pt[]) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z`;

/** Caja que encierra los niveles 0…levels−1 proyectados (para el viewBox del SVG). */
export function bounds(
  cfg: IsoConfig,
  levels: number,
  extraHeight = 2
): { x: number; y: number; w: number; h: number } {
  const all: Pt[] = [];
  for (let level = 0; level < levels; level++) {
    const { z, dy } = placement(level, cfg);
    for (const [x, y] of [
      [0, 0],
      [BUILDING.width, 0],
      [BUILDING.width, BUILDING.depth],
      [0, BUILDING.depth],
    ]) {
      const r = rotate(x, y, cfg.azimuth);
      all.push(
        project(r.x, r.y + dy, z, cfg.scale),
        project(r.x, r.y + dy, z + BUILDING.floorHeight + extraHeight, cfg.scale)
      );
    }
  }
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const pad = cfg.scale * 2.5;
  return {
    x: Math.min(...xs) - pad - cfg.scale * 9, // margen izquierdo para los rótulos de piso
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + 2 * pad + cfg.scale * 9,
    h: Math.max(...ys) - Math.min(...ys) + 2 * pad,
  };
}

/** Puntos interpolados sobre la cara superior (u, v ∈ [0, 1]) para dibujar íconos y personas. */
export function onTop(p: Prism, u: number, v: number): Pt {
  const [a, b, , d] = p.top;
  return { x: a.x + (b.x - a.x) * u + (d.x - a.x) * v, y: a.y + (b.y - a.y) * u + (d.y - a.y) * v };
}

/** Proyecta un punto del plano (x, y en metros) a altura z, con el desplazamiento dy del nivel. */
export function toScreen(x: number, y: number, z: number, cfg: IsoConfig, dy = 0): Pt {
  const r = rotate(x, y, cfg.azimuth);
  return project(r.x, r.y + dy, z, cfg.scale);
}

/**
 * Matriz SVG que lleva coordenadas del plano (metros) a la pantalla sobre un plano horizontal a
 * altura z. Permite dibujar círculos, aspas o halos "acostados" que rotan correctamente.
 */
export function planeMatrix(z: number, cfg: IsoConfig, dy = 0): string {
  const o = toScreen(0, 0, z, cfg, dy);
  const ex = toScreen(1, 0, z, cfg, dy);
  const ey = toScreen(0, 1, z, cfg, dy);
  const f = (n: number) => n.toFixed(4);
  return `matrix(${f(ex.x - o.x)} ${f(ex.y - o.y)} ${f(ey.x - o.x)} ${f(ey.y - o.y)} ${f(o.x)} ${f(o.y)})`;
}

/** Profundidad de un punto del plano (mayor = más al fondo) para ordenar objetos sueltos. */
export function pointDepth(x: number, y: number, cfg: IsoConfig, dy = 0): number {
  const r = rotate(x, y, cfg.azimuth);
  return r.y + dy - r.x;
}

/** Cuadrilátero vertical sobre el segmento a→b del plano, entre z0 y z1. */
export function wallQuad(
  a: { x: number; y: number },
  b: { x: number; y: number },
  z0: number,
  z1: number,
  cfg: IsoConfig,
  dy = 0
): Pt[] {
  return [
    toScreen(a.x, a.y, z0, cfg, dy),
    toScreen(b.x, b.y, z0, cfg, dy),
    toScreen(b.x, b.y, z1, cfg, dy),
    toScreen(a.x, a.y, z1, cfg, dy),
  ];
}
