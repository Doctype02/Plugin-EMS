import { DataFrame, FieldType } from '@grafana/data';
import { EMS_RULES, ZONES, ZONE_BY_ID, Zone } from './model';

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
  /** La zona está en control manual (override del operador). */
  override?: boolean;
  /** Eventos simulados activos en la zona (incendio, falla, puerta abierta…). */
  events?: string[];
  fire?: boolean;
  /** Sin suministro de red (corte de energía). */
  noPower?: boolean;
  /** La cantidad de personas la fijó el operador (escenario). */
  peopleForced?: boolean;
  /** Estado real del modelo cuando difiere de lo que mide el sensor (temperatura, HR, presencia). */
  tempReal?: number;
  /** HR que lee el sensor de la zona y HR real del aire (%). */
  rh?: number;
  rhReal?: number;
  occupiedReal?: boolean;
  /** Datos del sensor forzados por el operador (la física sigue con el estado real). */
  sensorForce?: SensorForce;
  /** Minutos que quedan del forzado (undefined = sin vencimiento). */
  sensorRemainingMin?: number;
  updatedAt: number;
}

/** Datos que lee el controlador de la zona, forzados por el operador (ems/controladores.py). */
export interface SensorForce {
  /** Descalibración de la temperatura (°C, se suma a la real). */
  tempOffset?: number;
  /** Temperatura fija (°C, con el ruido normal del sensor). Excluye `tempOffset`. */
  tempValue?: number;
  /** HR fija (%). */
  rh?: number;
  /** Detector de presencia forzado. */
  presence?: boolean;
  /** Todas las lecturas quedan fijas en el último valor. */
  frozen?: boolean;
}

export interface SensorOverride extends SensorForce {
  since: number;
  /** `Infinity` = hasta liberar. */
  until: number;
  user?: string;
  /** Lecturas en el instante del forzado (para «congelado» en el simulador local). */
  frozenAt?: { temp: number; rh: number; occupied: boolean };
}

export type SensorOverrides = Record<string, SensorOverride>;

/** Modo del controlador local de una unidad VRF/PTAC. */
export type UnitMode = 'auto' | 'frio' | 'ventilacion';

/** Ajuste del operador sobre una unidad (lo no indicado sigue en automático). */
export interface UnitAdjust {
  /** false = unidad apagada (compresor y terminales). */
  on?: boolean;
  mode?: UnitMode;
  /** Tope de capacidad total (%). */
  capPct?: number;
  /** Setpoint del controlador local para sus zonas (°C). */
  setpoint?: number;
  /** Multiplicador del COP (degradación simulada). */
  copFactor?: number;
}

export interface UnitAdjustment extends UnitAdjust {
  since: number;
  /** `Infinity` = hasta liberar. */
  until: number;
  user?: string;
}

export type UnitAdjustments = Record<string, UnitAdjustment>;

/** Estado real de una unidad VRF/PTAC (tópico sim/controladores, measurement `unidad`). */
export interface UnitStatus {
  pKw: number;
  /** Frío entregado (kW térmicos). */
  qKw: number;
  loadPct: number;
  /** COP real del paso (frío / potencia del compresor); undefined con el compresor parado. */
  cop?: number;
  mode: UnitMode | 'apagado';
  on: boolean;
  capPct: number;
  setpoint?: number;
  copFactor: number;
  /** Tiene un ajuste del operador. */
  forced: boolean;
  /** Minutos que quedan del ajuste (undefined = sin vencimiento). */
  remainingMin?: number;
  fault: boolean;
  noPower?: boolean;
  updatedAt: number;
}

/** Control manual temporal de una zona (tiene prioridad sobre las reglas del EMS y el limitador). */
export interface ZoneOverride {
  setpoint?: number;
  hvac?: 'on' | 'off';
  /** Nivel de iluminación 0–1. */
  lights?: number;
  /** Fracción de circuitos de enchufes energizados 0–1. */
  plugs?: number;
  since: number;
  until: number;
  user?: string;
}

export type Overrides = Record<string, ZoneOverride>;

