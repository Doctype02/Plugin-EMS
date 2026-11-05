/**
 * Edificio de oficinas de 3 niveles en Ciudad de Panamá con 10 zonas (ver config/edificio.yaml del EMS).
 * Coordenadas en metros: x hacia el este, y hacia el norte, origen en la esquina suroeste.
 */

export type ZoneType = 'lobby' | 'oficina' | 'conferencia' | 'laboratorio' | 'cafeteria' | 'servidores' | 'soporte';

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface Zone {
  id: string;
  name: string;
  type: ZoneType;
  critical: boolean;
  floor: number;
  rect: Rect;
  /** Parámetros de diseño (iguales al modelo Python). */
  area: number;
  occupants: number;
  lpd: number;
  epd: number;
  hvacKw: number;
  cop: number;
  itKw?: number;
  fixedSetpoint?: number;
  /** Fachada con ventanas (lados expuestos al exterior). */
  windows?: Array<'s' | 'n' | 'e' | 'w'>;
}

export interface Floor {
  level: number;
  name: string;
  short: string;
  /** Losas que no son zonas (pasillos, núcleos). */
  extras: Array<{ rect: Rect; label?: string }>;
}

export const BUILDING = {
  name: 'Edificio Inteligente — Ciudad de Panamá',
  width: 34,
  depth: 20,
  floorHeight: 3.6,
};

export const FLOORS: Floor[] = [
  { level: 0, name: 'Planta baja', short: 'PB', extras: [] },
  { level: 1, name: 'Piso 1', short: 'P1', extras: [{ rect: { x: 0, y: 9, w: 27, d: 2 }, label: 'Pasillo' }] },
  { level: 2, name: 'Piso 2', short: 'P2', extras: [{ rect: { x: 0, y: 9, w: 27, d: 2 }, label: 'Pasillo' }] },
];

export const ZONES: Zone[] = [
  {
    id: 'Z01',
    name: 'Lobby',
    type: 'lobby',
    critical: false,
    floor: 0,
    rect: { x: 0, y: 0, w: 13, d: 20 },
    area: 220,
    occupants: 15,
    lpd: 9,
    epd: 3,
    hvacKw: 24,
    cop: 3.0,
    windows: ['s', 'w', 'n'],
  },
  {
    id: 'Z08',
    name: 'Cafetería',
    type: 'cafeteria',
    critical: false,
    floor: 0,
    rect: { x: 13, y: 0, w: 10, d: 20 },
    area: 160,
    occupants: 45,
    lpd: 9,
    epd: 30,
    hvacKw: 24,
    cop: 3.0,
    windows: ['s', 'n'],
  },
  {
    id: 'Z09',
    name: 'Cuarto de servidores',
    type: 'servidores',
    critical: true,
    floor: 0,
    rect: { x: 23, y: 0, w: 11, d: 8 },
    area: 60,
    occupants: 1,
    lpd: 8,
    epd: 0,
    hvacKw: 30,
    cop: 2.8,
    itKw: 18,
    fixedSetpoint: 22,
  },
  {
    id: 'Z10',
    name: 'Seguridad / UPS',
    type: 'soporte',
    critical: true,
    floor: 0,
    rect: { x: 23, y: 8, w: 11, d: 12 },
    area: 80,
    occupants: 2,
    lpd: 6,
    epd: 35,
    hvacKw: 10,
    cop: 3.0,
    fixedSetpoint: 24,
    windows: ['e', 'n'],
  },
  {
    id: 'Z03',
    name: 'Oficinas P1 Sur',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 0, y: 0, w: 27, d: 9 },
    area: 300,
    occupants: 30,
    lpd: 10,
    epd: 12,
    hvacKw: 30,
    cop: 3.0,
    windows: ['s', 'w'],
  },
  {
    id: 'Z02',
    name: 'Oficinas P1 Norte',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 0, y: 11, w: 27, d: 9 },
    area: 300,
    occupants: 30,
    lpd: 10,
    epd: 12,
    hvacKw: 30,
    cop: 3.0,
    windows: ['n', 'w'],
  },
  {
    id: 'Z06',
    name: 'Sala de conferencias',
    type: 'conferencia',
    critical: false,
    floor: 1,
    rect: { x: 27, y: 0, w: 7, d: 20 },
    area: 120,
    occupants: 40,
    lpd: 11,
    epd: 6,
    hvacKw: 18,
    cop: 3.0,
    windows: ['e', 's', 'n'],
  },
  {
    id: 'Z05',
    name: 'Oficinas P2 Sur',
    type: 'oficina',
    critical: false,
    floor: 2,
    rect: { x: 0, y: 0, w: 27, d: 9 },
    area: 300,
    occupants: 28,
    lpd: 10,
    epd: 12,
    hvacKw: 30,
    cop: 3.0,
    windows: ['s', 'w'],
  },
  {
    id: 'Z04',
    name: 'Oficinas P2 Norte',
    type: 'oficina',
    critical: false,
    floor: 2,
    rect: { x: 0, y: 11, w: 27, d: 9 },
    area: 300,
    occupants: 28,
    lpd: 10,
    epd: 12,
    hvacKw: 30,
    cop: 3.0,
    windows: ['n', 'w'],
  },
  {
    id: 'Z07',
    name: 'Laboratorio',
    type: 'laboratorio',
    critical: false,
    floor: 2,
    rect: { x: 27, y: 0, w: 7, d: 20 },
    area: 180,
    occupants: 16,
    lpd: 12,
    epd: 25,
    hvacKw: 26,
    cop: 3.0,
    windows: ['e', 's'],
  },
];

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(ZONES.map((z) => [z.id, z]));

export const ZONE_TYPE_LABELS: Record<ZoneType, string> = {
  lobby: 'Lobby',
  oficina: 'Oficinas',
  conferencia: 'Conferencias',
  laboratorio: 'Laboratorio',
  cafeteria: 'Cafetería',
  servidores: 'Servidores',
  soporte: 'Soporte',
};

/** Unidades condensadoras en la azotea (una por zona): en la vista explotada, repartidas sobre la azotea. */
export const ROOF_UNITS = ZONES.map((z, i) => ({
  zoneId: z.id,
  rect: { x: 1.5 + (i % 5) * 6.4, y: i < 5 ? 3 : 13, w: 3.2, d: 3 } as Rect,
}));

/** En la vista exterior, las condensadoras van en una franja junto al borde norte para no tapar las etiquetas. */
export const ROOF_UNITS_STACKED = ZONES.map((z, i) => ({
  zoneId: z.id,
  rect: { x: 0.8 + i * 3.3, y: 17.6, w: 2.5, d: 1.8 } as Rect,
}));
