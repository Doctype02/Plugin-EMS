/**
 * Telemetría simulada del edificio para el modo demostración.
 *
 * Es una función pura del tiempo (mismo instante → mismo resultado), lo que permite reconstruir las
 * tendencias sin guardar estado. Usa los parámetros y horarios del modelo OpenStudio/EnergyPlus del
 * proyecto (ocupación, iluminación y equipos por horario; terminales VRF con COP estacional) y
 * reproduce de forma simplificada la lógica del EMS en Python (ems/control.py, clase ReglasDR):
 * setpoints por ocupación, pre-enfriamiento, terminal VRF modulante con histéresis, luz natural,
 * corte de standby y limitador de demanda. Inyecta un incidente diario para que se vean las alarmas.
 */
import { ENVELOPE, ZONES, Zone, thermal } from './model';
import { EVENTS, EventKind, SimEvent, activeEvents, affectsZone } from './events';
import { EmsAlarm, EmsState, History, MeterState, Overrides, Snapshot, ZoneOverride, ZoneState } from './telemetry';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ_OFFSET = -5 * HOUR; // America/Panama (sin horario de verano)
const FIRE_KW = 150;

export interface SimOptions {
  limitKw: number;
  /** Setpoint con ocupación (por defecto 24 °C). */
  spOccupied?: number;
  overrides?: Overrides;
  /** Eventos simulados por el operador (fallas, accidentes, condiciones extremas). */
  events?: SimEvent[];
  /** Incidente de demostración diario (desactívelo para controlar los eventos a mano). */
  demoIncidents?: boolean;
}

export function activeOverride(zone: Zone, t: number, opts: SimOptions): ZoneOverride | undefined {
  const ov = opts.overrides?.[zone.id];
  return ov && !zone.critical && t >= ov.since && t < ov.until ? ov : undefined;
}

const ENTRY = 7;
const EXIT = 18;
const BAND = 0.5;
const SP_OCC = 24;
const SP_UNOCC = 27;
const SP_NIGHT = 29;
const PLR_MIN = 0.15;
const T_GROUND = 18; // terreno del modelo E+ (valor por defecto de EnergyPlus)

type Profile = Array<[number, number]>;
interface Schedule {
  weekday: Profile;
  saturday: Profile;
  sunday: Profile;
}

/** Horarios del modelo E+ (Schedule:Day:Interval): [hora de inicio, valor]. */
export const SCHEDULES: Record<string, Schedule> = {
  ocupacion: {
    weekday: [
      [0, 0],
      [7, 0.204],
      [8, 0.602],
      [9, 1],
      [12, 0.612],
      [13, 1],
      [17, 0.505],
      [18, 0],
    ],
    saturday: [
      [0, 0],
      [9, 0.202],
      [13, 0],
    ],
    sunday: [[0, 0]],
  },
  iluminacion: {
    weekday: [
      [0, 0],
      [7, 0.25],
      [8, 1],
      [18, 0.245],
      [19, 0],
    ],
    saturday: [
      [0, 0],
      [9, 0.527],
      [13, 0],
    ],
    sunday: [[0, 0]],
  },
  equipos_oficina: {
    weekday: [
      [0, 0.05],
      [7, 0.25],
      [8, 0.99],
      [18, 0.25],
      [20, 0.05],
    ],
    saturday: [
      [0, 0.05],
      [7, 0.25],
      [8, 0.99],
      [13, 0.25],
      [20, 0.05],
    ],
    sunday: [
      [0, 0.05],
      [7, 0.25],
      [8, 0.99],
      [13, 0.25],
      [20, 0.05],
    ],
  },
  equipos_conferencia: {
    weekday: [
      [0, 0.05],
      [7, 0.25],
      [8, 0.995],
      [11, 0.1],
      [15, 0.995],
      [18, 0.25],
      [20, 0.05],
    ],
    saturday: [[0, 0.05]],
    sunday: [[0, 0.05]],
  },
  continuo: { weekday: [[0, 1]], saturday: [[0, 1]], sunday: [[0, 1]] },
};

