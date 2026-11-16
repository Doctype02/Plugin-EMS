/**
 * Materiales y luz de la escena isométrica (lógica pura, sin React).
 *
 * Luz direccional única, fija respecto a la cámara (arriba a la izquierda): la cara superior recibe la
 * luz plena, la cara frontal (y' mínimo, a la izquierda en pantalla) queda en media luz y la cara lateral
 * (x' máximo, a la derecha) en sombra. Como todas las cajas usan las mismas tres caras visibles en
 * cualquier azimut, el sombreado es coherente en toda la escena.
 *
 * La paleta de la arquitectura es neutra y desaturada en los dos temas; el color fuerte se reserva para
 * los datos (estado, capas) y los indicadores de los equipos.
 */
import { ZoneType } from './model';

export type Face = 'top' | 'front' | 'side';

/** Factor de luz por cara (1 = color base). */
export const LIGHT: Record<Face, number> = { top: 1, front: 0.86, side: 0.7 };

function parseHex(c: string): [number, number, number] {
  let h = c.trim().replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((x) => x + x)
      .join('');
  }
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

/** Multiplica el color por un factor de luz (0–1.3). Sólo acepta #rgb / #rrggbb. */
export function lit(color: string, factor: number): string {
  return toHex(parseHex(color).map((v) => v * factor));
}

/** Color de una cara con la luz de la escena. */
export function faceColor(color: string, face: Face): string {
  return face === 'top' ? color : lit(color, LIGHT[face]);
}

/** Mezcla dos colores #rrggbb (t = peso del primero). */
export function blend(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(ca.map((v, i) => v * t + cb[i] * (1 - t)));
}

