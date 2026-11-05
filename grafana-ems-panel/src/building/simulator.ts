/**
 * Telemetría simulada del edificio para el modo demostración.
 *
 * Es una función pura del tiempo (mismo instante → mismo resultado), lo que permite reconstruir las
 * tendencias sin guardar estado. Reproduce de forma simplificada la lógica del EMS en Python
 * (ems/control.py, clase ReglasDR): setpoints por ocupación, pre-enfriamiento, termostato on/off con
 * histéresis, aprovechamiento de luz natural, corte de standby y limitador de demanda por rotación de
 * compresores. Además inyecta un incidente diario distinto para que las alarmas se vean en la demo.
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

const ENTRY = 7.5;
const EXIT = 17.5;
const BAND = 0.5;
const SP_OCC = 24;
const SP_UNOCC = 27;
const SP_NIGHT = 29;
const STANDBY = 0.45;
const MIN_PLUGS: Partial<Record<string, number>> = { Z07: 0.25, Z08: 0.35 };
const LUX_DAY: Record<string, number> = {
  Z01: 650,
  Z02: 380,
  Z03: 450,
  Z04: 380,
  Z05: 450,
  Z06: 300,
  Z07: 300,
  Z08: 500,
  Z09: 0,
  Z10: 150,
};

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

const ramp = (h: number, a: number, b: number, w = 0.5) =>
  Math.max(0, Math.min(1, (h - (a - w / 2)) / w, (b + w / 2 - h) / w));

function occupancyFraction(z: Zone, c: Clock): number {
  const base = ramp(c.h, ENTRY, EXIT, 1);
  const lunch = ramp(c.h, 12, 13, 0.3);
  let f: number;
  switch (z.type) {
    case 'oficina':
      f = base * (1 - 0.45 * lunch) * 0.92;
      break;
    case 'lobby': {
      const peaks = [ENTRY, 12, 13, EXIT].reduce((a, p) => a + Math.exp(-((c.h - p) ** 2) / (2 * 0.25 ** 2)), 0);
      f = Math.min(1, 0.25 * base + 0.75 * peaks);
      break;
    }
    case 'conferencia': {
      f = 0;
      for (const start of [9, 10.5, 14, 15.5]) {
        if (hash('reunion', c.day, start) < 0.55 && c.h >= start && c.h < start + 1.25) {
          f = 0.4 + 0.6 * hash('llenado', c.day, start);
        }
      }
      f *= base;
      break;
    }
    case 'laboratorio':
      f = ramp(c.h, ENTRY + 0.5, EXIT - 1, 1) * (1 - 0.5 * lunch) * 0.85;
      break;
    case 'cafeteria':
      f = Math.min(1, 0.3 * ramp(c.h, 7, 8.5) + ramp(c.h, 11.75, 13.5) + 0.15 * base);
      break;
    case 'servidores':
      f = 0.6 * ramp(c.h, 9, 10, 0.25);
      break;
    case 'soporte':
      return 1;
    default:
      f = base;
  }
  if (c.dow === 6) {
    f *= 0.15;
  } else if (c.dow === 0) {
    f = 0;
  }
  return f;
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
    { zone: 'Z03', kind: 'sensor' as const, from: 10, to: 11 },
    { zone: 'Z04', kind: 'falla_hvac' as const, from: 13, to: 14.5 },
    { zone: 'Z06', kind: 'sobreocupacion' as const, from: 14, to: 15.5 },
  ];
  const k = kinds[c.day % kinds.length];
  return c.h >= k.from && c.h < k.to ? k : undefined;
}

interface ZoneCore extends ZoneState {
  wantsCooling: boolean;
  compressorKw: number;
  urgency: number;
}

function zoneCore(z: Zone, t: number, opts: SimOptions): ZoneCore {
  const c = clock(t);
  const w = weather(t);
  const inc = incident(t);
  const noise = 1 + 0.08 * (hash(z.id, Math.floor(t / (5 * MIN))) - 0.5);
  let occupants = Math.round(occupancyFraction(z, c) * z.occupants * noise);
  if (inc?.zone === z.id && inc.kind === 'sobreocupacion') {
    occupants = Math.round(z.occupants * 1.15);
  }
  const occupied = occupants > 0;
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

  // ---- carga térmica relativa → ciclo de trabajo del compresor
  const solar = (z.windows?.length ?? 0) * 0.04 * (w.irr / 850);
  const internal =
    (occupants * 0.075 + (z.lpd * z.area) / 1000 + ((z.epd * z.area) / 1000) * 0.6 + (z.itKw ?? 0)) / z.hvacKw;
  const envelope = Math.max(0, w.tExt - setpoint) * 0.035;
  const duty = Math.min(0.95, Math.max(0.15, internal + solar + envelope));
  const period = 25 * MIN;
  const phase = (((t / period + hash('fase', z.id)) % 1) + 1) % 1;

  let temp: number;
  let hvacOn: boolean;
  const fault = inc?.zone === z.id ? inc : undefined;
  if (fault?.kind === 'falla_hvac') {
    const mins = (c.h - fault.from) * 60;
    temp = setpoint + BAND + Math.min(4, mins / 18);
    hvacOn = false;
  } else if (hvacEnable) {
    hvacOn = phase < duty;
    // enfría de sp+banda a sp-banda durante "duty", y sube durante el resto
    temp = hvacOn
      ? setpoint + BAND - (2 * BAND * phase) / duty
      : setpoint - BAND + (2 * BAND * (phase - duty)) / (1 - duty);
    if (fault?.kind === 'sobreocupacion') {
      temp += Math.min(2.8, (c.h - fault.from) * 3.5);
    }
  } else if (ov?.hvac === 'off') {
    // apagado manual: se calienta desde el setpoint previo hacia el exterior
    const mins = (t - ov.since) / MIN;
    const target = Math.min(w.tExt, 31) + (occupied ? 1.5 : 0.5);
    temp = SP_OCC + (target - SP_OCC) * (1 - Math.exp(-mins / 90));
    hvacOn = false;
  } else {
    // sin HVAC: deriva hacia el equilibrio nocturno
    const hoursOff = c.h >= EXIT ? c.h - EXIT : c.h + 24 - EXIT;
    temp = 24.6 + (Math.min(w.tExt, 29) - 24.6 + 1.2) * (1 - Math.exp(-hoursOff / 4));
    hvacOn = false;
  }

  if (fault?.kind === 'sensor') {
    temp = setpoint + 0.12; // lectura congelada: el sensor deja de variar
  }

  // ---- iluminación y enchufes
  const luxDay = (LUX_DAY[z.id] ?? 0) * (w.irr / 850);
  const autoLights = occupied
    ? Math.round(Math.min(1, Math.max(0.1, (500 - luxDay) / 500)) * 20) / 20
    : z.critical
      ? 0.3
      : 0;
  const lights = ov?.lights ?? autoLights;
  const plugs = ov?.plugs ?? (occupied || z.critical ? 1 : 0.1);
  const use = Math.min(occupants / Math.max(z.occupants, 1), 1);
  const pPlugs =
    ((z.epd * z.area) / 1000) * (use + (1 - use) * STANDBY) * Math.max(plugs, MIN_PLUGS[z.id] ?? 0.1) +
    (z.itKw ?? 0) * (1 + 0.03 * Math.sin((c.h / 24) * 2 * Math.PI));
  const pLights = ((z.lpd * z.area) / 1000) * lights;
  const cop = z.cop * (1 - 0.015 * (w.tExt - 30));
  const compressorKw = z.hvacKw / Math.max(cop, 1);
  const fan = hvacEnable && (occupied || hvacOn) ? 0.08 * z.hvacKw * 0.6 : 0;
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

function fixedLoads(t: number, buildingOccupancy: number) {
  const w = weather(t);
  const f = Math.min(buildingOccupancy * 1.5, 1);
  const elevators = 1 + 5 * f;
  const pumps = 1.5 + 1.5 * f;
  const exterior = w.irr < 5 ? 3.5 : 0;
  return {
    total: elevators + pumps + exterior,
    critical: elevators + pumps,
    q: elevators * 0.75 + pumps * 0.62 + exterior * 0.33,
  };
}

interface Core {
  zones: Record<string, ZoneCore>;
  pTotal: number;
  forced: number;
}

/** Potencias del instante t aplicando el limitador de demanda (sin demanda de 15 min). */
function core(t: number, opts: SimOptions): Core {
  const zones: Record<string, ZoneCore> = {};
  for (const z of ZONES) {
    zones[z.id] = zoneCore(z, t, opts);
  }
  const occ = ZONES.filter((z) => !z.critical);
  const fraction = occ.reduce((a, z) => a + zones[z.id].occupants, 0) / occ.reduce((a, z) => a + z.occupants, 0);
  const fixed = fixedLoads(t, fraction);
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

const PF = { hvac: 0.85, lights: 0.95, plugs: 0.92 };
const tanPhi = (pf: number) => Math.tan(Math.acos(pf));

export function simulate(t: number, opts: SimOptions): Snapshot {
  const now = core(t, opts);
  const demand15 = (now.pTotal + core(t - 5 * MIN, opts).pTotal + core(t - 10 * MIN, opts).pTotal) / 3;
  const w = weather(t);
  const c = clock(t);
  const occ = ZONES.filter((z) => !z.critical);
  const fraction = occ.reduce((a, z) => a + now.zones[z.id].occupants, 0) / occ.reduce((a, z) => a + z.occupants, 0);
  const fixed = fixedLoads(t, fraction);

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
  const vll = 480 * (1 - 0.00012 * pTotal) + 1.5 * Math.sin(t / (7 * MIN));
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
