/**
 * Telemetría simulada del edificio para el modo demostración.
 *
 * Es una función pura del tiempo (mismo instante → mismo resultado), lo que permite reconstruir las
 * tendencias sin guardar estado. Usa los parámetros y horarios del modelo OpenStudio/EnergyPlus del
 * proyecto (ocupación, iluminación y equipos por horario; terminales VRF con COP estacional) y
 * reproduce de forma simplificada la lógica del EMS en Python (ems/control.py, clase ReglasDR):
 * setpoints por ocupación, pre-enfriamiento, terminal VRF modulante con histéresis, luz natural,
 * corte de standby y limitador de demanda. Inyecta un incidente diario para que se vean las alarmas.
 * Con `controller: 'baseline'` reproduce la operación del modelo E+ (setpoint de horario 24 h, luces por
 * horario, sin limitador). Incluye las cargas fijas (ascensor, extractores) y, con `pv`, la fotovoltaica
 * de la azotea (la demanda de 15 min es la importación neta, como en ems/edificio.py).
 *
 * Controladores (como ems/controladores.py): `units` ajusta el controlador local de cada VRF/PTAC (apagado,
 * modo frío local o ventilación, tope de capacidad —aquí aproximado por zona—, setpoint propio y factor de
 * COP) y `sensors` fuerza lo que lee el sensor de una zona. El EMS y el termostato regulan la lectura: con un
 * desfase de +x °C la zona real queda x °C por debajo del setpoint; con un valor fijo alto enfrían a plena
 * capacidad y con uno bajo dejan de enfriar; un sensor congelado se detecta a los 30 min (modo seguro).
 */
import {
  BACKUP,
  BUILDING,
  EMS_RULES,
  HVAC_SYSTEMS,
  ENVELOPE,
  FIXED_LOADS,
  SCHEDULES,
  TARIFF,
  ZONES,
  ZONE_BY_ID,
  Zone,
  pvPowerKw,
  thermal,
  totalConductance,
} from './model';
import { EVENTS, EventKind, SimEvent, activeEvents, affectsZone } from './events';
import {
  EmsAlarm,
  EmsState,
  History,
  MeterState,
  OccupancyOverride,
  OccupancyOverrides,
  Overrides,
  SensorForce,
  SensorOverride,
  SensorOverrides,
  Snapshot,
  UnitAdjustment,
  UnitAdjustments,
  UnitStatus,
  ZoneOverride,
  ZoneState,
} from './telemetry';

export { SCHEDULES } from './model';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ_OFFSET = -5 * HOUR; // America/Panama (sin horario de verano)
const FIRE_KW = 150;

/** Control que simula el gemelo: EMS por reglas con limitador (por defecto) o la línea base del modelo E+. */
export type SimController = 'reglas_dr' | 'baseline';

export interface SimOptions {
  limitKw: number;
  /** Setpoint con ocupación (por defecto 24 °C). */
  spOccupied?: number;
  overrides?: Overrides;
  /** Eventos simulados por el operador (fallas, accidentes, condiciones extremas). */
  events?: SimEvent[];
  /** Incidente de demostración diario (desactívelo para controlar los eventos a mano). */
  demoIncidents?: boolean;
  /** Cantidad de personas forzada por el operador (por zona o '*' para el edificio). */
  occupancy?: OccupancyOverrides;
  /** Variante del edificio con fotovoltaica en la azotea (por defecto sin FV). */
  pv?: boolean;
  /** 'reglas_dr' (EMS) o 'baseline' (setpoints de E+ 24 h, luces por horario, sin limitador). */
  controller?: SimController;
  /** Ajustes del operador sobre las unidades VRF/PTAC (controlador local). */
  units?: UnitAdjustments;
  /** Datos forzados de los sensores de zona. */
  sensors?: SensorOverrides;
}

/** Minutos hasta que el supervisor detecta un sensor congelado (6 lecturas iguales de 5 min). */
const FROZEN_DETECT_MIN = 30;

export function activeUnit(unitId: string, t: number, opts: SimOptions): UnitAdjustment | undefined {
  const a = opts.units?.[unitId];
  return a && t >= a.since && t < a.until ? a : undefined;
}

export function activeSensor(zoneId: string, t: number, opts: SimOptions): SensorOverride | undefined {
  const s = opts.sensors?.[zoneId];
  return s && t >= s.since && t < s.until ? s : undefined;
}

/** Humedad absoluta (kg/kg) y relativa (%) a 101.325 kPa (mismas fórmulas que ems/edificio.py). */
const psat = (tc: number) => 0.61094 * Math.exp((17.625 * tc) / (tc + 243.04));
export function absHumidity(tc: number, rh: number): number {
  const pv = (Math.min(Math.max(rh, 0), 100) / 100) * psat(tc);
  return (0.622 * pv) / (101.325 - pv);
}
export function relHumidity(tc: number, w: number): number {
  const pv = (w * 101.325) / (0.622 + w);
  return Math.min(100, Math.max(0, (100 * pv) / psat(tc)));
}

const forceOf = (s: SensorOverride): SensorForce => {
  const { since: _s, until: _u, user: _w, frozenAt: _f, ...f } = s;
  return f;
};

function activeOcc(key: string, t: number, opts: SimOptions): OccupancyOverride | undefined {
  const o = opts.occupancy?.[key];
  return o && t >= o.since && t < o.until ? o : undefined;
}

/** Personas en la zona según el horario, con el ajuste del operador (zona fija > % del edificio). */
function plannedOccupants(z: Zone, t: number, c: Clock, opts: SimOptions): number {
  const fixed = activeOcc(z.id, t, opts);
  if (fixed?.people !== undefined && z.occupants > 0) {
    return fixed.people;
  }
  const noise = 1 + EMS_RULES.noise * (hash(z.id, Math.floor(t / (5 * MIN))) - 0.5);
  const pct = activeOcc('*', t, opts)?.pct ?? 100;
  return Math.round(occupancyFraction(z, c) * z.occupants * noise * (pct / 100));
}

export function activeOverride(zone: Zone, t: number, opts: SimOptions): ZoneOverride | undefined {
  const ov = opts.overrides?.[zone.id];
  return ov && !zone.critical && t >= ov.since && t < ov.until ? ov : undefined;
}

const ENTRY = EMS_RULES.entry;
const EXIT = EMS_RULES.exit;
const PRECOOL_H = EMS_RULES.precoolMin / 60;
const BAND = EMS_RULES.band;
const SP_OCC = EMS_RULES.spOccupied;
const SP_UNOCC = EMS_RULES.spUnoccupied;
const T_PROT_MAX = EMS_RULES.tProtMax;
const RAMP_C_H = EMS_RULES.setpointRampCh;
const STARTS_PER_STEP = Math.max(EMS_RULES.startsPerStep, 1);
const TRANSITION_H = EMS_RULES.scheduleTransitionMin / 60;
const PLR_MIN = 0.15;
const Q_PERSON = 0.075; // kW sensibles por persona
/** Temperatura supuesta de las plantas vecinas (acondicionadas) para el acople por las losas. */
const T_NEIGHBOR = 24;

function stepValue(p: Array<[number, number]>, h: number): number {
  let v = p[0][1];
  for (const [start, value] of p) {
    if (h >= start) {
      v = value;
    } else {
      break;
    }
  }
  return v;
}

/**
 * Valor del horario. Como en ems/config.py (`horarios.transicion_min`), cada escalón de E+ se suaviza en una
 * rampa centrada en la hora del cambio: la gente llega y enciende los equipos de forma gradual.
 */
export function scheduleValue(name: string, dow: number, h: number): number {
  const s = SCHEDULES[name];
  if (!s) {
    return 0;
  }
  const p = (dow === 0 ? s.sunday : dow === 6 ? s.saturday : s.weekday) as Array<[number, number]>;
  if (TRANSITION_H <= 0) {
    return stepValue(p, h);
  }
  const a = Math.max(h - TRANSITION_H / 2, 0);
  const b = Math.min(h + TRANSITION_H / 2, 24);
  if (b <= a) {
    return stepValue(p, a);
  }
  const cuts = [a, ...p.map(([start]) => start).filter((x) => x > a && x < b), b];
  let acc = 0;
  for (let i = 1; i < cuts.length; i++) {
    acc += stepValue(p, cuts[i - 1]) * (cuts[i] - cuts[i - 1]);
  }
  return acc / (b - a);
}