/** Parámetros globales del EMS que el operador puede cambiar. */
export interface EmsParams {
  limitKw: number;
  spOccupied: number;
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
  /** Red disponible (false durante un corte de energía). */
  gridOk?: boolean;
  /** Carga alimentada por el UPS (kW) y autonomía restante (min). */
  upsKw?: number;
  upsMinutes?: number;
  /** De dónde se alimenta el edificio: red, planta de respaldo, sólo UPS o sin energía. */
  powerMode?: 'red' | 'generador' | 'ups' | 'sin_energia';
  /** Planta de respaldo: potencia (kW), carga (%), diésel (L y %), autonomía (h) y FV recortada (kW). */
  pGen?: number;
  genLoadPct?: number;
  genFuelL?: number;
  genFuelPct?: number;
  genAutonomyH?: number;
  pPvCurtailed?: number;
  /** Fotovoltaica (sólo en la variante con FV): generación AC, importación neta de la red (negativa =
   * exportación) y energía FV del día. */
  pPv?: number;
  pGrid?: number;
  ePv?: number;
}

export interface EmsState {
  mode: string;
  drActive: boolean;
  drStage: number;
  limitKw: number;
  nAlarms: number;
  safeMode: string[];
  latencyMs: number;
  /** Eventos simulados activos (para el banner de emergencia). */
  events?: string[];
  /** Alarma de incendio activa: climatización del edificio en paro. */
  fireAlarm?: boolean;
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

/** Cantidad de personas forzada por el operador (escenario de simulación): por zona o para todo el edificio ('*'). */
export interface OccupancyOverride {
  /** Personas fijas en la zona. */
  people?: number;
  /** Porcentaje del horario normal de ocupación (sólo para '*'). */
  pct?: number;
  since: number;
  until: number;
  user?: string;
}

export type OccupancyOverrides = Record<string, OccupancyOverride>;

export interface Snapshot {
  time: number;
  zones: Record<string, ZoneState>;
  /** Estado de las unidades VRF/PTAC (si el gemelo lo publica). */
  units?: Record<string, UnitStatus>;
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
  temp_real_c: 'tempReal',
  hr_pct: 'rh',
  hr_real_pct: 'rhReal',
  ocupado_real: 'occupiedReal',
};
const BOOL_ZONE = new Set<keyof ZoneState>(['occupied', 'hvacOn', 'hvacEnable', 'occupiedReal']);
/** Campos `sensor_*` de la zona mientras el sensor está forzado (docs/CONTRATO.md §3). */
const SENSOR_FIELDS: Record<string, keyof SensorForce> = {
  sensor_temp_offset_c: 'tempOffset',
  sensor_temp_fijo_c: 'tempValue',
  sensor_hr_fijo_pct: 'rh',
  sensor_presencia: 'presence',
  sensor_congelado: 'frozen',
};

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
  p_fv_kw: 'pPv',
  p_red_kw: 'pGrid',
  e_fv_kwh: 'ePv',
  ups_kw: 'upsKw',
  ups_min: 'upsMinutes',
  p_gen_kw: 'pGen',
  gen_carga_pct: 'genLoadPct',
  gen_combustible_l: 'genFuelL',
  gen_combustible_pct: 'genFuelPct',
  gen_autonomia_h: 'genAutonomyH',
  p_fv_recortada_kw: 'pPvCurtailed',
};
const POWER_MODES: Array<NonNullable<MeterState['powerMode']>> = ['sin_energia', 'red', 'generador', 'ups'];

const EMS_FIELDS: Record<string, keyof EmsState> = {
  dr_activo: 'drActive',
  limite_kw: 'limitKw',
  n_alarmas: 'nAlarms',
  latencia_ms: 'latencyMs',
};

const LEVELS: AlarmLevel[] = ['info', 'warn', 'crit'];

