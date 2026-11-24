/**
 * Edificio de oficinas de 5 plantas en Ciudad de Panamá (2000 m², 26 zonas acondicionadas), según el
 * modelo OpenStudio/EnergyPlus del proyecto (config/edificio.yaml del EMS).
 * Coordenadas en metros: x hacia el este, y hacia el norte, origen en la esquina suroeste.
 *
 * Los datos salen de modelData.ts, que genera tools/generar_modelo_panel.py desde el YAML; aquí van los
 * tipos y las funciones derivadas (parámetros térmicos iguales a ems/config.py::zonas).
 */
import { BUILDING, ENVELOPE, FLOORS, HVAC_SYSTEMS, PTAC_UNITS, PV, SURFACES, VRF_UNITS, ZONE_DATA } from './modelData';

export {
  BACKUP,
  BUILDING,
  CONTROLLER_LIMITS,
  CRITICAL_ZONES,
  EMS_RULES,
  ENVELOPE,
  FIXED_LOADS,
  FLOORS,
  HVAC_SYSTEMS,
  LIMIT_KW,
  LIMIT_RANGE,
  PTAC_UNITS,
  PV,
  SCHEDULES,
  SURFACES,
  TARIFF,
  VRF_UNITS,
} from './modelData';

export type ZoneType =
  'recepcion' | 'cubiculos' | 'conferencia' | 'pasillo' | 'bano' | 'servidores' | 'oficina' | 'oficina_abierta';

export type Facade = 'n' | 's' | 'e' | 'w';

export interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface ZoneData {
  id: string;
  name: string;
  type: ZoneType;
  critical: boolean;
  floor: number;
  /** Parte principal de la huella (rótulos, interiores). */
  rect: Rect;
  /** Todas las partes de la huella (una sola si la zona es rectangular). */
  rects: Rect[];
  /** Parámetros del modelo E+ (iguales al gemelo digital en Python). */
  area: number;
  occupants: number;
  lpd: number;
  epd: number;
  /** Capacidad total del terminal VRF o del PTAC (kW térmicos). */
  hvacKw: number;
  /** COP estacional del sistema que atiende la zona (calibrado con E+, incluye factor_cop). */
  cop: number;
  fanKw: number;
  system: string;
  systemKind: 'vrf' | 'ptac';
  itKw?: number;
  fixedSetpoint?: number;
  /** Área de vidrio por fachada (m²). */
  glazing: Partial<Record<Facade, number>>;
  /** Horarios del modelo E+ que usa la zona (claves de SCHEDULES). */
  schedules: { occupancy: string; lights: string; equipment: string; ac: string };
  fanMode: string;
}

export interface Zone extends ZoneData {
  /** Fachadas con ventanas (para el dibujo). */
  windows: Facade[];
}

export interface Floor {
  level: number;
  name: string;
  short: string;
  /** Losas que no son zonas (núcleo del elevador). */
  extras: Array<{ rect: Rect; label?: string }>;
}

/** Sistema de climatización: unidad exterior VRF (azotea) o PTAC de pared (baños). */
export interface HvacSystem {
  id: string;
  kind: 'vrf' | 'ptac';
  capacityKw: number;
  cop: number;
  zones: string[];
  /** Atiende una zona crítica (cuarto de servidores): los ajustes manuales exigen confirmación. */
  critical: boolean;
}

export interface VrfUnit extends HvacSystem {
  rect: Rect;
}

export interface PtacUnit extends HvacSystem {
  zone: string;
  floor: number;
  facade: Facade;
}

export interface PvField {
  id: string;
  areaM2: number;
  /** Zona de la última planta (o 'elevador') sobre cuya losa está el campo. */
  over: string;
  rect: Rect;
}

export interface PvSpec {
  enabledDefault: boolean;
  fractionActive: number;
  efficiency: number;
  inverter: number;
  areaM2: number;
  peakKw: number;
  fields: PvField[];
}

export interface SurfaceSpec {
  walls: Partial<Record<Facade, number>>;
  roof: number;
  ground: number;
}

export type Profile = Array<[number, number]>;
export interface Schedule {
  weekday: Profile;
  saturday: Profile;
  sunday: Profile;
}

export interface FixedLoad {
  name: string;
  kw: number;
  schedule: string;
  pf: number;
  critical: boolean;
  /** Conectada al tablero de emergencia (la alimenta la planta de respaldo). */
  backup?: boolean;
}

const withWindows = (d: ZoneData): Zone => ({
  ...d,
  windows: (Object.keys(d.glazing) as Facade[]).filter((k) => (d.glazing[k] ?? 0) > 0),
});

export const ZONES: Zone[] = ZONE_DATA.map(withWindows);

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(ZONES.map((x) => [x.id, x]));

export const FLOOR_BY_LEVEL: Record<number, Floor> = Object.fromEntries(FLOORS.map((f) => [f.level, f]));

/** Última planta (la azotea está sobre ella). */
export const TOP_LEVEL = FLOORS[FLOORS.length - 1].level;