/** Luminancia relativa aproximada (0–1), para elegir tinta clara u oscura sobre un color. */
export function luminance(color: string): number {
  const [r, g, b] = parseHex(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface Materials {
  dark: boolean;
  /** Fondo: degradado vertical y terreno. */
  skyTop: string;
  skyBottom: string;
  ground: string;
  groundEdge: string;
  /** Losa de hormigón (cara superior y canto). */
  slab: string;
  slabEdge: string;
  /** Muros (yeso / panel) y su remate superior. */
  wall: string;
  wallCap: string;
  /** Fachada exterior (vista de volumen). */
  facade: string;
  /** Vidrio: tinte, reflejo y carpintería. */
  glass: string;
  glassHi: string;
  mullion: string;
  /** Mobiliario. */
  deskTop: string;
  deskBase: string;
  chair: string;
  screen: string;
  screenOn: string;
  fabric: string;
  wood: string;
  stone: string;
  porcelain: string;
  partition: string;
  rack: string;
  rackDoor: string;
  pot: string;
  leaf: string;
  leafHi: string;
  /** Equipos HVAC (carcasa blanca) y metal. */
  casing: string;
  metal: string;
  /** Azotea: membrana, parapeto. */
  membrane: string;
  parapet: string;
  /** Sombra ambiental (siempre negro con opacidad). */
  aoOpacity: number;
  shadowOpacity: number;
}

const LIGHT_THEME: Materials = {
  dark: false,
  skyTop: '#eef1f5',
  skyBottom: '#f8f9fb',
  ground: '#e4e7eb',
  groundEdge: '#d3d8de',
  slab: '#c9cdd3',
  slabEdge: '#aeb4bc',
  wall: '#e9e9e6',
  wallCap: '#f8f8f6',
  facade: '#e6e7e9',
  glass: '#9fbad3',
  glassHi: '#e9f1f8',
  mullion: '#7d8896',
  deskTop: '#f4f3f0',
  deskBase: '#b9bdc3',
  chair: '#4b525c',
  screen: '#2a2f37',
  screenOn: '#6f9fd8',
  fabric: '#8d99a8',
  wood: '#c8b498',
  stone: '#ece9e3',
  porcelain: '#fbfbfa',
  partition: '#d5d9de',
  rack: '#30353d',
  rackDoor: '#3c424b',
  pot: '#c9c3b8',
  leaf: '#5f8f5f',
  leafHi: '#8dbb7f',
  casing: '#e9ebee',
  metal: '#a9afb7',
  membrane: '#d4d7db',
  parapet: '#dcdcd8',
  aoOpacity: 0.16,
  shadowOpacity: 0.16,
};

const DARK_THEME: Materials = {
  dark: true,
  skyTop: '#12151a',
  skyBottom: '#191d23',
  ground: '#1e2227',
  groundEdge: '#2a2f36',
  slab: '#4a5059',
  slabEdge: '#3a3f47',
  wall: '#6a717b',
  wallCap: '#878e98',
  facade: '#6d747e',
  glass: '#5d7d9c',
  glassHi: '#a9c3db',
  mullion: '#2c3138',
  deskTop: '#a5a9ae',
  deskBase: '#5d636b',
  chair: '#24282e',
  screen: '#15181c',
  screenOn: '#4f8fd6',
  fabric: '#56627a',
  wood: '#8a7660',
  stone: '#8c8984',
  porcelain: '#d9dcdf',
  partition: '#7b828c',
  rack: '#2b3038',
  rackDoor: '#3a4049',
  pot: '#6f6a62',
  leaf: '#3f7246',
  leafHi: '#5f9a5c',
  casing: '#b9bec5',
  metal: '#7c838c',
  membrane: '#4b5058',
  parapet: '#5d636b',
  aoOpacity: 0.32,
  shadowOpacity: 0.45,
};

export function materials(dark: boolean): Materials {
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** Acabado de piso por tipo de zona: color base y patrón (alfombra, porcelanato, piso técnico…). */
export interface FloorFinish {
  color: string;
  pattern: 'carpet' | 'tile' | 'raised' | 'stone' | 'wood' | 'plain';
}

export function floorFinish(type: ZoneType, dark: boolean): FloorFinish {
  const L: Record<ZoneType, FloorFinish> = {
    oficina: { color: '#d7d9db', pattern: 'carpet' },
    oficina_abierta: { color: '#d7d9db', pattern: 'carpet' },
    cubiculos: { color: '#d7d9db', pattern: 'carpet' },
    conferencia: { color: '#d9cdb9', pattern: 'wood' },
    recepcion: { color: '#e6e1d8', pattern: 'stone' },
    pasillo: { color: '#e3e1dc', pattern: 'stone' },
    bano: { color: '#e2e7eb', pattern: 'tile' },
    servidores: { color: '#ced4da', pattern: 'raised' },
  };
  const D: Record<ZoneType, FloorFinish> = {
    oficina: { color: '#464c55', pattern: 'carpet' },
    oficina_abierta: { color: '#464c55', pattern: 'carpet' },
    cubiculos: { color: '#464c55', pattern: 'carpet' },
    conferencia: { color: '#544c40', pattern: 'wood' },
    recepcion: { color: '#524f48', pattern: 'stone' },
    pasillo: { color: '#4e5056', pattern: 'stone' },
    bano: { color: '#4a525b', pattern: 'tile' },
    servidores: { color: '#3f4650', pattern: 'raised' },
  };
  return (dark ? D : L)[type];
}

/**
 * Cómo se marca una zona según la capa: tinte translúcido sobre el material y contorno.
 * En la vista de estado una zona normal no lleva tinte (escena tranquila); alerta y crítico llevan tinte,
 * contorno grueso y rayado (no sólo color); sin datos, rayado gris.
 */
export interface ZoneMark {
  tint?: string;
  tintOpacity: number;
  outline?: string;
  outlineWidth: number;
  hatch?: 'alert' | 'offline';
}

export function zoneMark(
  view: 'status' | 'data',
  status: 'ok' | 'warning' | 'critical' | 'offline',
  color: string
): ZoneMark {
  if (view === 'data') {
    return status === 'offline'
      ? { tintOpacity: 0, outlineWidth: 1, hatch: 'offline' }
      : { tint: color, tintOpacity: 0.62, outline: color, outlineWidth: 1.5 };
  }
  switch (status) {
    case 'critical':
      return { tint: color, tintOpacity: 0.26, outline: color, outlineWidth: 2.5, hatch: 'alert' };
    case 'warning':
      return { tint: color, tintOpacity: 0.2, outline: color, outlineWidth: 2, hatch: 'alert' };
    case 'offline':
      return { tintOpacity: 0, outlineWidth: 1, hatch: 'offline' };
    default:
      return { tintOpacity: 0, outlineWidth: 1 };
  }
}