type Measurement = 'zona' | 'medidor' | 'ems' | 'alarma' | 'unidad';

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
  if (m && ['zona', 'medidor', 'ems', 'alarma', 'unidad'].includes(m)) {
    return m;
  }
  if (tags.unidad && keys.includes('carga_pct')) {
    return 'unidad';
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
    // Flux devuelve _start/_stop (límites del rango) además de _time: la marca de cada lectura es _time
    const timeFields = frame.fields.filter((f) => f.type === FieldType.time);
    const timeField =
      timeFields.find((f) => f.name === '_time' || f.name === 'Time' || f.name === 'time') ??
      timeFields.find((f) => f.name !== '_start' && f.name !== '_stop') ??
      timeFields[0];
    const stringCols = frame.fields.filter((f) => f.type === FieldType.string);
    const valueFields = frame.fields.filter((f) => f.type !== FieldType.time && f.type !== FieldType.string);
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
  const units: Record<string, UnitStatus> = {};
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
      // la fila más reciente decide si el sensor sigue forzado (los campos sensor_* sólo existen mientras dura)
      const forced = asNumber(row.values.sensor_forzado);
      if (forced !== undefined) {
        if (forced > 0) {
          const f: SensorForce = {};
          for (const [k, key] of Object.entries(SENSOR_FIELDS)) {
            const n = asNumber(row.values[k]);
            if (n !== undefined) {
              (f as Record<string, number | boolean>)[key] = key === 'presence' || key === 'frozen' ? n > 0 : n;
            }
          }
          const left = asNumber(row.values.sensor_restante_min);
          z.sensorForce = f;
          z.sensorRemainingMin = left === undefined || left < 0 ? undefined : left;
        } else {
          delete z.sensorForce;
          delete z.sensorRemainingMin;
        }
      }
      z.updatedAt = Math.max(z.updatedAt, row.time);
    } else if (row.measurement === 'unidad' && row.tags.unidad) {
      const u = unitFromRow(row);
      if (u && (units[row.tags.unidad]?.updatedAt ?? -1) <= row.time) {
        units[row.tags.unidad] = u;
      }
    } else if (row.measurement === 'medidor') {
      meter ??= {};
      const rec = meter as Record<string, number>;
      for (const [k, v] of Object.entries(row.values)) {
        const key = METER_FIELDS[k];
        const n = asNumber(v);
        if (k === 'red_ok' && n !== undefined) {
          meter.gridOk = n > 0;
        } else if (k === 'modo_energia_cod' && n !== undefined) {
          meter.powerMode = POWER_MODES[n] ?? 'red';
        }
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
    ...(Object.keys(units).length ? { units } : {}),
    meter: meter && meter.pTotal !== undefined ? (fillMeter(meter) as MeterState) : undefined,
    ems: ems ? fillEms(ems) : undefined,
    alarms: activeAlarms(alarms, time),
  };
  return { snapshot, history };
}

const UNIT_MODES = ['auto', 'frio', 'ventilacion', 'apagado'];

/** Estado de una unidad desde una fila de la measurement `unidad`. */
function unitFromRow(row: Row): UnitStatus | undefined {
  const v = row.values;
  const n = (k: string) => asNumber(v[k]);
  if (n('p_kw') === undefined) {
    return undefined;
  }
  const mode = String(v.modo ?? row.tags.modo ?? 'auto');
  const left = n('restante_min');
  return {
    pKw: n('p_kw') ?? 0,
    qKw: n('q_frio_kw') ?? 0,
    loadPct: n('carga_pct') ?? 0,
    cop: n('cop'),
    mode: (UNIT_MODES.includes(mode) ? mode : 'auto') as UnitStatus['mode'],
    on: (n('encendido') ?? 1) > 0,
    capPct: n('capacidad_pct') ?? 100,
    setpoint: n('setpoint_c'),
    copFactor: n('cop_factor') ?? 1,
    forced: (n('forzado') ?? 0) > 0,
    remainingMin: left === undefined || left < 0 ? undefined : left,
    fault: (n('falla') ?? 0) > 0,
    noPower: (n('sin_energia') ?? 0) > 0,
    updatedAt: row.time,
  };
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
    ...(m.pPv !== undefined ? { pPv: m.pPv, pGrid: m.pGrid ?? z(m.pTotal) - m.pPv, ePv: m.ePv } : {}),
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
export const COMFORT = { min: EMS_RULES.comfortMin, max: EMS_RULES.comfortMax, server: EMS_RULES.serverAlarm };

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
