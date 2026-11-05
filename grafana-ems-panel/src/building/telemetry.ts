import { DataFrame, FieldType } from '@grafana/data';
import { ZONES, ZONE_BY_ID, Zone } from './model';

export type Status = 'ok' | 'warning' | 'critical' | 'offline';
export const STATUS_LABELS: Record<Status, string> = {
  ok: 'Normal',
  warning: 'Alerta',
  critical: 'Crítico',
  offline: 'Sin datos',
};
const SEVERITY: Record<Status, number> = { critical: 0, warning: 1, ok: 2, offline: 3 };

export interface ZoneState {
  temp: number;
  setpoint: number;
  occupants: number;
  occupied: boolean;
  lux: number;
  lights: number;
  plugs: number;
  hvacOn: boolean;
  hvacEnable: boolean;
  pLights: number;
  pPlugs: number;
  pHvac: number;
  pTotal: number;
  /** Compresor bloqueado por el limitador de demanda en este paso (sólo simulación/estado EMS). */
  drForced?: boolean;
  sensorFault?: boolean;
  updatedAt: number;
}

export interface MeterState {
  pTotal: number;
  pCritical: number;
  pNonCritical: number;
  pHvac: number;
  pLights: number;
  pPlugs: number;
  pFixed: number;
  q: number;
  s: number;
  pf: number;
  vll: number;
  i: number;
  eKwh: number;
  demand15: number;
  tExt: number;
  rh: number;
  irr: number;
  price: number;
  updatedAt: number;
}

export interface EmsState {
  mode: string;
  drActive: boolean;
  drStage: number;
  limitKw: number;
  nAlarms: number;
  safeMode: string[];
  latencyMs: number;
}

export type AlarmLevel = 'info' | 'warn' | 'crit';

export interface EmsAlarm {
  ts: number;
  level: AlarmLevel;
  code: string;
  zone: string;
  message: string;
  value?: number;
}

export interface Snapshot {
  time: number;
  zones: Record<string, ZoneState>;
  meter?: MeterState;
  ems?: EmsState;
  alarms: EmsAlarm[];
}

/** Series por zona (o 'EDIF' para el medidor) y campo, para tendencias. */
export type History = Record<string, Record<string, Array<[number, number]>>>;

// ------------------------------------------------------------------ mapeo del contrato (docs/CONTRATO.md §3)
const ZONE_FIELDS: Record<string, keyof ZoneState> = {
  temp_c: 'temp',
  setpoint_c: 'setpoint',
  ocupantes: 'occupants',
  ocupado: 'occupied',
  lux: 'lux',
  luces_nivel: 'lights',
  equipos_nivel: 'plugs',
  hvac_on: 'hvacOn',
  hvac_enable: 'hvacEnable',
  p_luces_kw: 'pLights',
  p_equipos_kw: 'pPlugs',
  p_hvac_kw: 'pHvac',
  p_total_kw: 'pTotal',
};
const BOOL_ZONE = new Set<keyof ZoneState>(['occupied', 'hvacOn', 'hvacEnable']);

const METER_FIELDS: Record<string, keyof MeterState> = {
  p_total_kw: 'pTotal',
  p_critica_kw: 'pCritical',
  p_no_critica_kw: 'pNonCritical',
  p_hvac_kw: 'pHvac',
  p_luces_kw: 'pLights',
  p_equipos_kw: 'pPlugs',
  p_fija_kw: 'pFixed',
  q_kvar: 'q',
  s_kva: 's',
  fp: 'pf',
  v_ll: 'vll',
  i_a: 'i',
  e_kwh: 'eKwh',
  demanda_15min_kw: 'demand15',
  t_ext_c: 'tExt',
  hr_pct: 'rh',
  irr_wm2: 'irr',
  precio_usd_kwh: 'price',
};

const EMS_FIELDS: Record<string, keyof EmsState> = {
  dr_activo: 'drActive',
  limite_kw: 'limitKw',
  n_alarmas: 'nAlarms',
  latencia_ms: 'latencyMs',
};

const LEVELS: AlarmLevel[] = ['info', 'warn', 'crit'];

type Measurement = 'zona' | 'medidor' | 'ems' | 'alarma';