export function scheduleValue(name: string, dow: number, h: number): number {
  const s = SCHEDULES[name];
  const p = dow === 0 ? s.sunday : dow === 6 ? s.saturday : s.weekday;
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

const OCCUPANCY_SCHEDULE: Record<string, string> = { Z06: 'iluminacion' }; // como en el IDF
const EQUIPMENT_SCHEDULE = (z: Zone) =>
  z.critical ? 'continuo' : z.type === 'conferencia' ? 'equipos_conferencia' : 'equipos_oficina';

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
  const f = scheduleValue(OCCUPANCY_SCHEDULE[z.id] ?? 'ocupacion', c.dow, c.h);
  const absent = c.weekday ? 0.08 * hash('ausentismo', z.id, c.day) * 2 : 0;
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
    { zone: 'Z06', kind: 'falla_hvac' as const, from: 13, to: 14.5 },
    { zone: 'Z03', kind: 'sobreocupacion' as const, from: 14, to: 15.5 },
  ];
  const k = kinds[c.day % kinds.length];
  return c.h >= k.from && c.h < k.to ? k : undefined;
}

interface ZoneCore extends ZoneState {
  wantsCooling: boolean;
  compressorKw: number;
  urgency: number;
}

/** Estado de los eventos del instante para una zona. */
interface ZoneEvents {
  kinds: EventKind[];
  /** Inicio del período sin enfriamiento (falla, incendio o corte), si lo hay. */
  noCoolingSince?: number;
  fire?: SimEvent;
  fireAnywhere?: SimEvent;
  outage?: SimEvent;
  /** El UPS se agotó: las cargas críticas también se apagan. */
  upsDepleted: boolean;
  doorFlow: number;
  extraKw: number;
  overcrowd: number;
  sensor: boolean;
}

function zoneEvents(z: Zone, t: number, events?: SimEvent[]): ZoneEvents {
  const act = activeEvents(events, t);
  const mine = act.filter((e) => affectsZone(e, z.id));
  const fireAnywhere = act.find((e) => e.kind === 'incendio');
  const outage = act.find((e) => e.kind === 'corte_energia');
  const upsDepleted = !!outage && t - outage.start > (outage.intensity ?? 30) * MIN;
  const starts = [
    ...mine.filter((e) => e.kind === 'falla_terminal' || e.kind === 'falla_vrf').map((e) => e.start),
    ...(fireAnywhere ? [fireAnywhere.start] : []),
    ...(outage ? [outage.start] : []),
  ];
  return {
    kinds: [...new Set(mine.map((e) => e.kind))],
    noCoolingSince: starts.length ? Math.min(...starts) : undefined,
    fire: mine.find((e) => e.kind === 'incendio'),
    fireAnywhere,
    outage,
    upsDepleted,
    doorFlow: mine
      .filter((e) => e.kind === 'puerta_abierta')
      .reduce((a, e) => a + 0.6 * ((e.intensity ?? 50) / 100), 0),
    extraKw: mine.filter((e) => e.kind === 'pico_carga').reduce((a, e) => a + (e.intensity ?? 10), 0),
    overcrowd: mine.filter((e) => e.kind === 'sobreocupacion').reduce((a, e) => a + (e.intensity ?? 50) / 100, 0),
    sensor: mine.some((e) => e.kind === 'sensor'),
  };
}

/** Temperatura de libre flotación (modelo RC de la zona) desde t0 con las ganancias actuales. */
export function freeFloat(z: Zone, t0Temp: number, hours: number, gainsKw: number, tExt: number, extraG = 0): number {
  const th = thermal(z);
  const g = th.ua + th.gInf + extraG + th.uaGround;
  const teq =
    (th.ua * (tExt - ENVELOPE.skyDeltaT) + (th.gInf + extraG) * tExt + th.uaGround * ENVELOPE.tGround + gainsKw) / g;
  return teq + (t0Temp - teq) * Math.exp(-Math.max(hours, 0) / Math.max(th.c / g, 0.05));
}

