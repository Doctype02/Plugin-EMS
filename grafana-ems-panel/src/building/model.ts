/**
 * Edificio de oficinas de 2 plantas en Ciudad de Panamá (800 m², 10 zonas), según el modelo
 * OpenStudio/EnergyPlus del proyecto (config/edificio.yaml del EMS).
 * Coordenadas en metros: x hacia el este, y hacia el norte, origen en la esquina suroeste.
 */

export type ZoneType = 'recepcion' | 'cubiculos' | 'oficina' | 'conferencia' | 'pasillo' | 'servidores' | 'electrico';

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
  /** Parámetros del modelo E+ (iguales al gemelo digital en Python). */
  area: number;
  occupants: number;
  lpd: number;
  epd: number;
  /** Capacidad total del terminal VRF (kW térmicos). */
  hvacKw: number;
  /** COP estacional del sistema VRF que atiende la zona (calibrado con E+). */
  cop: number;
  fanKw: number;
  system: string;
  itKw?: number;
  fixedSetpoint?: number;
  /** Área de vidrio por fachada (m²). */
  glazing: Partial<Record<'n' | 's' | 'e' | 'w', number>>;
  /** Fachadas con ventanas (para el dibujo). */
  windows?: Array<'s' | 'n' | 'e' | 'w'>;
}

export interface Floor {
  level: number;
  name: string;
  short: string;
  /** Losas que no son zonas. */
  extras: Array<{ rect: Rect; label?: string }>;
}

export const BUILDING = {
  name: 'Edificio de oficinas — Ciudad de Panamá',
  width: 20,
  depth: 20,
  floorHeight: 3.0,
};

export const FLOORS: Floor[] = [
  { level: 0, name: 'Planta baja', short: 'PB', extras: [] },
  { level: 1, name: 'Planta alta', short: 'PA', extras: [] },
];

const z = (d: Omit<Zone, 'windows'>): Zone => ({
  ...d,
  windows: (Object.keys(d.glazing) as Array<'n' | 's' | 'e' | 'w'>).filter((k) => (d.glazing[k] ?? 0) > 0),
});