interface Row {
  measurement?: Measurement;
  zone?: string;
  time: number;
  values: Record<string, number | string | boolean>;
  tags: Record<string, string>;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function guessMeasurement(keys: string[], tags: Record<string, string>): Measurement | undefined {
  const m = tags._measurement as Measurement | undefined;
  if (m && ['zona', 'medidor', 'ems', 'alarma'].includes(m)) {
    return m;
  }
  if (keys.includes('mensaje') || tags.codigo) {
    return 'alarma';
  }
  if (tags.zona && keys.some((k) => k in ZONE_FIELDS)) {
    return 'zona';
  }
  if (keys.some((k) => k in EMS_FIELDS && !(k in METER_FIELDS))) {
    return 'ems';
  }
  if (keys.some((k) => k in METER_FIELDS)) {
    return 'medidor';
  }
  return undefined;
}

/**
 * Convierte los data frames de Grafana a filas (tiempo, etiquetas, campos).
 * Acepta formato ancho (consulta Flux con `pivot`, una columna por campo y `zona` como columna o etiqueta)
 * y formato largo (un campo de valor por frame con etiquetas `_field`, `_measurement`, `zona`, …).
 */
export function framesToRows(series: DataFrame[]): Row[] {
  const rows: Row[] = [];
  for (const frame of series) {
    const timeField = frame.fields.find((f) => f.type === FieldType.time);
    const stringCols = frame.fields.filter((f) => f.type === FieldType.string);
    const valueFields = frame.fields.filter((f) => f !== timeField && f.type !== FieldType.string);
    const frameTags: Record<string, string> = {};
    for (const f of frame.fields) {
      Object.assign(frameTags, f.labels ?? {});
    }
    for (let r = 0; r < frame.length; r++) {
      const tags: Record<string, string> = { ...frameTags };
      const values: Row['values'] = {};
      for (const f of stringCols) {
        const v = f.values[r];
        if (v === null || v === undefined) {
          continue;
        }
        if (['mensaje', 'modo'].includes(f.name)) {
          values[f.name] = String(v);
        } else {
          tags[f.name] = String(v);
        }
      }
      for (const f of valueFields) {
        const key = f.labels?._field ?? f.name;
        const v = f.values[r];
        if (v !== null && v !== undefined) {
          values[key] = v;
        }
      }
      const time = timeField ? Number(timeField.values[r]) : Date.now();
      const keys = Object.keys(values);
      rows.push({ measurement: guessMeasurement(keys, tags), zone: tags.zona, time, values, tags });
    }
  }
  return rows;
}

export function snapshotFromFrames(series: DataFrame[]): { snapshot: Snapshot; history: History } {
  const rows = framesToRows(series).sort((a, b) => a.time - b.time);
  const zones: Record<string, ZoneState> = {};
  const history: History = {};
  let meter: Partial<MeterState> | undefined;
  let ems: Partial<EmsState> | undefined;
  const alarms: EmsAlarm[] = [];
  let time = 0;

  const push = (key: string, field: string, t: number, v: number) => {
    const h = (history[key] ??= {});
    (h[field] ??= []).push([t, v]);
  };

  for (const row of rows) {
    time = Math.max(time, row.time);
    if (row.measurement === 'zona' && row.zone && ZONE_BY_ID[row.zone]) {
      const z = (zones[row.zone] ??= emptyZone(ZONE_BY_ID[row.zone]));
      const rec = z as unknown as Record<string, number | boolean>;
      for (const [k, v] of Object.entries(row.values)) {
        const key = ZONE_FIELDS[k];
        const n = asNumber(v);
        if (!key || n === undefined) {
          continue;
        }
        rec[key] = BOOL_ZONE.has(key) ? n > 0 : n;
        push(row.zone, key, row.time, n);
      }
      z.updatedAt = Math.max(z.updatedAt, row.time);
    } else if (row.measurement === 'medidor') {
      meter ??= {};
      const rec = meter as Record<string, number>;
      for (const [k, v] of Object.entries(row.values)) {
        const key = METER_FIELDS[k];
        const n = asNumber(v);
        if (key && n !== undefined) {
          rec[key] = n;
          push('EDIF', key, row.time, n);
        }
      }
      meter.updatedAt = row.time;
    } else if (row.measurement === 'ems') {
      ems ??= { safeMode: [], drStage: 0, mode: row.tags.modo ?? 'ems' };
      for (const [k, v] of Object.entries(row.values)) {
        const key = EMS_FIELDS[k];
        const n = asNumber(v);
        if (key === 'drActive' && n !== undefined) {
          ems.drActive = n > 0;
        } else if (key && n !== undefined) {
          (ems as Record<string, number>)[key] = n;
        }
      }
      if (row.tags.modo) {
        ems.mode = row.tags.modo;
      }
    } else if (row.measurement === 'alarma') {
      const level = (LEVELS.includes(row.tags.nivel as AlarmLevel) ? row.tags.nivel : 'warn') as AlarmLevel;
      alarms.push({
        ts: row.time,
        level,
        code: row.tags.codigo ?? 'ALARMA',
        zone: row.tags.zona ?? 'EDIF',
        message: String(row.values.mensaje ?? row.tags.codigo ?? ''),
        value: asNumber(row.values.valor),
      });
    }
  }
  const snapshot: Snapshot = {
    time,
    zones,
    meter: meter && meter.pTotal !== undefined ? (fillMeter(meter) as MeterState) : undefined,
    ems: ems ? fillEms(ems) : undefined,
    alarms: activeAlarms(alarms, time),
  };
  return { snapshot, history };
}

function emptyZone(z: Zone): ZoneState {
  return {
    temp: NaN,
    setpoint: z.fixedSetpoint ?? 24,
    occupants: 0,
    occupied: false,
    lux: 0,
    lights: 0,
    plugs: 0,
    hvacOn: false,
    hvacEnable: false,
    pLights: 0,
    pPlugs: 0,
    pHvac: 0,
    pTotal: 0,
    updatedAt: 0,
  };
}

function fillMeter(m: Partial<MeterState>): MeterState {
  const z = (v?: number) => v ?? 0;
  return {
    pTotal: z(m.pTotal),
    pCritical: z(m.pCritical),
    pNonCritical: z(m.pNonCritical),
    pHvac: z(m.pHvac),
    pLights: z(m.pLights),
    pPlugs: z(m.pPlugs),
    pFixed: z(m.pFixed),
    q: z(m.q),
    s: z(m.s),
    pf: m.pf ?? 1,
    vll: z(m.vll),
    i: z(m.i),
    eKwh: z(m.eKwh),
    demand15: m.demand15 ?? z(m.pTotal),
    tExt: z(m.tExt),
    rh: z(m.rh),
    irr: z(m.irr),
    price: z(m.price),
    updatedAt: z(m.updatedAt),
  };
}

function fillEms(e: Partial<EmsState>): EmsState {
  return {
    mode: e.mode ?? 'ems',
    drActive: !!e.drActive,
    drStage: e.drStage ?? (e.drActive ? 1 : 0),
    limitKw: e.limitKw ?? 0,
    nAlarms: e.nAlarms ?? 0,
    safeMode: e.safeMode ?? [],
    latencyMs: e.latencyMs ?? 0,
  };
}

/** Las alarmas del EMS se registran por flanco; se consideran activas las de la última hora. */
export function activeAlarms(alarms: EmsAlarm[], now: number, windowMs = 3_600_000): EmsAlarm[] {
  const latest = new Map<string, EmsAlarm>();
  for (const a of alarms) {
    if (now - a.ts <= windowMs) {
      latest.set(`${a.zone}:${a.code}`, a);
    }
  }
  return sortAlarms([...latest.values()]);
}

const LEVEL_ORDER: Record<AlarmLevel, number> = { crit: 0, warn: 1, info: 2 };
export function sortAlarms(alarms: EmsAlarm[]): EmsAlarm[] {
  return [...alarms].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.ts - a.ts);
}

// ------------------------------------------------------------------ estado por zona
export const COMFORT = { min: 21, max: 26, server: 27 };

export function zoneStatus(zone: Zone, s: ZoneState | undefined, alarms: EmsAlarm[]): Status {
  if (!s || !Number.isFinite(s.temp)) {
    return 'offline';
  }
  const own = alarms.filter((a) => a.zone === zone.id);
  if (s.sensorFault || own.some((a) => a.level === 'crit') || (zone.type === 'servidores' && s.temp > COMFORT.server)) {
    return 'critical';
  }
  if (own.some((a) => a.level === 'warn') || (s.occupied && (s.temp > COMFORT.max || s.temp < COMFORT.min))) {
    return 'warning';
  }
  return 'ok';
}

export function worstStatus(statuses: Status[]): Status {
  return [...statuses].sort((a, b) => SEVERITY[a] - SEVERITY[b])[0] ?? 'offline';
}

export function zoneStatuses(snapshot: Snapshot): Record<string, Status> {
  return Object.fromEntries(ZONES.map((z) => [z.id, zoneStatus(z, snapshot.zones[z.id], snapshot.alarms)]));
}