function zoneCore(z: Zone, t: number, opts: SimOptions, buildingOccupied: boolean): ZoneCore {
  const c = clock(t);
  const w = weather(t, opts.events);
  const inc = incident(t, opts.demoIncidents !== false);
  const ev = zoneEvents(z, t, opts.events);
  const noise = 1 + 0.1 * (hash(z.id, Math.floor(t / (5 * MIN))) - 0.5);
  let occupants = Math.round(occupancyFraction(z, c) * z.occupants * noise);
  if (inc?.zone === z.id && inc.kind === 'sobreocupacion') {
    occupants = Math.round(z.occupants * 1.2);
  }
  if (ev.overcrowd > 0 && z.occupants > 0) {
    occupants = Math.round(z.occupants * (1 + ev.overcrowd));
  }
  if (ev.fireAnywhere) {
    // evacuación: el edificio se vacía en ≈ 5 minutos
    occupants = Math.round(occupants * Math.max(0, 1 - (t - ev.fireAnywhere.start) / (5 * MIN)));
  }
  // el pasillo no tiene aforo: se considera ocupado (tránsito) cuando hay gente en el edificio
  const occupied = occupants > 0 || (z.type === 'pasillo' && buildingOccupied);
  const precool = c.weekday && c.h >= ENTRY - 1 && c.h < ENTRY;
  const workHours = c.weekday && c.h >= ENTRY - 0.5 && c.h < EXIT + 0.5;

  // ---- setpoint y habilitación (reglas EMS)
  let setpoint: number;
  let hvacEnable: boolean;
  if (z.fixedSetpoint !== undefined) {
    setpoint = z.fixedSetpoint;
    hvacEnable = true;
  } else if (occupied || precool) {
    setpoint = opts.spOccupied ?? SP_OCC;
    hvacEnable = true;
  } else if (workHours) {
    setpoint = SP_UNOCC;
    hvacEnable = true;
  } else {
    setpoint = SP_NIGHT;
    hvacEnable = false;
  }

  // ---- control manual del operador
  const ov = activeOverride(z, t, opts);
  if (ov?.setpoint !== undefined) {
    setpoint = ov.setpoint;
  }
  if (ov?.hvac === 'off') {
    hvacEnable = false;
  } else if (ov?.hvac === 'on' || ov?.setpoint !== undefined) {
    hvacEnable = true;
  }

  // ---- iluminación, enchufes y ganancia solar
  const glass = Object.values(z.glazing).reduce((a, v) => a + (v ?? 0), 0);
  const luxDay = (110 * 0.252 * 0.25 * glass * w.irr * 0.4) / Math.max(z.area, 1);
  const autoLights = occupied ? Math.round(Math.min(1, Math.max(0.1, (500 - luxDay) / 500)) * 20) / 20 : 0;
  let lights = ov?.lights ?? autoLights;
  if (ev.fireAnywhere && !ev.outage) {
    lights = 1; // iluminación plena para la evacuación
  }
  const sinRed = !!ev.outage;
  const plugs = z.critical ? 1 : (ov?.plugs ?? (occupied ? 1 : 0.1));
  const fEq = scheduleValue(EQUIPMENT_SCHEDULE(z), c.dow, c.h);
  let pPlugs =
    ((z.epd * z.area) / 1000) * fEq * Math.max(plugs, 0.1) +
    (z.itKw ?? 0) * (1 + 0.02 * Math.sin((c.h / 24) * 2 * Math.PI)) +
    ev.extraKw;
  if (sinRed) {
    // sin red: sólo las cargas críticas siguen (UPS) hasta agotar su autonomía
    pPlugs = z.critical && !ev.upsDepleted ? pPlugs : 0;
    lights = z.critical && !ev.upsDepleted ? 0.3 : 0;
  }
  const pLights = ((z.lpd * z.area) / 1000) * lights;
  const solar = (glass * 0.252 * 0.5 * w.irr * 0.4) / 1000;

  // ---- carga sensible relativa a la capacidad del terminal VRF → modulación
  const envelope = ((glass * 6.424) / 1000) * (w.tExt - 6 - setpoint);
  const ground = z.floor === 0 ? ((2.945 * z.area) / 1000) * (T_GROUND - setpoint) : 0;
  const internal = occupants * 0.075 + pLights + pPlugs + z.fanKw;
  // puerta o ventana abierta: aire exterior caliente (sensible) — el VRF también debe retirar su humedad
  const door = ev.doorFlow * ENVELOPE.rhoCp * Math.max(w.tExt - setpoint, 0) * 1.6;
  const load = Math.max(0, internal + solar + envelope + ground + door);
  const plr = Math.min(1, load / Math.max(z.hvacKw, 0.01));
  const period = 30 * MIN;
  const phase = (((t / period + hash('fase', z.id)) % 1) + 1) % 1;

  let temp: number;
  let hvacOn: boolean;
  let mod = 0;
  const fault = inc?.zone === z.id ? inc : undefined;
  if (ev.noCoolingSince !== undefined) {
    // sin enfriamiento (falla, incendio o corte): libre flotación desde el inicio del evento
    const hours = (t - ev.noCoolingSince) / HOUR;
    // conato de incendio: 150 kW de calor en la zona (mismo valor que ems/eventos.py)
    const gains = occupants * 0.075 + pLights + pPlugs + solar * 2 + (ev.fire ? FIRE_KW : 0);
    temp = freeFloat(z, setpoint, hours, gains, w.tExt, ev.doorFlow * ENVELOPE.rhoCp);
    if (ev.fire) {
      temp = Math.min(temp, 95);
    } else if (ev.fireAnywhere && z.floor === ZONES.find((x) => x.id === ev.fireAnywhere!.zone)?.floor) {
      // humo y calor hacia las zonas vecinas del mismo piso
      temp += Math.min(4, (t - ev.fireAnywhere.start) / (6 * MIN));
    }
    hvacOn = false;
    hvacEnable = false;
  } else if (fault?.kind === 'falla_hvac') {
    const mins = (c.h - fault.from) * 60;
    temp = setpoint + BAND + Math.min(4, mins / 18);
    hvacOn = false;
  } else if (hvacEnable && plr > 0.02) {
    // a carga baja el VRF cicla (on/off con histéresis); por encima de PLR_MIN modula
    if (plr >= PLR_MIN) {
      hvacOn = true;
      mod = plr;
      temp = setpoint + 0.2 * Math.sin(2 * Math.PI * phase) + (plr - 0.5) * 0.4;
    } else {
      const duty = plr / PLR_MIN;
      hvacOn = phase < duty;
      mod = hvacOn ? PLR_MIN : 0;
      temp = hvacOn
        ? setpoint + BAND - (2 * BAND * phase) / duty
        : setpoint - BAND + (2 * BAND * (phase - duty)) / (1 - duty);
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
    // sin HVAC: deriva nocturna (la planta baja se enfría por el terreno a 18 °C)
    const hoursOff = c.h >= EXIT ? c.h - EXIT : c.h + 24 - EXIT;
    const target = z.floor === 0 ? 22.2 : 25.5;
    temp = 24 + (target - 24) * (1 - Math.exp(-hoursOff / 4));
    hvacOn = false;
  }

  if (fault?.kind === 'sensor' || ev.sensor) {
    temp = setpoint + 0.12; // lectura congelada: el sensor deja de variar
  }
  if (ev.doorFlow > 0) {
    temp += Math.min(2.5, ev.doorFlow * 3);
  }

  const cop = z.cop * (1 - 0.012 * (w.tExt - 30));
  const compressorKw = (mod * z.hvacKw * 1.1) / Math.max(cop, 1); // incluye ≈10 % de latente del serpentín
  const fan = hvacEnable && !sinRed && (occupied || hvacOn) ? z.fanKw : 0;
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
    sensorFault: fault?.kind === 'sensor' || ev.sensor,
    events: ev.kinds.length ? ev.kinds : undefined,
    fire: !!ev.fire,
    noPower: sinRed,
    override: !!ov,
    updatedAt: t,
    wantsCooling: hvacOn,
    compressorKw,
    urgency: temp - setpoint,
  };
}

