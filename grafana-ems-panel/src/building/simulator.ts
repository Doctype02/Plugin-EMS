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
import { ZONES, Zone } from './model';
import { EmsAlarm, EmsState, History, MeterState, Overrides, Snapshot, ZoneOverride, ZoneState } from './telemetry';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ_OFFSET = -5 * HOUR; // America/Panama (sin horario de verano)

export interface SimOptions {
  limitKw: number;
  /** Setpoint con ocupación (por defecto 24 °C). */
  spOccupied?: number;
  overrides?: Overrides;
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

export function weather(t: number) {
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
  t: number
): { zone: string; kind: 'sensor' | 'falla_hvac' | 'sobreocupacion'; from: number; to: number } | undefined {
  const c = clock(t);
  if (!c.weekday) {
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

function zoneCore(z: Zone, t: number, opts: SimOptions, buildingOccupied: boolean): ZoneCore {
  const c = clock(t);
  const w = weather(t);
  const inc = incident(t);
  const noise = 1 + 0.1 * (hash(z.id, Math.floor(t / (5 * MIN))) - 0.5);
  let occupants = Math.round(occupancyFraction(z, c) * z.occupants * noise);
  if (inc?.zone === z.id && inc.kind === 'sobreocupacion') {
    occupants = Math.round(z.occupants * 1.2);
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
  const lights = ov?.lights ?? autoLights;
  const plugs = z.critical ? 1 : (ov?.plugs ?? (occupied ? 1 : 0.1));
  const fEq = scheduleValue(EQUIPMENT_SCHEDULE(z), c.dow, c.h);
  const pPlugs =
    ((z.epd * z.area) / 1000) * fEq * Math.max(plugs, 0.1) +
    (z.itKw ?? 0) * (1 + 0.02 * Math.sin((c.h / 24) * 2 * Math.PI));
  const pLights = ((z.lpd * z.area) / 1000) * lights;
  const solar = (glass * 0.252 * 0.5 * w.irr * 0.4) / 1000;

  // ---- carga sensible relativa a la capacidad del terminal VRF → modulación
  const envelope = ((glass * 6.424) / 1000) * (w.tExt - 6 - setpoint);
  const ground = z.floor === 0 ? ((2.945 * z.area) / 1000) * (T_GROUND - setpoint) : 0;
  const internal = occupants * 0.075 + pLights + pPlugs + z.fanKw;
  const load = Math.max(0, internal + solar + envelope + ground);
  const plr = Math.min(1, load / Math.max(z.hvacKw, 0.01));
  const period = 30 * MIN;
  const phase = (((t / period + hash('fase', z.id)) % 1) + 1) % 1;

  let temp: number;
  let hvacOn: boolean;
  let mod = 0;
  const fault = inc?.zone === z.id ? inc : undefined;
  if (fault?.kind === 'falla_hvac') {
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

  if (fault?.kind === 'sensor') {
    temp = setpoint + 0.12; // lectura congelada: el sensor deja de variar
  }

  const cop = z.cop * (1 - 0.012 * (w.tExt - 30));
  const compressorKw = (mod * z.hvacKw * 1.1) / Math.max(cop, 1); // incluye ≈10 % de latente del serpentín
  const fan = hvacEnable && (occupied || hvacOn) ? z.fanKw : 0;
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
    sensorFault: fault?.kind === 'sensor',
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
      .filter((s) => s.hvacOn && !s.sensorFault && !s.override && s.temp < 26 - 0.75)
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

const PF = { hvac: 0.9, lights: 0.95, plugs: 0.92 };
const tanPhi = (pf: number) => Math.tan(Math.acos(pf));

export function simulate(t: number, opts: SimOptions): Snapshot {
  const now = core(t, opts);
  const demand15 = (now.pTotal + core(t - 5 * MIN, opts).pTotal + core(t - 10 * MIN, opts).pTotal) / 3;
  const w = weather(t);
  const c = clock(t);
  const fixed = fixedLoads();

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
  const pTotal = now.pTotal;
  const s = Math.hypot(pTotal, q);
  const vll = 208 * (1 - 0.0004 * pTotal) + 0.8 * Math.sin(t / (7 * MIN));
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
    pf: pTotal / s,
    vll,
    i: (s * 1000) / (Math.sqrt(3) * vll),
    eKwh: energySince(dayStart, t, opts),
    demand15,
    tExt: w.tExt,
    rh: w.rh,
    irr: w.irr,
    price: punta ? 0.245 : 0.185,
    updatedAt: t,
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
  const inc = incident(t);
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

/** Tendencias simuladas: `points` muestras entre `end - span` y `end`. */
export function simulateHistory(end: number, span: number, points: number, opts: SimOptions): History {
  const history: History = {};
  for (let i = 0; i < points; i++) {
    const t = end - span + (span * i) / (points - 1);
    const snap = simulate(t, opts);
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