export const ZONES: Zone[] = [
  z({
    id: 'Z01',
    name: 'Recepción',
    type: 'recepcion',
    critical: false,
    floor: 0,
    rect: { x: 10, y: 0, w: 10, d: 8 },
    area: 80,
    occupants: 4,
    lpd: 5.5,
    epd: 6.0,
    hvacKw: 5.76,
    cop: 1.72,
    fanKw: 0.147,
    system: 'VRF-B',
    glazing: { e: 18, s: 22.5 },
  }),
  z({
    id: 'Z02',
    name: 'Cubículos',
    type: 'cubiculos',
    critical: false,
    floor: 0,
    rect: { x: 0, y: 3, w: 10, d: 17 },
    area: 170,
    occupants: 15,
    lpd: 8.72,
    epd: 10.59,
    hvacKw: 19.41,
    cop: 1.72,
    fanKw: 0.435,
    system: 'VRF-B',
    glazing: { n: 22.5, w: 38.25 },
  }),
  z({
    id: 'Z03',
    name: 'Sala de conferencias',
    type: 'conferencia',
    critical: false,
    floor: 0,
    rect: { x: 10, y: 8, w: 10, d: 12 },
    area: 120,
    occupants: 20,
    lpd: 9.0,
    epd: 2.08,
    hvacKw: 13.36,
    cop: 1.72,
    fanKw: 0.269,
    system: 'VRF-B',
    glazing: { e: 27, n: 22.5 },
  }),
  z({
    id: 'Z09',
    name: 'Cuarto de servidores',
    type: 'servidores',
    critical: true,
    floor: 0,
    rect: { x: 4, y: 0, w: 6, d: 3 },
    area: 18,
    occupants: 0,
    lpd: 4.44,
    epd: 0,
    itKw: 2.0,
    hvacKw: 2.89,
    cop: 3.08,
    fanKw: 0.086,
    system: 'VRF-C',
    fixedSetpoint: 24,
    glazing: {},
  }),
  z({
    id: 'Z10',
    name: 'Cuarto eléctrico',
    type: 'electrico',
    critical: true,
    floor: 0,
    rect: { x: 0, y: 0, w: 4, d: 3 },
    area: 12,
    occupants: 0,
    lpd: 5.0,
    epd: 12.5,
    hvacKw: 0.16,
    cop: 1.72,
    fanKw: 0.003,
    system: 'VRF-B',
    fixedSetpoint: 27,
    glazing: {},
  }),
  z({
    id: 'Z04',
    name: 'Oficina 1',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 0, y: 10, w: 9, d: 10 },
    area: 90,
    occupants: 9,
    lpd: 8.89,
    epd: 12,
    hvacKw: 17.04,
    cop: 2.08,
    fanKw: 0.433,
    system: 'VRF-A',
    glazing: { n: 20.25, w: 22.5 },
  }),
  z({
    id: 'Z05',
    name: 'Oficina 2',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 0, y: 0, w: 9, d: 10 },
    area: 90,
    occupants: 9,
    lpd: 8.89,
    epd: 12,
    hvacKw: 16.13,
    cop: 2.08,
    fanKw: 0.397,
    system: 'VRF-A',
    glazing: { s: 20.25, w: 22.5 },
  }),
  z({
    id: 'Z06',
    name: 'Oficina 3',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 11, y: 10, w: 9, d: 10 },
    area: 90,
    occupants: 9,
    lpd: 8.89,
    epd: 12,
    hvacKw: 15.31,
    cop: 2.08,
    fanKw: 0.37,
    system: 'VRF-A',
    glazing: { n: 20.25, e: 22.5 },
  }),
  z({
    id: 'Z07',
    name: 'Oficina 4',
    type: 'oficina',
    critical: false,
    floor: 1,
    rect: { x: 11, y: 0, w: 9, d: 10 },
    area: 90,
    occupants: 9,
    lpd: 8.89,
    epd: 12,
    hvacKw: 14.54,
    cop: 2.08,
    fanKw: 0.341,
    system: 'VRF-A',
    glazing: { s: 20.25, e: 22.5 },
  }),
  z({
    id: 'Z08',
    name: 'Pasillo',
    type: 'pasillo',
    critical: false,
    floor: 1,
    rect: { x: 9, y: 0, w: 2, d: 20 },
    area: 40,
    occupants: 0,
    lpd: 2.0,
    epd: 0,
    hvacKw: 3.55,
    cop: 2.08,
    fanKw: 0.099,
    system: 'VRF-A',
    glazing: { n: 4.5, s: 4.5 },
  }),
];

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(ZONES.map((x) => [x.id, x]));

export const ZONE_TYPE_LABELS: Record<ZoneType, string> = {
  recepcion: 'Recepción',
  cubiculos: 'Cubículos',
  oficina: 'Oficina',
  conferencia: 'Conferencias',
  pasillo: 'Circulación',
  servidores: 'Servidores',
  electrico: 'Cuarto eléctrico',
};

/** Unidades exteriores VRF en la azotea (capacidad autodimensionada por E+) y zonas que atienden. */
export interface VrfUnit {
  id: string;
  capacityKw: number;
  zones: string[];
  rect: Rect;
}

export const VRF_UNITS: VrfUnit[] = [
  { id: 'VRF-A', capacityKw: 66.57, zones: ['Z04', 'Z05', 'Z06', 'Z07', 'Z08'], rect: { x: 3, y: 12, w: 6, d: 4 } },
  { id: 'VRF-B', capacityKw: 38.69, zones: ['Z01', 'Z02', 'Z03', 'Z10'], rect: { x: 12, y: 12.5, w: 4.5, d: 3.2 } },
  { id: 'VRF-C', capacityKw: 2.89, zones: ['Z09'], rect: { x: 14, y: 5, w: 1.6, d: 1.4 } },
];