/** El modelo E+ no tiene cargas fijas (ascensores, bombas, alumbrado exterior). */
function fixedLoads() {
  return { total: 0, critical: 0, q: 0 };
}

interface Core {
  zones: Record<string, ZoneCore>;
  pTotal: number;
  forced: number;
}

/** Potencias del instante t aplicando el limitador de demanda (sin demanda de 15 min). */
function core(t: number, opts: SimOptions): Core {
  const zones: Record<string, ZoneCore> = {};
  const c = clock(t);
  const buildingOccupied = ZONES.some((z) => !z.critical && occupancyFraction(z, c) > 0);
  for (const z of ZONES) {
    zones[z.id] = zoneCore(z, t, opts, buildingOccupied);
  }
  const occ = ZONES.filter((z) => !z.critical);
  const fixed = fixedLoads();
  let total = fixed.total + Object.values(zones).reduce((a, s) => a + s.pTotal, 0);
  let forced = 0;
  if (total > opts.limitKw - 3) {
    const candidates = occ
      .map((z) => zones[z.id])
      .filter((s) => s.hvacOn && !s.sensorFault && !s.override && !s.events && s.temp < 26 - 0.75)
      .sort((a, b) => a.urgency - b.urgency);
    for (const s of candidates) {
      if (total <= opts.limitKw - 3) {
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
  return { zones, pTotal: total, forced };
}

/** Potencia total y estado térmico del instante (versión liviana de simulate, sin demanda ni alarmas). */
export function instant(
  t: number,
  opts: SimOptions
): { pTotal: number; pHvac: number; zones: Record<string, { temp: number; pHvac: number }> } {
  const c = core(t, opts);
  const zones: Record<string, { temp: number; pHvac: number }> = {};
  let pHvac = 0;
  for (const [id, z] of Object.entries(c.zones)) {
    zones[id] = { temp: z.temp, pHvac: z.pHvac };
    pHvac += z.pHvac;
  }
  return { pTotal: c.pTotal, pHvac, zones };
}

const PF = { hvac: 0.9, lights: 0.95, plugs: 0.92 };
const tanPhi = (pf: number) => Math.tan(Math.acos(pf));

/** `lite` omite la energía acumulada del día (para series históricas). */
export function simulate(t: number, opts: SimOptions, lite = false): Snapshot {
  const now = core(t, opts);
  const demand15 = (now.pTotal + core(t - 5 * MIN, opts).pTotal + core(t - 10 * MIN, opts).pTotal) / 3;
  const w = weather(t, opts.events);
  const c = clock(t);
  const fixed = fixedLoads();
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
    const { wantsCooling: _w, compressorKw: _c, urgency: _u, ...s } = now.zones[z.id];
    zones[z.id] = { ...s, temp: Math.round(s.temp * 100) / 100 };
    pHvac += s.pHvac;
    pLights += s.pLights;
    pPlugs += s.pPlugs;
    q += s.pHvac * tanPhi(PF.hvac) + s.pLights * tanPhi(PF.lights) + s.pPlugs * tanPhi(PF.plugs);
    if (z.critical) {
      pCritical += s.pTotal;
    }
  }
  // durante un corte el medidor de la acometida lee cero; el UPS alimenta las cargas críticas
  const upsKw = outage ? now.pTotal : 0;
  const pTotal = outage ? 0 : now.pTotal;
  if (outage) {
    q = 0;
  }
  const s = Math.hypot(pTotal, q);
  const vll = outage ? 0 : 208 * (1 - 0.0004 * pTotal) + 0.8 * Math.sin(t / (7 * MIN));
  const punta = c.weekday && c.h >= 9 && c.h < 17;
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
    price: punta ? 0.245 : 0.185,
    updatedAt: t,
    gridOk: !outage,
    upsKw: outage ? upsKw : undefined,
    upsMinutes: outage ? Math.max(0, (outage.intensity ?? 30) - (t - outage.start) / MIN) : undefined,
  };
  const drActive = now.forced > 0 || demand15 > opts.limitKw;
  const alarms = demoAlarms(t, zones, meter, opts, drActive);
  const ems: EmsState = {
    mode: 'reglas_dr',
    drActive,
    drStage: demand15 > opts.limitKw ? 2 : drActive ? 1 : 0,
    limitKw: opts.limitKw,
    nAlarms: alarms.length,
    safeMode: Object.entries(zones)
      .filter(([, z]) => z.sensorFault)
      .map(([id]) => id),
    latencyMs: 0.2 + 0.3 * hash('lat', Math.floor(t / MIN)),
    events: act.length ? [...new Set(act.map((e) => e.kind))] : undefined,
    fireAlarm: !!fire,
  };
  return { time: t, zones, meter, ems, alarms };
}

/** Energía acumulada del día (integración cada 15 min, suficiente para el indicador). */
function energySince(from: number, to: number, opts: SimOptions): number {
  let e = 0;
  const step = 15 * MIN;
  for (let t = from; t < to; t += step) {
    e += core(Math.min(t + step / 2, to), opts).pTotal * (Math.min(step, to - t) / HOUR);
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
          message: 'Sin tensión en la acometida: VRF, iluminación y tomacorrientes sin servicio',
        });
        const left = meter.upsMinutes ?? 0;
        out.push({
          ts: e.start,
          level: left > 0 ? 'warn' : 'crit',
          code: left > 0 ? 'EN_UPS' : 'UPS_AGOTADO',
          zone: 'Z09',
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
          message: `${zones[e.zone!]?.occupants ?? '?'} personas (aforo ${ZONES.find((z) => z.id === e.zone)?.occupants})`,
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
    const zone = ZONES.find((x) => x.id === id)!;
    const limit = zone.type === 'servidores' ? 27 : zone.critical ? 32 : 26;
    if (z.temp > limit && !z.fire) {
      out.push({
        ts: t,
        level: zone.type === 'servidores' || z.temp > 30 ? 'crit' : 'warn',
        code: 'TEMP_ALTA',
        zone: id,
        message:
          zone.type === 'servidores'
            ? `${z.temp.toFixed(1)} °C > 27 °C (límite ASHRAE A1 recomendado): riesgo para los equipos`
            : `${z.temp.toFixed(1)} °C > ${limit} °C sin enfriamiento`,
        value: z.temp,
      });
    }
  }
  return out;
}

/** Tendencias simuladas: `points` muestras entre `end - span` y `end`. */
export function simulateHistory(end: number, span: number, points: number, opts: SimOptions): History {
  const history: History = {};
  for (let i = 0; i < points; i++) {
    const t = end - span + (span * i) / (points - 1);
    const snap = simulate(t, opts, true);
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
  }
  return history;
}