/** Hash determinista en [0, 1). */
export function hash(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

interface Clock {
  h: number;
  dow: number;
  day: number;
  weekday: boolean;
}

export function clock(t: number): Clock {
  const local = new Date(t + TZ_OFFSET);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const dow = local.getUTCDay();
  return { h, dow, day: Math.floor((t + TZ_OFFSET) / DAY), weekday: dow >= 1 && dow <= 5 };
}

function occupancyFraction(z: Zone, c: Clock): number {
  if (z.occupants === 0) {
    return 0;
  }
  // cada zona llega y se va antes o después según el día (± 25 min), como ocupacion.dispersion_llegada_min
  const shiftH = (hash('llegada', z.id, c.day) - 0.5) * (50 / 60);
  const f = scheduleValue(z.schedules.occupancy, c.dow, Math.min(Math.max(c.h - shiftH, 0), 23.99));
  const absent = c.weekday ? EMS_RULES.absenteeism * hash('ausentismo', z.id, c.day) * 2 : 0;
  return f * (1 - absent);
}

export function weather(t: number, events?: SimEvent[]) {
  const w = baseWeather(t);
  const calor = activeEvents(events, t)
    .filter((e) => e.kind === 'ola_calor')
    .reduce((a, e) => a + (e.intensity ?? 4), 0);
  return calor ? { tExt: w.tExt + calor, irr: w.irr * 1.08, rh: Math.max(50, w.rh - 2 * calor) } : w;
}

function baseWeather(t: number) {
  const c = clock(t);
  const cloud = 0.2 + 0.5 * hash('nubes', c.day) + 0.15 * Math.sin(t / (47 * MIN));
  const x = (c.h - 6.25) / 12;
  const bell = x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 1.3 : 0;
  const irr = 850 * bell * (1 - 0.7 * Math.min(Math.max(cloud, 0), 1));
  const tExt = 28 + 3.5 * Math.cos((2 * Math.PI * (c.h - 14.5)) / 24) * (1 - 0.3 * cloud);
  const rh = Math.min(98, Math.max(55, 88 - 2.4 * (tExt - 24.5) + 10 * cloud));
  return { tExt, irr, rh };
}

/** Incidente de demostración del día (rota cada día). */
export function incident(
  t: number,
  enabled = true
): { zone: string; kind: 'sensor' | 'falla_hvac' | 'sobreocupacion'; from: number; to: number } | undefined {
  const c = clock(t);
  if (!enabled || !c.weekday) {
    return undefined;
  }
  const kinds = [
    { zone: 'Z02', kind: 'sensor' as const, from: 10, to: 11 },
    { zone: 'Z12', kind: 'falla_hvac' as const, from: 13, to: 14.5 },
    { zone: 'Z03', kind: 'sobreocupacion' as const, from: 14, to: 15.5 },
  ];
  const k = kinds[c.day % kinds.length];
  return c.h >= k.from && c.h < k.to ? k : undefined;
}

interface ZoneCore extends ZoneState {
  wantsCooling: boolean;
  compressorKw: number;
  urgency: number;
  /** COP efectivo del instante (con el factor de degradación de la unidad). */
  copEff: number;
  /** La unidad está en control local (el limitador del EMS no la toca). */
  unitLocal: boolean;
}

/** Estado de los eventos del instante para una zona. */
interface ZoneEvents {
  kinds: EventKind[];
  /** Inicio del período sin enfriamiento (falla, incendio o corte), si lo hay. */
  noCoolingSince?: number;
  fire?: SimEvent;
  fireAnywhere?: SimEvent;
  outage?: SimEvent;
  /** Corte de red con la planta de respaldo en marcha (tablero de emergencia con servicio). */
  backup: boolean;
  /** Tras una transferencia: inicio de la parada y, si ya rearrancó, del período de recuperación. */
  transferAt?: number;
  recoverSince?: number;
  /** La última transferencia fue el retorno a la red tras un corte con planta (la zona venía en emergencia). */
  afterBackup: boolean;
  /** El UPS se agotó: las cargas críticas también se apagan. */
  upsDepleted: boolean;
  doorFlow: number;
  extraKw: number;
  overcrowd: number;
  sensor: boolean;
}

/**
 * Corte de red con la planta de respaldo ya en marcha: disponible (sin «falla_generador») y pasados los
 * segundos de arranque y transferencia, que cubre el UPS de los servidores.
 */
function backupOn(act: SimEvent[], t?: number): boolean {
  const outage = act.find((e) => e.kind === 'corte_energia');
  if (!BACKUP.enabled || !outage || act.some((e) => e.kind === 'falla_generador')) {
    return false;
  }
  return t === undefined || t - outage.start >= BACKUP.startSeconds * 1000;
}

/** Tiempo que tarda una zona en recuperar la temperatura tras rearrancar su terminal (constante, min). */
const RECOVERY_MIN = 20;
/** Ventana en la que una transferencia sigue afectando a las zonas (toma de carga + recuperación). */
const TRANSFER_WINDOW = 150 * MIN;

/**
 * Última transferencia (a la planta al empezar un corte, o de vuelta a la red al terminar) reciente: en ambas
 * los compresores se desconectan y vuelven por turnos. Sin planta disponible no hay transferencia a ella.
 */
function lastTransfer(events: SimEvent[] | undefined, t: number): number | undefined {
  if (!BACKUP.enabled) {
    return undefined;
  }
  let at: number | undefined;
  for (const e of events ?? []) {
    if (e.kind !== 'corte_energia') {
      continue;
    }
    for (const x of [e.start, e.end]) {
      if (x <= t && t - x < TRANSFER_WINDOW && (at === undefined || x > at)) {
        at = x;
      }
    }
  }
  return at;
}

/** Instante en que el terminal de la zona vuelve a arrancar tras una transferencia (arranque escalonado). */
function restartAfter(z: Zone, transferAt: number): number {
  const rank = START_RANK.get(z.id) ?? 0;
  const turn = z.critical ? 0 : Math.floor(rank / STARTS_PER_STEP) + 1;
  return transferAt + (BACKUP.restartMin + 5 * turn) * MIN;
}

const PTAC_SYSTEMS = new Set(HVAC_SYSTEMS.filter((u) => u.kind === 'ptac').map((u) => u.id));
const isPtac = (z: Zone) => PTAC_SYSTEMS.has(z.system);

function zoneEvents(z: Zone, t: number, events?: SimEvent[]): ZoneEvents {
  const act = activeEvents(events, t);
  const mine = act.filter((e) => affectsZone(e, z.id));
  const fireAnywhere = act.find((e) => e.kind === 'incendio');
  const outage = act.find((e) => e.kind === 'corte_energia');
  const backup = backupOn(act, t);
  const upsDepleted = !!outage && !backup && t - outage.start > BACKUP.upsMinutes * MIN;
  // con la planta en marcha sólo quedan sin frío los equipos fuera del tablero de emergencia (PTAC)
  const outageCutsCooling = !!outage && (!backup || isPtac(z));
  // toma de carga escalonada: tras la transferencia cada terminal espera su turno para rearrancar
  const transferAt = lastTransfer(events, t);
  const restartAt = transferAt !== undefined ? restartAfter(z, transferAt) : undefined;
  const waiting = restartAt !== undefined && t < restartAt && !outageCutsCooling;
  const starts = [
    ...mine.filter((e) => e.kind === 'falla_terminal' || e.kind === 'falla_vrf').map((e) => e.start),
    ...(fireAnywhere ? [fireAnywhere.start] : []),
    ...(outage && outageCutsCooling ? [outage.start] : []),
    ...(waiting && transferAt !== undefined ? [transferAt] : []),
  ];
  return {
    kinds: [...new Set(mine.map((e) => e.kind))],
    noCoolingSince: starts.length ? Math.min(...starts) : undefined,
    fire: mine.find((e) => e.kind === 'incendio'),
    fireAnywhere,
    outage,
    backup,
    transferAt,
    afterBackup:
      transferAt !== undefined &&
      (events ?? []).some((e) => e.kind === 'corte_energia' && e.end === transferAt) &&
      !(events ?? []).some((e) => e.kind === 'falla_generador' && e.start < transferAt && e.end >= transferAt),
    recoverSince:
      restartAt !== undefined && !waiting && !outageCutsCooling && t < restartAt + 5 * RECOVERY_MIN * MIN ? restartAt : undefined,
    upsDepleted,
    doorFlow: mine
      .filter((e) => e.kind === 'puerta_abierta')
      .reduce((a, e) => a + 0.6 * ((e.intensity ?? 50) / 100), 0),
    extraKw: mine.filter((e) => e.kind === 'pico_carga').reduce((a, e) => a + (e.intensity ?? 10), 0),
    overcrowd: mine.filter((e) => e.kind === 'sobreocupacion').reduce((a, e) => a + (e.intensity ?? 50) / 100, 0),
    sensor: mine.some((e) => e.kind === 'sensor'),
  };
}

/**
 * Temperatura de libre flotación (modelo RC de la zona) desde t0 con las ganancias actuales. Las plantas
 * vecinas se suponen a `tNeighbor` (siguen acondicionadas salvo que también pierdan el enfriamiento).
 */
export function freeFloat(
  z: Zone,
  t0Temp: number,
  hours: number,
  gainsKw: number,
  tExt: number,
  extraG = 0,
  tNeighbor = T_NEIGHBOR
): number {
  const th = thermal(z);
  const g = totalConductance(th) + extraG;
  const teq =
    (th.ua * tExt -
      th.uaSky * ENVELOPE.skyDeltaT +
      (th.gInf + extraG) * tExt +
      th.uaGround * ENVELOPE.tGround +
      (th.uaUp + th.uaDown) * tNeighbor +
      gainsKw) /
    g;
  return teq + (t0Temp - teq) * Math.exp(-Math.max(hours, 0) / Math.max(th.c / g, 0.05));
}

// ---------------------------------------------------------------- aire apagado fuera de horario
/** Orden de arranque escalonado del pre-enfriamiento: plantas altas (más calientes) primero. */
const START_RANK = new Map(
  ZONES.filter((z) => !z.critical && z.fixedSetpoint === undefined)
    .slice()
    .sort((a, b) => b.floor - a.floor || a.id.localeCompare(b.id))
    .map((z, i) => [z.id, i])
);

/** Hora local (h) en que arranca el pre-enfriamiento de la zona: STARTS_PER_STEP terminales cada 5 min. */
export function precoolStartH(z: Zone): number {
  const fs = EMS_RULES.floorStart;
  if (fs) {
    // encendido escalonado por planta: una planta cada `intervalMin`; pasillos y baños no entran en la secuencia
    const i = (fs.order as number[]).indexOf(z.floor);
    return (fs.exclude as string[]).includes(z.type) || i < 0 ? ENTRY : fs.startH + (i * fs.intervalMin) / 60;
  }
  const rank = START_RANK.get(z.id) ?? 0;
  return ENTRY - PRECOOL_H + Math.floor(rank / STARTS_PER_STEP) * (5 / 60);
}

/** Último fin de jornada (día laborable, salida + 30 min) anterior a t. */
function lastShutoff(t: number): number {
  const day = Math.floor((t + TZ_OFFSET) / DAY);
  for (let d = day; d > day - 8; d--) {
    const midnight = d * DAY - TZ_OFFSET;
    const shut = midnight + (EXIT + 0.5) * HOUR;
    if (clock(midnight + 12 * HOUR).weekday && shut <= t) {
      return shut;
    }
  }
  return t - DAY;
}

const driftMemo = new Map<string, number>();

/** Avanza la libre flotación de la zona entre ta y tb con el clima y las ganancias en standby. */
function driftStep(z: Zone, temp: number, ta: number, tb: number): number {
  const mid = (ta + tb) / 2;
  const c = clock(mid);
  const w = baseWeather(mid);
  const th = thermal(z);
  const plugs =
    ((z.epd * z.area) / 1000) * scheduleValue(z.schedules.equipment, c.dow, c.h) * EMS_RULES.plugsUnoccupied +
    (z.itKw ?? 0);
  const opaque = Object.entries(th.solarOpaque).reduce((a, [o, k]) => a + (k ?? 0) * w.irr * (o === 'h' ? 1 : 0.4), 0);
  const solar = (th.glass * ENVELOPE.shgc * ENVELOPE.solarFactor * w.irr * 0.4) / 1000 + opaque;
  // las plantas vecinas también están apagadas: el acople por las losas no cambia la deriva
  return Math.min(freeFloat(z, temp, (tb - ta) / HOUR, plugs + solar, w.tExt, 0, temp), T_PROT_MAX);
}

/**
 * Temperatura de la zona con el aire apagado (noches y fines de semana): el modelo RC integrado hora a hora
 * con el clima real desde el último fin de jornada. Sube de día y baja de noche con la temperatura exterior y
 * el sol, con el retraso de la masa térmica; la protección por calor la limita a `tProtMax`.
 */
export function offTemp(z: Zone, t: number): number {
  const t0 = lastShutoff(t);
  let temp = SP_OCC + 0.5;
  let ta = t0;
  if (driftMemo.size > 60_000) {
    driftMemo.clear();
  }
  for (let k = Math.ceil(t0 / HOUR); k * HOUR <= t; k++) {
    const key = `${z.id}|${t0}|${k}`;
    let v = driftMemo.get(key);
    if (v === undefined) {
      v = driftStep(z, temp, ta, k * HOUR);
      driftMemo.set(key, v);
    }
    temp = v;
    ta = k * HOUR;
  }
  return t > ta ? driftStep(z, temp, ta, t) : temp;
}

function zoneCore(z: Zone, t: number, opts: SimOptions, buildingOccupied: boolean): ZoneCore {
  const c = clock(t);
  const w = weather(t, opts.events);
  const inc = incident(t, opts.demoIncidents !== false);
  const ev = zoneEvents(z, t, opts.events);
  const forced = activeOcc(z.id, t, opts)?.people !== undefined && z.occupants > 0;
  let occupants = plannedOccupants(z, t, c, opts);
  if (!forced && inc?.zone === z.id && inc.kind === 'sobreocupacion') {
    occupants = Math.round(z.occupants * 1.2);
  }
  if (!forced && ev.overcrowd > 0 && z.occupants > 0) {
    occupants = Math.round(z.occupants * (1 + ev.overcrowd));
  }
  if (ev.fireAnywhere) {
    // evacuación: el edificio se vacía en ≈ 5 minutos
    occupants = Math.round(occupants * Math.max(0, 1 - (t - ev.fireAnywhere.start) / (5 * MIN)));
  }
  // el pasillo no tiene aforo: se considera ocupado (tránsito) cuando hay gente en el edificio
  const occupiedReal = occupants > 0 || (z.type === 'pasillo' && buildingOccupied);
  // el EMS y el terminal usan el detector de presencia (que puede estar forzado o congelado)
  const sensor = activeSensor(z.id, t, opts);
  const frozen = sensor?.frozen ? sensor.frozenAt : undefined;
  const occupied = frozen ? frozen.occupied : (sensor?.presence ?? occupiedReal);
  const unitAdj = activeUnit(z.system, t, opts);
  // pre-enfriamiento escalonado: cada zona arranca en su turno y baja la consigna en rampa (RAMP_C_H °C/h)
  const startH = precoolStartH(z);
  const precool = c.weekday && c.h >= startH && c.h < ENTRY;
  let rampSp: number | undefined;
  let pulldownKw = 0;
  if (c.weekday && c.h >= startH && c.h < ENTRY + 3 && RAMP_C_H > 0 && z.fixedSetpoint === undefined) {
    const tStart = t - (c.h - startH) * HOUR;
    const sp = offTemp(z, tStart) - RAMP_C_H * (c.h - startH);
    if (sp > (opts.spOccupied ?? SP_OCC)) {
      rampSp = sp;
      pulldownKw = thermal(z).c * RAMP_C_H; // enfriar la masa térmica al ritmo de la rampa
    }
  }
  const workHours = c.weekday && c.h >= ENTRY - 0.5 && c.h < EXIT + 0.5;
  const baseline = opts.controller === 'baseline';
  const th = thermal(z);

  // ---- setpoint y habilitación (reglas EMS, o el horario de E+ en la línea base)
  let setpoint: number;
  let hvacEnable: boolean;
  if (z.fixedSetpoint !== undefined) {
    setpoint = z.fixedSetpoint;
    hvacEnable = true;
  } else if (baseline) {
    // modelo E+: setpoint constante (22 °C oficinas, 24 °C baños) las 24 h
    setpoint = scheduleValue(z.schedules.ac, c.dow, c.h);
    hvacEnable = true;
  } else if (occupied || precool) {
    setpoint = rampSp ?? opts.spOccupied ?? SP_OCC;
    hvacEnable = true;
  } else if (workHours) {
    setpoint = rampSp ?? SP_UNOCC;
    hvacEnable = true;
  } else {
    // fuera de horario el aire está apagado; sólo arranca como protección sobre tProtMax
    setpoint = EMS_RULES.tProtReturn;
    hvacEnable = false;
  }

  // ---- emergencia (planta de respaldo): consigna de emergencia y pasillos sin aire
  const emergency = ev.backup && !baseline && z.fixedSetpoint === undefined;
  if (emergency) {
    if (occupied || precool) {
      setpoint = Math.max(setpoint, BACKUP.setpoint, BACKUP.setpointMin);
    }
    if (BACKUP.noHvacTypes.includes(z.type)) {
      hvacEnable = false;
    }
  }

  // ---- control manual del operador
  const ov = activeOverride(z, t, opts);
  if (ov?.setpoint !== undefined) {
    // en emergencia nadie puede pedir más frío que el mínimo (protege la planta)
    setpoint = emergency ? Math.max(ov.setpoint, BACKUP.setpointMin) : ov.setpoint;
  }
  if (ov?.hvac === 'off') {
    hvacEnable = false;
  } else if (ov?.hvac === 'on' || ov?.setpoint !== undefined) {
    hvacEnable = true;
  }

  // ---- controlador local de la unidad (prioridad sobre el EMS)
  const unitMode: UnitStatus['mode'] = !unitAdj ? 'auto' : unitAdj.on === false ? 'apagado' : (unitAdj.mode ?? 'auto');
  if (unitAdj?.setpoint !== undefined) {
    setpoint = unitAdj.setpoint;
  }
  if (unitMode === 'frio') {
    hvacEnable = true;
  }
  const unitLocal =
    !!unitAdj && (unitMode !== 'auto' || unitAdj.setpoint !== undefined || unitAdj.capPct !== undefined);
  const capFrac = unitAdj?.capPct !== undefined ? unitAdj.capPct / 100 : 1;

  // ---- lo que «ve» el control: con un desfase regula la lectura (la zona real queda en setpoint − desfase);
  // con un valor fijo (o congelado) alto enfría a plena capacidad y con uno bajo deja de enfriar
  const seen = frozen?.temp ?? sensor?.tempValue;
  const frozenDetected = !!sensor?.frozen && t - sensor.since >= FROZEN_DETECT_MIN * MIN;
  const sensorCtl: 'normal' | 'full' | 'none' =
    seen === undefined || frozenDetected ? 'normal' : seen > setpoint + BAND ? 'full' : 'none';
  const spPhys = setpoint - (sensor?.tempOffset ?? 0);

  // ---- iluminación, enchufes y ganancia solar
  const glass = th.glass;
  const luxDay = (110 * ENVELOPE.vt * 0.25 * glass * w.irr * 0.4) / Math.max(z.area, 1);
  const target = EMS_RULES.luxTarget;
  const autoLights = baseline
    ? scheduleValue(z.schedules.lights, c.dow, c.h)
    : occupied
      ? Math.round(Math.min(1, Math.max(0.1, (target - luxDay) / target)) * 20) / 20
      : 0;
  let lights = ov?.lights ?? autoLights;
  if (ev.fireAnywhere && !ev.outage) {
    lights = 1; // iluminación plena para la evacuación
  }
  const sinRed = !!ev.outage && !ev.backup;
  if (emergency) {
    lights = Math.min(lights, BACKUP.lights);
  }
  const plugs = z.critical || baseline ? 1 : (ov?.plugs ?? (occupied ? 1 : EMS_RULES.plugsUnoccupied));
  const fEq = scheduleValue(z.schedules.equipment, c.dow, c.h);
  let pPlugs =
    ((z.epd * z.area) / 1000) * fEq * Math.max(plugs, 0.1) +
    (z.itKw ?? 0) * (1 + 0.02 * Math.sin((c.h / 24) * 2 * Math.PI)) +
    ev.extraKw;
  if (ev.backup && !z.critical) {
    pPlugs = 0; // los tomacorrientes de oficina no están en el tablero de emergencia
  }
  if (sinRed) {
    // sin red ni planta: sólo las cargas críticas siguen (UPS) hasta agotar su autonomía
    pPlugs = z.critical && !ev.upsDepleted ? pPlugs : 0;
    lights = z.critical && !ev.upsDepleted ? 0.3 : 0;
  }
  const pLights = ((z.lpd * z.area) / 1000) * lights;
  const opaqueSolar = Object.entries(th.solarOpaque).reduce(
    (a, [o, k]) => a + (k ?? 0) * w.irr * (o === 'h' ? 1 : 0.4),
    0
  );
  const solar = (glass * ENVELOPE.shgc * ENVELOPE.solarFactor * w.irr * 0.4) / 1000 + opaqueSolar;

  // ---- carga sensible relativa a la capacidad del terminal → modulación (mismo RC que el gemelo; las
  // plantas vecinas están acondicionadas a una temperatura parecida, el acople por las losas se desprecia)
  const vent = occupants * ENVELOPE.ventilationPerPerson * ENVELOPE.rhoCp;
  const envelope = th.ua * (w.tExt - spPhys) - th.uaSky * ENVELOPE.skyDeltaT + (th.gInf + vent) * (w.tExt - spPhys);
  const ground = th.uaGround * (ENVELOPE.tGround - spPhys);
  const internal = occupants * Q_PERSON + pLights + pPlugs + z.fanKw;
  // puerta o ventana abierta: aire exterior caliente (sensible) — el VRF también debe retirar su humedad
  const door = ev.doorFlow * ENVELOPE.rhoCp * Math.max(w.tExt - spPhys, 0) * 1.6;
  const load = Math.max(0, internal + solar + envelope + ground + door + pulldownKw);
  const plr = Math.min(1, load / Math.max(z.hvacKw, 0.01));
  const period = 30 * MIN;
  const phase = (((t / period + hash('fase', z.id)) % 1) + 1) % 1;

  let temp: number;
  let hvacOn: boolean;
  let mod = 0;
  const fault = inc?.zone === z.id ? inc : undefined;
  // período del ajuste que gobierna la zona (para la libre flotación o el enfriamiento forzado)
  const adjSince = Math.max(unitAdj?.since ?? -Infinity, sensor?.since ?? -Infinity);
  const ffHours = Number.isFinite(adjSince) ? (t - adjSince) / HOUR : 0;
  const ffGains = occupants * Q_PERSON + pLights + pPlugs + solar * 2;
  const unitNoCooling = unitMode === 'apagado' || unitMode === 'ventilacion';
  if (ev.noCoolingSince !== undefined) {
    // sin enfriamiento (falla, incendio o corte): libre flotación desde el inicio del evento
    const hours = (t - ev.noCoolingSince) / HOUR;
    // conato de incendio: 150 kW de calor en la zona (mismo valor que ems/eventos.py)
    const gains = occupants * Q_PERSON + pLights + pPlugs + solar * 2 + (ev.fire ? FIRE_KW : 0);
    // parte de la temperatura que tenía la zona: la de consigna si estaba climatizada, o la de deriva si el
    // aire ya estaba apagado por horario (así el corte no produce un salto)
    const scheduledOff = !occupied && !precool && !workHours && z.fixedSetpoint === undefined && !baseline;
    const spBefore = z.fixedSetpoint ?? (baseline ? setpoint : occupied || precool ? (opts.spOccupied ?? SP_OCC) : SP_UNOCC);
    const from = scheduledOff
      ? offTemp(z, ev.noCoolingSince)
      : ev.afterBackup && !baseline && z.fixedSetpoint === undefined && !ev.outage
        ? Math.max(spBefore, BACKUP.setpoint) // venía de la consigna de emergencia
        : spBefore;
    temp = freeFloat(z, from, hours, gains, w.tExt, ev.doorFlow * ENVELOPE.rhoCp);
    if (ev.fire) {
      temp = Math.min(temp, 95);
    } else if (ev.fireAnywhere && z.floor === ZONE_BY_ID[ev.fireAnywhere.zone ?? '']?.floor) {
      // humo y calor hacia las zonas vecinas del mismo piso
      temp += Math.min(4, (t - ev.fireAnywhere.start) / (6 * MIN));
    }
    hvacOn = false;
    hvacEnable = false;
  } else if (unitNoCooling || (hvacEnable && sensorCtl === 'none')) {
    // unidad apagada / sólo ventilación, o el control cree que ya hace frío: libre flotación
    temp = freeFloat(z, spPhys, ffHours, ffGains + (unitMode === 'ventilacion' ? z.fanKw : 0), w.tExt);
    hvacOn = false;
  } else if (hvacEnable && (sensorCtl === 'full' || plr > capFrac)) {
    // enfriamiento a plena capacidad (lectura alta) o limitado por el tope de la unidad
    hvacOn = capFrac > 0;
    mod = capFrac;
    temp = freeFloat(z, spPhys, ffHours, ffGains + z.fanKw - capFrac * z.hvacKw, w.tExt);
    temp = sensorCtl === 'full' ? Math.max(temp, 16) : Math.max(temp, spPhys);
  } else if (fault?.kind === 'falla_hvac') {
    const mins = (c.h - fault.from) * 60;
    temp = setpoint + BAND + Math.min(4, mins / 18);
    hvacOn = false;
  } else if (hvacEnable && plr > 0.02) {
    // a carga baja el VRF cicla (on/off con histéresis); por encima de PLR_MIN modula
    if (plr >= PLR_MIN) {
      hvacOn = true;
      mod = plr;
      temp = spPhys + 0.2 * Math.sin(2 * Math.PI * phase) + (plr - 0.5) * 0.4;
    } else {
      const duty = plr / PLR_MIN;
      hvacOn = phase < duty;
      mod = hvacOn ? PLR_MIN : 0;
      temp = hvacOn
        ? spPhys + BAND - (2 * BAND * phase) / duty
        : spPhys - BAND + (2 * BAND * (phase - duty)) / (1 - duty);
    }
    if (fault?.kind === 'sobreocupacion') {
      temp += Math.min(2.8, (c.h - fault.from) * 3.5);
    }
  } else if (ov?.hvac === 'off') {
    const mins = (t - ov.since) / MIN;
    const target = Math.min(w.tExt, 31) + (occupied ? 1.5 : 0.5);
    temp = SP_OCC + (target - SP_OCC) * (1 - Math.exp(-mins / 90));
    hvacOn = false;
  } else {
    // aire apagado fuera de horario: la zona sigue al clima exterior (protección por calor en tProtMax)
    temp = offTemp(z, t);
    hvacOn = !baseline && temp >= T_PROT_MAX - 0.05;
    if (hvacOn) {
      hvacEnable = true;
      mod = Math.max(PLR_MIN, plr);
    }
  }

  // recuperación tras rearrancar (toma de carga escalonada): la zona vuelve poco a poco a su consigna desde
  // lo que se calentó mientras esperaba su turno, con el compresor entrando en rampa y luego a más carga
  if (ev.recoverSince !== undefined && ev.transferAt !== undefined && hvacOn && ev.noCoolingSince === undefined) {
    const offHours = (ev.recoverSince - ev.transferAt) / HOUR;
    const start = ev.afterBackup && !baseline && z.fixedSetpoint === undefined ? Math.max(spPhys, BACKUP.setpoint) : spPhys;
    const rise = Math.max(0, Math.min(4, freeFloat(z, start, offHours, ffGains, w.tExt) - spPhys));
    const k = Math.exp(-(t - ev.recoverSince) / (RECOVERY_MIN * MIN));
    temp += rise * k;
    mod = Math.min(1, mod + 0.5 * k) * Math.min(1, (t - ev.recoverSince) / (10 * MIN));
  }
  if (ev.doorFlow > 0) {
    temp += Math.min(2.5, ev.doorFlow * 3);
  }
  const tempReal = temp;
  if (fault?.kind === 'sensor' || ev.sensor) {
    temp = setpoint + 0.12; // lectura congelada: el sensor deja de variar
  }
  // ---- lectura del sensor forzada por el operador
  if (frozen) {
    temp = frozen.temp;
  } else if (sensor?.tempValue !== undefined) {
    temp = sensor.tempValue + 0.16 * (hash('ruido', z.id, Math.floor(t / (5 * MIN))) - 0.5);
  } else if (sensor?.tempOffset !== undefined) {
    temp = tempReal + sensor.tempOffset;
  }
  // HR: el aire interior tiene la humedad del exterior menos lo que condensa el serpentín (el VRF no la controla)
  const rhReal = relHumidity(tempReal, Math.max(0.004, absHumidity(w.tExt, w.rh) - (hvacOn ? 0.0015 * mod : 0)));
  const rh = frozen ? frozen.rh : (sensor?.rh ?? rhReal);

  const cop = z.cop * (1 - 0.012 * (w.tExt - 30)) * (unitAdj?.copFactor ?? 1);
  // incluye el latente que condensa el serpentín (fraccion_latente_serpentin)
  const compressorKw = (mod * z.hvacKw * (1 + ENVELOPE.latentFraction)) / Math.max(cop, 1);
  const fanAlways = baseline && z.fanMode === 'continuo';
  const fan =
    sinRed || unitMode === 'apagado'
      ? 0
      : unitMode === 'ventilacion' || (hvacEnable && (occupied || hvacOn || fanAlways))
        ? z.fanKw
        : 0;
  const pHvac = (hvacOn ? compressorKw : 0) + fan;
  const lux = Math.round(luxDay + 500 * lights);
  return {
    temp,
    setpoint,
    occupants,
    occupied,
    lux,
    lights,
    plugs,
    hvacOn,
    hvacEnable,
    pLights,
    pPlugs,
    pHvac,
    pTotal: pLights + pPlugs + pHvac,
    sensorFault: fault?.kind === 'sensor' || ev.sensor || frozenDetected,
    tempReal,
    rh,
    rhReal,
    occupiedReal,
    ...(sensor
      ? {
          sensorForce: forceOf(sensor),
          sensorRemainingMin: Number.isFinite(sensor.until) ? (sensor.until - t) / MIN : undefined,
        }
      : {}),
    events: ev.kinds.length ? ev.kinds : undefined,
    fire: !!ev.fire,
    noPower: sinRed,
    peopleForced: forced || activeOcc('*', t, opts)?.pct !== undefined || undefined,
    override: !!ov,
    updatedAt: t,
    wantsCooling: hvacOn,
    compressorKw,
    urgency: temp - setpoint,
    copEff: Math.max(cop, 1),
    unitLocal,
  };
}

/** Cargas sin zona (ascensor, extractores de los baños): kW × horario del modelo E+. */
function fixedLoads(t: number, opts: SimOptions) {
  const c = clock(t);
  const act = activeEvents(opts.events, t);
  const outage = act.some((e) => e.kind === 'corte_energia');
  const backup = backupOn(act, t);
  let total = 0;
  let critical = 0;
  let q = 0;
  for (const f of FIXED_LOADS) {
    const fed = !outage || f.critical || (backup && f.backup);
    const p = fed ? f.kw * scheduleValue(f.schedule, c.dow, c.h) : 0;
    total += p;
    critical += f.critical ? p : 0;
    q += p * Math.tan(Math.acos(f.pf));
  }
  return { total, critical, q };
}

interface Core {
  zones: Record<string, ZoneCore>;
  pTotal: number;
  /** Generación fotovoltaica (kW AC; 0 sin FV, de noche o sin red por anti-isla). */
  pPv: number;
  forced: number;
}

/** Fotovoltaica del instante: área × fracción activa × eficiencia × G horizontal × inversor. */
export function pvKw(t: number, opts: SimOptions): number {
  const act = activeEvents(opts.events, t);
  const outage = act.find((e) => e.kind === 'corte_energia');
  // en un corte el inversor sólo sigue si la planta forma la red, y se reconecta unos minutos después
  if (!opts.pv || (outage && (!backupOn(act, t) || t - outage.start < BACKUP.pvReconnectMin * MIN))) {
    return 0;
  }
  return pvPowerKw(weather(t, opts.events).irr);
}

/** Potencias del instante t aplicando el limitador de demanda (sin demanda de 15 min). */
function core(t: number, opts: SimOptions): Core {
  const zones: Record<string, ZoneCore> = {};
  const c = clock(t);
  const buildingOccupied = ZONES.some((z) => !z.critical && plannedOccupants(z, t, c, opts) > 0);
  for (const z of ZONES) {
    zones[z.id] = zoneCore(z, t, opts, buildingOccupied);
  }
  const occ = ZONES.filter((z) => !z.critical);
  const fixed = fixedLoads(t, opts);
  let total = fixed.total + Object.values(zones).reduce((a, s) => a + s.pTotal, 0);
  const pPv = pvKw(t, opts);
  let forced = 0;
  // el limitador mira la importación neta de la red (lo que factura el medidor de la acometida)
  if (opts.controller !== 'baseline' && total - pPv > opts.limitKw - 3) {
    const candidates = occ
      .map((z) => zones[z.id])
      .filter(
        (s) =>
          s.hvacOn &&
          !s.sensorFault &&
          !s.override &&
          !s.unitLocal &&
          !s.events &&
          s.temp < EMS_RULES.comfortMax - EMS_RULES.drMarginC
      )
      .sort((a, b) => a.urgency - b.urgency);
    for (const s of candidates) {
      if (total - pPv <= opts.limitKw - 3) {
        break;
      }
      s.hvacOn = false;
      s.drForced = true;
      s.pHvac -= s.compressorKw;
      s.pTotal -= s.compressorKw;
      total -= s.compressorKw;
      forced++;
    }
  }
  return { zones, pTotal: total, pPv, forced };
}

/** Potencia total y estado térmico del instante (versión liviana de simulate, sin demanda ni alarmas). */
export function instant(
  t: number,
  opts: SimOptions
): {
  pTotal: number;
  pHvac: number;
  pPv: number;
  zones: Record<string, { temp: number; pHvac: number }>;
} {
  const c = core(t, opts);
  const zones: Record<string, { temp: number; pHvac: number }> = {};
  let pHvac = 0;
  for (const [id, z] of Object.entries(c.zones)) {
    zones[id] = { temp: z.temp, pHvac: z.pHvac };
    pHvac += z.pHvac;
  }
  return { pTotal: c.pTotal, pHvac, pPv: c.pPv, zones };
}

const PF = { hvac: 0.9, lights: 0.95, plugs: 0.92 };
const tanPhi = (pf: number) => Math.tan(Math.acos(pf));

/** `lite` omite la energía acumulada del día (para series históricas). */
export function simulate(t: number, opts: SimOptions, lite = false): Snapshot {
  const now = core(t, opts);
  const grid = (k: Core) => Math.max(k.pTotal - k.pPv, 0);
  const demand15 = (grid(now) + grid(core(t - 5 * MIN, opts)) + grid(core(t - 10 * MIN, opts))) / 3;
  const w = weather(t, opts.events);
  const c = clock(t);
  const fixed = fixedLoads(t, opts);
  const act = activeEvents(opts.events, t);
  const outage = act.find((e) => e.kind === 'corte_energia');
  const fire = act.find((e) => e.kind === 'incendio');

  const zones: Record<string, ZoneState> = {};
  let pHvac = 0;
  let pLights = 0;
  let pPlugs = 0;
  let pCritical = fixed.critical;
  let q = fixed.q;
  for (const z of ZONES) {
    const { wantsCooling: _w, compressorKw: _c, urgency: _u, copEff: _e, unitLocal: _l, ...s } = now.zones[z.id];
    zones[z.id] = { ...s, temp: Math.round(s.temp * 100) / 100 };
    pHvac += s.pHvac;
    pLights += s.pLights;
    pPlugs += s.pPlugs;
    q += s.pHvac * tanPhi(PF.hvac) + s.pLights * tanPhi(PF.lights) + s.pPlugs * tanPhi(PF.plugs);
    if (z.critical) {
      pCritical += s.pTotal;
    }
  }
  // sin red ni planta el medidor lee cero (el UPS alimenta las cargas críticas); con la planta de respaldo el
  // edificio sigue consumiendo, de la planta y de los paneles (recortados para respetar su carga mínima)
  const backup = !!outage && backupOn(act, t);
  const dark = !!outage && !backup;
  const upsKw = dark ? now.pTotal : pCritical;
  const pTotal = dark ? 0 : now.pTotal;
  if (dark) {
    q = 0;
  }
  const pvUsed = backup ? Math.max(0, Math.min(now.pPv, pTotal - BACKUP.loadMin * BACKUP.genKw)) : dark ? 0 : now.pPv;
  const pGen = backup ? pTotal - pvUsed : 0;
  const lPerH = backup ? BACKUP.idleLPerHKw * BACKUP.genKw + BACKUP.lPerKwh * pGen : 0;
  // sin estado: el diésel gastado se estima con el consumo actual durante lo que lleva el corte
  const fuelL = outage && backup ? Math.max(0, BACKUP.tankL - (lPerH * (t - outage.start)) / HOUR) : BACKUP.tankL;
  const s = Math.hypot(pTotal, q);
  const vll = dark ? 0 : BUILDING.vll * (1 - 0.0002 * pTotal) + 1.5 * Math.sin(t / (7 * MIN));
  const punta = c.weekday && c.h >= TARIFF.peakHours[0] && c.h < TARIFF.peakHours[1];
  const dayStart = Math.floor((t + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;

  const meter: MeterState = {
    pTotal,
    pCritical,
    pNonCritical: pTotal - pCritical,
    pHvac,
    pLights,
    pPlugs,
    pFixed: fixed.total,
    q,
    s,
    pf: s > 0 ? pTotal / s : 1,
    vll,
    i: vll > 0 ? (s * 1000) / (Math.sqrt(3) * vll) : 0,
    eKwh: lite ? 0 : energySince(dayStart, t, opts),
    demand15,
    tExt: w.tExt,
    rh: w.rh,
    irr: w.irr,
    price: punta ? TARIFF.peakUsdKwh : TARIFF.offPeakUsdKwh,
    ...(opts.pv
      ? {
          pPv: pvUsed,
          pGrid: outage ? 0 : pTotal - now.pPv,
          ePv: lite ? 0 : energySince(dayStart, t, opts, (k) => k.pPv),
        }
      : {}),
    updatedAt: t,
    gridOk: !outage,
    powerMode: !outage ? 'red' : backup ? 'generador' : (t - outage.start) / MIN < BACKUP.upsMinutes ? 'ups' : 'sin_energia',
    upsKw: outage ? upsKw : undefined,
    upsMinutes: outage ? (backup ? BACKUP.upsMinutes : Math.max(0, BACKUP.upsMinutes - (t - outage.start) / MIN)) : undefined,
    ...(BACKUP.enabled
      ? {
          pGen,
          genLoadPct: (100 * pGen) / BACKUP.genKw,
          genFuelL: fuelL,
          genFuelPct: (100 * fuelL) / BACKUP.tankL,
          genAutonomyH: lPerH > 0 ? fuelL / lPerH : 0,
          pPvCurtailed: backup ? now.pPv - pvUsed : 0,
        }
      : {}),
  };
  // la línea base no tiene limitador: sólo el supervisor avisa del pico (PICO_DEMANDA)
  const drActive = opts.controller !== 'baseline' && (now.forced > 0 || demand15 > opts.limitKw);
  const alarms = demoAlarms(t, zones, meter, opts, drActive);
  const ems: EmsState = {
    mode: opts.controller ?? 'reglas_dr',
    drActive,
    drStage: !drActive ? 0 : demand15 > opts.limitKw ? 2 : 1,
    limitKw: opts.limitKw,
    nAlarms: alarms.length,
    safeMode: Object.entries(zones)
      .filter(([, z]) => z.sensorFault)
      .map(([id]) => id),
    latencyMs: 0.2 + 0.3 * hash('lat', Math.floor(t / MIN)),
    events: act.length ? [...new Set(act.map((e) => e.kind))] : undefined,
    fireAlarm: !!fire,
  };
  return { time: t, zones, meter, ems, alarms, units: unitStatuses(t, now, opts) };
}

/** Estado de cada unidad VRF/PTAC (equivalente al tópico sim/controladores del gemelo). */
export function unitStatuses(t: number, k: Core, opts: SimOptions): Record<string, UnitStatus> {
  const act = activeEvents(opts.events, t);
  const outage = act.some((e) => e.kind === 'corte_energia');
  const backup = backupOn(act, t);
  const out: Record<string, UnitStatus> = {};
  for (const u of HVAC_SYSTEMS) {
    const zs = u.zones.map((id) => k.zones[id]).filter(Boolean);
    const pComp = zs.reduce((a, s) => a + (s.hvacOn ? s.compressorKw : 0), 0);
    const q = zs.reduce((a, s) => a + (s.hvacOn ? s.compressorKw * s.copEff : 0), 0);
    const adj = activeUnit(u.id, t, opts);
    const mode: UnitStatus['mode'] = !adj ? 'auto' : adj.on === false ? 'apagado' : (adj.mode ?? 'auto');
    out[u.id] = {
      pKw: zs.reduce((a, s) => a + s.pHvac, 0),
      qKw: q,
      loadPct: (100 * q) / u.capacityKw,
      cop: pComp > 1e-6 ? q / pComp : undefined,
      mode,
      on: mode !== 'apagado',
      capPct: adj?.capPct ?? 100,
      setpoint: adj?.setpoint,
      copFactor: adj?.copFactor ?? 1,
      forced: !!adj,
      remainingMin: adj && Number.isFinite(adj.until) ? (adj.until - t) / MIN : undefined,
      fault: act.some((e) => e.kind === 'falla_vrf' && e.unit === u.id),
      noPower: outage && (!backup || u.kind === 'ptac'),
      updatedAt: t,
    };
  }
  return out;
}

/** Energía acumulada del día (integración cada 15 min, suficiente para el indicador). */
/**
 * Memo por objeto de opciones (las opciones son inmutables: cada cambio crea un objeto nuevo y el WeakMap suelta
 * el anterior). La simulación es determinista en (t, opts), así que reutilizar un resultado es exacto.
 */
function memoByOpts<T>(limit: number) {
  const store = new WeakMap<SimOptions, Map<number, T>>();
  return (opts: SimOptions, t: number, make: () => T): T => {
    let m = store.get(opts);
    if (!m) {
      m = new Map();
      store.set(opts, m);
    }
    let v = m.get(t);
    if (v === undefined) {
      v = make();
      if (m.size >= limit) {
        // el más antiguo primero (orden de inserción)
        m.delete(m.keys().next().value!);
      }
      m.set(t, v);
    }
    return v;
  };
}

/** Potencias de los tramos de 15 min ya cerrados del día: no cambian entre refrescos de la pantalla. */
const energyCore = memoByOpts<Readonly<Pick<Core, 'pTotal' | 'pPv'>>>(200);

function energySince(
  from: number,
  to: number,
  opts: SimOptions,
  pick = (k: Pick<Core, 'pTotal' | 'pPv'>) => k.pTotal
): number {
  let e = 0;
  const step = 15 * MIN;
  for (let t = from; t < to; t += step) {
    const at = Math.min(t + step / 2, to);
    // el tramo abierto (el último) cambia con t; sólo se memorizan los centros de tramo, que se repiten
    const k =
      at === t + step / 2
        ? energyCore(opts, at, () => {
            const c = core(at, opts);
            return { pTotal: c.pTotal, pPv: c.pPv };
          })
        : core(at, opts);
    e += pick(k) * (Math.min(step, to - t) / HOUR);
  }
  return e;
}

function demoAlarms(
  t: number,
  zones: Record<string, ZoneState>,
  meter: MeterState,
  opts: SimOptions,
  dr: boolean
): EmsAlarm[] {
  const out: EmsAlarm[] = [];
  const inc = incident(t, opts.demoIncidents !== false);
  out.push(...eventAlarms(t, zones, meter, opts));
  out.push(...controllerAlarms(t, zones, opts));
  const c = clock(t);
  const startOf = (h: number) => t - (c.h - h) * HOUR;
  if (inc) {
    const z = zones[inc.zone];
    if (inc.kind === 'sensor') {
      out.push({
        ts: startOf(inc.from),
        level: 'crit',
        code: 'SENSOR_CONGELADO',
        zone: inc.zone,
        message: `Sensor de temperatura sin variación (${z.temp.toFixed(2)} °C) → modo seguro`,
        value: z.temp,
      });
    } else if (inc.kind === 'falla_hvac' && z.temp > 26) {
      out.push({
        ts: startOf(inc.from + 0.5),
        level: 'warn',
        code: 'TEMP_ALTA',
        zone: inc.zone,
        message: `${z.temp.toFixed(1)} °C > 26 °C con ocupación (falla de HVAC)`,
        value: z.temp,
      });
    } else if (inc.kind === 'sobreocupacion' && z.temp > 26) {
      out.push({
        ts: startOf(inc.from + 0.6),
        level: 'warn',
        code: 'TEMP_ALTA',
        zone: inc.zone,
        message: `${z.temp.toFixed(1)} °C > 26 °C: sala sobre su aforo (${z.occupants} personas)`,
        value: z.temp,
      });
    }
  }
  if (meter.demand15 > opts.limitKw) {
    out.push({
      ts: t,
      level: 'warn',
      code: 'PICO_DEMANDA',
      zone: 'EDIF',
      message: `Demanda 15 min ${meter.demand15.toFixed(1)} kW > ${opts.limitKw} kW`,
      value: meter.demand15,
    });
  }
  if (dr) {
    const forced = Object.entries(zones)
      .filter(([, z]) => z.drForced)
      .map(([id]) => id);
    out.push({
      ts: t,
      level: 'info',
      code: 'DR_ACTIVO',
      zone: 'EDIF',
      message: forced.length
        ? `Limitador de demanda: compresores en espera ${forced.join(', ')}`
        : 'Respuesta a la demanda activa',
    });
  }
  return out.sort((a, b) => ({ crit: 0, warn: 1, info: 2 })[a.level] - { crit: 0, warn: 1, info: 2 }[b.level]);
}

/** Alarmas que provocan los ajustes de controladores: el supervisor reacciona a lo que lee el sensor. */
function controllerAlarms(t: number, zones: Record<string, ZoneState>, opts: SimOptions): EmsAlarm[] {
  const out: EmsAlarm[] = [];
  for (const [id, sen] of Object.entries(opts.sensors ?? {})) {
    const z = zones[id];
    if (!z || t < sen.since || t >= sen.until) {
      continue;
    }
    const zone = ZONE_BY_ID[id];
    if (zone?.critical) {
      out.push({
        ts: sen.since,
        level: 'warn',
        code: 'AJUSTE_CRITICO',
        zone: id,
        message: `Sensor de la zona crítica ${id} forzado`,
      });
    }
    if (z.sensorFault && sen.frozen) {
      out.push({
        ts: sen.since + FROZEN_DETECT_MIN * MIN,
        level: 'crit',
        code: 'SENSOR_CONGELADO',
        zone: id,
        message: `Sensor de temperatura sin variación (${z.temp.toFixed(2)} °C) → modo seguro`,
        value: z.temp,
      });
    } else if (zone?.type === 'servidores' && z.temp > EMS_RULES.serverAlarm) {
      out.push({
        ts: t,
        level: 'crit',
        code: 'SERVIDOR_TEMP',
        zone: id,
        message: `Cuarto de servidores a ${z.temp.toFixed(1)} °C`,
        value: z.temp,
      });
    } else if (z.occupied && z.temp > EMS_RULES.comfortMax) {
      out.push({
        ts: t,
        level: 'warn',
        code: 'TEMP_ALTA',
        zone: id,
        message: `${z.temp.toFixed(1)} °C > ${EMS_RULES.comfortMax} °C con ocupación`,
        value: z.temp,
      });
    } else if (z.occupied && z.temp < EMS_RULES.comfortMin) {
      out.push({
        ts: t,
        level: 'info',
        code: 'TEMP_BAJA',
        zone: id,
        message: `${z.temp.toFixed(1)} °C < ${EMS_RULES.comfortMin} °C con ocupación`,
        value: z.temp,
      });
    }
  }
  for (const [id, adj] of Object.entries(opts.units ?? {})) {
    if (t >= adj.since && t < adj.until && HVAC_SYSTEMS.find((u) => u.id === id)?.critical) {
      out.push({
        ts: adj.since,
        level: 'warn',
        code: 'AJUSTE_CRITICO',
        zone: id,
        message: `Ajuste manual de ${id}, que atiende una zona crítica`,
      });
    }
  }
  return out;
}

/** Alarmas que el supervisor del EMS emitiría ante los eventos simulados. */
function eventAlarms(t: number, zones: Record<string, ZoneState>, meter: MeterState, opts: SimOptions): EmsAlarm[] {
  const out: EmsAlarm[] = [];
  const act = activeEvents(opts.events, t);
  const zonesOf = (e: SimEvent) => ZONES.filter((z) => affectsZone(e, z.id));
  for (const e of act) {
    const def = EVENTS[e.kind];
    switch (e.kind) {
      case 'incendio': {
        const z = e.zone ? zones[e.zone] : undefined;
        out.push({
          ts: e.start,
          level: 'crit',
          code: 'INCENDIO',
          zone: e.zone ?? 'EDIF',
          message: `Alarma de incendio${z ? ` (${z.temp.toFixed(0)} °C)` : ''}: evacuación y paro de la climatización (NFPA 90A)`,
          value: z?.temp,
        });
        break;
      }
      case 'corte_energia': {
        out.push({
          ts: e.start,
          level: 'crit',
          code: 'CORTE_ENERGIA',
          zone: 'EDIF',
          message:
            meter.powerMode === 'generador'
              ? 'Sin tensión en la acometida: transferencia automática a la planta de respaldo'
              : 'Sin tensión en la acometida y sin planta: VRF, iluminación y tomacorrientes sin servicio',
        });
        if (meter.powerMode === 'generador') {
          out.push({
            ts: e.start,
            level: 'warn',
            code: 'EN_PLANTA',
            zone: 'EDIF',
            message: `Planta de respaldo en marcha (${(meter.pGen ?? 0).toFixed(0)} kW, diésel ${(meter.genFuelPct ?? 0).toFixed(0)} %): VRF, ascensor, iluminación y servidores`,
            value: meter.pGen,
          });
          break;
        }
        const left = meter.upsMinutes ?? 0;
        out.push({
          ts: e.start,
          level: left > 0 ? 'warn' : 'crit',
          code: left > 0 ? 'EN_UPS' : 'UPS_AGOTADO',
          zone: 'EDIF',
          message:
            left > 0
              ? `Cargas críticas en UPS (${(meter.upsKw ?? 0).toFixed(1)} kW), autonomía ≈ ${left.toFixed(0)} min`
              : 'UPS agotado: servidores fuera de servicio',
          value: left,
        });
        break;
      }
      case 'falla_vrf':
        out.push({
          ts: e.start,
          level: 'crit',
          code: 'FALLA_VRF',
          zone: e.unit ?? 'EDIF',
          message: `${e.unit}: compresor sin respuesta, zonas ${zonesOf(e)
            .map((z) => z.id)
            .join(', ')} sin enfriamiento`,
        });
        break;
      case 'falla_terminal':
        out.push({
          ts: e.start,
          level: 'warn',
          code: 'FALLA_TERMINAL',
          zone: e.zone!,
          message: 'Terminal VRF sin enfriamiento',
        });
        break;
      case 'puerta_abierta':
        out.push({
          ts: e.start + 2 * MIN,
          level: 'warn',
          code: 'PUERTA_ABIERTA',
          zone: e.zone!,
          message: `Puerta/ventana abierta con HVAC en marcha (${e.intensity ?? 50} %)`,
        });
        break;
      case 'sensor': {
        const z = zones[e.zone!];
        out.push({
          ts: e.start,
          level: 'crit',
          code: 'SENSOR_CONGELADO',
          zone: e.zone!,
          message: `Sensor de temperatura sin variación (${z?.temp.toFixed(2)} °C) → modo seguro`,
          value: z?.temp,
        });
        break;
      }
      case 'ola_calor':
        out.push({
          ts: e.start,
          level: 'info',
          code: 'OLA_CALOR',
          zone: 'EDIF',
          message: `Temperatura exterior ${meter.tExt.toFixed(1)} °C (+${e.intensity ?? 4} °C): pre-enfriamiento y vigilancia de demanda`,
          value: meter.tExt,
        });
        break;
      case 'sobreocupacion':
        out.push({
          ts: e.start,
          level: 'warn',
          code: 'SOBREOCUPACION',
          zone: e.zone!,
          message: `${zones[e.zone!]?.occupants ?? '?'} personas (aforo ${ZONE_BY_ID[e.zone ?? '']?.occupants})`,
          value: zones[e.zone!]?.occupants,
        });
        break;
      case 'pico_carga':
        out.push({
          ts: e.start,
          level: def.level,
          code: 'CARGA_EXTRA',
          zone: e.zone!,
          message: `+${e.intensity ?? 10} kW de equipos no previstos`,
        });
        break;
    }
  }
  // consecuencias térmicas de los eventos
  for (const [id, z] of Object.entries(zones)) {
    if (!z.events || z.sensorFault) {
      continue;
    }
    const zone = ZONE_BY_ID[id];
    const limit = zone.type === 'servidores' ? EMS_RULES.serverAlarm : zone.critical ? 32 : EMS_RULES.comfortMax;
    if (z.temp > limit && !z.fire) {
      out.push({
        ts: t,
        level: zone.type === 'servidores' || z.temp > 30 ? 'crit' : 'warn',
        code: 'TEMP_ALTA',
        zone: id,
        message:
          zone.type === 'servidores'
            ? `${z.temp.toFixed(1)} °C > ${EMS_RULES.serverAlarm} °C (límite ASHRAE A1 recomendado): riesgo para los equipos`
            : `${z.temp.toFixed(1)} °C > ${limit} °C sin enfriamiento`,
        value: z.temp,
      });
    }
  }
  return out;
}

/** Tendencias simuladas: `points` muestras entre `end - span` y `end`. */
/** Instantáneas livianas de la tendencia: al avanzar la ventana un paso, todas menos una ya están calculadas. */
const historySnap = memoByOpts<Snapshot>(160);

export function simulateHistory(end: number, span: number, points: number, opts: SimOptions): History {
  const history: History = {};
  for (let i = 0; i < points; i++) {
    const t = end - span + (span * i) / (points - 1);
    const snap = historySnap(opts, t, () => simulate(t, opts, true));
    for (const [id, z] of Object.entries(snap.zones)) {
      const h = (history[id] ??= {});
      for (const k of ['temp', 'setpoint', 'occupants', 'pTotal', 'pHvac', 'lights'] as const) {
        (h[k] ??= []).push([t, Number(z[k])]);
      }
    }
    const m = (history.EDIF ??= {});
    for (const k of ['pTotal', 'demand15', 'pHvac', 'tExt'] as const) {
      (m[k] ??= []).push([t, snap.meter![k]]);
    }
    if (snap.meter?.pPv !== undefined) {
      (m.pPv ??= []).push([t, snap.meter.pPv]);
      (m.pGrid ??= []).push([t, snap.meter.pGrid ?? 0]);
    }
  }
  return history;
}