/** En la vista exterior las unidades van junto al borde norte para no tapar las etiquetas. */
export const VRF_UNITS_STACKED: VrfUnit[] = [
  { ...VRF_UNITS[0], rect: { x: 1.0, y: 16.8, w: 5.5, d: 2.6 } },
  { ...VRF_UNITS[1], rect: { x: 7.5, y: 17.2, w: 4.2, d: 2.2 } },
  { ...VRF_UNITS[2], rect: { x: 12.8, y: 17.8, w: 1.5, d: 1.2 } },
];

// ---------------------------------------------------------------------------------------------
// Envolvente y parámetros térmicos (mismos valores y fórmulas que ems/config.py, calibrados contra E+)

/** Constantes del modelo E+ y de la calibración del gemelo (config/edificio.yaml). */
export const ENVELOPE = {
  uWall: 0.86,
  uRoof: 0.274,
  uGround: 2.945,
  uGlass: 6.424,
  shgc: 0.252,
  infiltration: 0.00030226, // m³/s por m² de superficie exterior
  rhoCp: 1.2 * 1.006,
  tGround: 18,
  capacitancePerM2: 0.03, // kWh/K·m²
  solarFactor: 0.5,
  skyDeltaT: 6,
};

/** Muros exteriores brutos por fachada (m²), techo exterior y losa sobre terreno (E+ Surfaces). */
export const SURFACES: Record<
  string,
  { walls: Partial<Record<'n' | 's' | 'e' | 'w', number>>; roof: number; ground: number }
> = {
  Z01: { walls: { e: 24, s: 30 }, roof: 0, ground: 80 },
  Z02: { walls: { n: 30, w: 51 }, roof: 0, ground: 170 },
  Z03: { walls: { e: 36, n: 30 }, roof: 0, ground: 120 },
  Z04: { walls: { n: 27, w: 30 }, roof: 90, ground: 0 },
  Z05: { walls: { s: 27, w: 30 }, roof: 90, ground: 0 },
  Z06: { walls: { n: 27, e: 30 }, roof: 90, ground: 0 },
  Z07: { walls: { s: 27, e: 30 }, roof: 90, ground: 0 },
  Z08: { walls: { n: 6, s: 6 }, roof: 40, ground: 0 },
  Z09: { walls: { s: 18 }, roof: 0, ground: 18 },
  Z10: { walls: { s: 12, w: 9 }, roof: 0, ground: 12 },
};

export interface Thermal {
  /** Conducción por la envolvente (kW/K). */
  ua: number;
  /** Infiltración (kW/K). */
  gInf: number;
  /** Acople con el terreno (kW/K). */
  uaGround: number;
  /** Capacitancia térmica efectiva (kWh/K). */
  c: number;
  glass: number;
  /** Constante de tiempo (h) con el HVAC apagado. */
  tau: number;
}

export function thermal(zone: Zone): Thermal {
  const s = SURFACES[zone.id] ?? { walls: {}, roof: 0, ground: 0 };
  const glass = Object.values(zone.glazing).reduce((a, v) => a + (v ?? 0), 0);
  const wallsGross = Object.values(s.walls).reduce((a, v) => a + (v ?? 0), 0);
  const opaque = Math.max(wallsGross - glass, 0);
  const ua = (ENVELOPE.uWall * opaque + ENVELOPE.uGlass * glass + ENVELOPE.uRoof * s.roof) / 1000;
  const gInf = ENVELOPE.infiltration * (wallsGross + s.roof) * ENVELOPE.rhoCp;
  const uaGround = (ENVELOPE.uGround * s.ground) / 1000;
  const c = ENVELOPE.capacitancePerM2 * zone.area;
  return { ua, gInf, uaGround, c, glass, tau: c / Math.max(ua + gInf + uaGround, 1e-6) };
}