export const ZONE_TYPE_LABELS: Record<ZoneType, string> = {
  recepcion: 'Recepción',
  cubiculos: 'Cubículos',
  conferencia: 'Conferencias',
  pasillo: 'Circulación',
  bano: 'Baños',
  servidores: 'Servidores',
  oficina: 'Oficina',
  oficina_abierta: 'Oficina abierta',
};

export const HVAC_BY_ID: Record<string, HvacSystem> = Object.fromEntries(HVAC_SYSTEMS.map((s) => [s.id, s]));
export const VRF_BY_ID: Record<string, VrfUnit> = Object.fromEntries(VRF_UNITS.map((s) => [s.id, s]));
export const PTAC_BY_ZONE: Record<string, PtacUnit> = Object.fromEntries(PTAC_UNITS.map((s) => [s.zone, s]));

/** Texto del equipo que climatiza la zona. */
export function systemLabel(zone: Zone): string {
  const s = HVAC_BY_ID[zone.system];
  if (zone.systemKind === 'ptac') {
    return `${zone.system} (PTAC de pared${s ? `, ${s.capacityKw.toFixed(1)} kW` : ''})`;
  }
  return `${zone.system} (VRF${s ? `, ${s.capacityKw.toFixed(0)} kW` : ''})`;
}

/** Potencia AC de la fotovoltaica (ems/config.py::potencia_fv_kw) con irradiancia horizontal en W/m². */
export function pvPowerKw(irrWm2: number): number {
  return (Math.max(irrWm2, 0) * PV.areaM2 * PV.fractionActive * PV.efficiency * PV.inverter) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Parámetros térmicos (mismas fórmulas que ems/config.py::zonas, calibradas contra E+)

export interface Thermal {
  /** Conducción por la envolvente: muros opacos, vidrio y techo (kW/K). */
  ua: number;
  /** Conducción expuesta al cielo (kW/K): muros opacos × 0.5 + techo × 1 (factor de forma, como el gemelo). */
  uaSky: number;
  /** Infiltración (kW/K). */
  gInf: number;
  /** Acople con el terreno (kW/K). */
  uaGround: number;
  /** Acople con la planta superior / inferior a través de las losas entre plantas (kW/K). */
  uaUp: number;
  uaDown: number;
  /** Capacitancia térmica efectiva (kWh/K). */
  c: number;
  glass: number;
  /** Ganancia solar por los opacos (kW por W/m² de irradiancia) por orientación y techo ('h'). */
  solarOpaque: Partial<Record<Facade | 'h', number>>;
  /** Constante de tiempo (h) con el HVAC apagado (plantas vecinas a temperatura constante). */
  tau: number;
}

const ALPHA_HO = 0.7 / 17; // absortancia / coef. película exterior → aire-sol

export function thermal(zone: Zone): Thermal {
  const s = SURFACES[zone.id] ?? { walls: {}, roof: 0, ground: 0 };
  const facades: Facade[] = ['n', 'e', 's', 'w'];
  const glass = facades.reduce((a, o) => a + (zone.glazing[o] ?? 0), 0);
  const opaque = Object.fromEntries(
    facades.map((o) => [o, Math.max((s.walls[o] ?? 0) - (zone.glazing[o] ?? 0), 0)])
  ) as Record<Facade, number>;
  const wallsGross = facades.reduce((a, o) => a + (s.walls[o] ?? 0), 0);
  const opaqueSum = facades.reduce((a, o) => a + opaque[o], 0);
  const ua = (ENVELOPE.uWall * opaqueSum + ENVELOPE.uGlass * glass + ENVELOPE.uRoof * s.roof) / 1000;
  const uaSky = (0.5 * ENVELOPE.uWall * opaqueSum + ENVELOPE.uRoof * s.roof) / 1000;
  const gInf = ENVELOPE.infiltration * (wallsGross + s.roof) * ENVELOPE.rhoCp;
  const slab = (ENVELOPE.uInterfloor * zone.area) / 1000;
  const uaUp = zone.floor < BUILDING.floors - 1 && !s.roof ? slab : 0;
  const uaDown = zone.floor > 0 && !s.ground ? slab : 0;
  const uaGround = (ENVELOPE.uGround * s.ground) / 1000;
  const c = ENVELOPE.capacitancePerM2 * zone.area;
  const solarOpaque: Thermal['solarOpaque'] = {};
  for (const o of facades) {
    if (opaque[o]) {
      solarOpaque[o] = (ENVELOPE.uWall * opaque[o] * ALPHA_HO) / 1000;
    }
  }
  if (s.roof) {
    solarOpaque.h = (ENVELOPE.uRoof * s.roof * ALPHA_HO) / 1000;
  }
  const g = ua + gInf + uaGround + uaUp + uaDown;
  return { ua, uaSky, gInf, uaGround, uaUp, uaDown, c, glass, solarOpaque, tau: c / Math.max(g, 1e-6) };
}

/** Conductancia total hacia el exterior, el terreno y las plantas vecinas (kW/K). */
export function totalConductance(th: Thermal): number {
  return th.ua + th.gInf + th.uaGround + th.uaUp + th.uaDown;
}
