/**
 * Comandos del operador hacia el EMS (docs/CONTRATO.md §2, tópicos `ems/<edif>/ems/override` y
 * `ems/<edif>/ems/parametros`). En modo demostración se aplican al simulador del navegador; en modo
 * en vivo se envían por HTTP al flujo de Node-RED, que los publica por MQTT y los respeta en sus reglas.
 */
import { CONTROLLER_LIMITS, HVAC_BY_ID, LIMIT_RANGE, ZONE_BY_ID } from './model';
import {
  EmsParams,
  OccupancyOverrides,
  Overrides,
  SensorForce,
  SensorOverrides,
  UnitAdjust,
  UnitAdjustments,
  ZoneOverride,
} from './telemetry';
import { SimEvent, describeEvent } from './events';

export interface ZoneCommand {
  zone: string;
  setpoint?: number;
  hvac?: 'on' | 'off';
  lights?: number;
  plugs?: number;
  durationMin: number;
}

export type Command =
  | { kind: 'override'; cmd: ZoneCommand }
  | { kind: 'release'; zone: string | '*' }
  | { kind: 'params'; params: Partial<EmsParams> }
  /** Simulación de un evento (falla, accidente, condición extrema) en el gemelo digital. */
  | { kind: 'event'; event: SimEvent }
  | { kind: 'event_stop'; id: string | '*' }
  /** Cantidad de personas: fija en una zona (`people`) o % del horario en todo el edificio (`zone: '*'`, `pct`). */
  | { kind: 'occupancy'; zone: string | '*'; people?: number; pct?: number; durationMin: number }
  | { kind: 'occupancy_release'; zone: string | '*' }
  /** Ajuste del controlador local de una unidad VRF/PTAC (sin `durationMin` = hasta liberar). */
  | { kind: 'unit'; unit: string; adjust: UnitAdjust; durationMin?: number; confirm?: boolean }
  | { kind: 'unit_release'; unit: string | '*' }
  /** Datos forzados del sensor de una zona (la física no cambia). */
  | { kind: 'sensor'; zone: string; force: SensorForce; durationMin?: number; confirm?: boolean }
  | { kind: 'sensor_release'; zone: string | '*' };

/** Rango del setpoint con ocupación (`sp_ocupado`) y de los setpoints manuales por zona (°C). */
export const SP_RANGE: [number, number] = [20, 28];

/** Resultado de ejecutar uno o varios comandos del operador. */
export interface CommandResult {
  ok: number;
  failed: number;
  /** Motivos de los comandos rechazados o con error de envío. */
  errors: string[];
}

/** Estado del último envío, para mostrarlo junto a los controles. */
export interface SendFeedback {
  phase: 'sending' | 'ok' | 'error';
  text: string;
  at: number;
}

/** Valida los parámetros del EMS contra el contrato (limite_kw 42–561 kW, sp_ocupado 20–28 °C). */
export function validateParams(params: Partial<EmsParams>): string | undefined {
  const { limitKw, spOccupied } = params;
  if (limitKw === undefined && spOccupied === undefined) {
    return 'No hay cambios que aplicar';
  }
  if (limitKw !== undefined && (!Number.isFinite(limitKw) || limitKw < LIMIT_RANGE[0] || limitKw > LIMIT_RANGE[1])) {
    return `El límite de demanda debe estar entre ${LIMIT_RANGE[0]} y ${LIMIT_RANGE[1]} kW`;
  }
  if (
    spOccupied !== undefined &&
    (!Number.isFinite(spOccupied) || spOccupied < SP_RANGE[0] || spOccupied > SP_RANGE[1])
  ) {
    return `El setpoint con ocupación debe estar entre ${SP_RANGE[0]} y ${SP_RANGE[1]} °C`;
  }
  return undefined;
}

/** Valida cualquier comando antes de enviarlo; devuelve el motivo si no se puede aplicar. */
export function validateCommand(c: Command): string | undefined {
  switch (c.kind) {
    case 'override':
      return validate(c.cmd);
    case 'occupancy':
      return validateOccupancy(c);
    case 'params':
      return validateParams(c.params);
    case 'unit':
      return validateUnit(c);
    case 'sensor':
      return validateSensor(c);
    case 'unit_release':
      return c.unit === '*' || HVAC_BY_ID[c.unit] ? undefined : `Unidad desconocida: ${c.unit}`;
    case 'sensor_release':
      return c.zone === '*' || ZONE_BY_ID[c.zone] ? undefined : `Zona desconocida: ${c.zone}`;
    default:
      return undefined;
  }
}

/** Texto del estado de envío a partir del resultado. */
export function feedbackFor(result: CommandResult, live: boolean): Omit<SendFeedback, 'at'> {
  const total = result.ok + result.failed;
  if (result.failed === 0) {
    return {
      phase: 'ok',
      text: `${total > 1 ? `${total} comandos aplicados` : 'Comando aplicado'}${live ? ' · confirmado por Node-RED' : ' en el simulador'}`,
    };
  }
  return {
    phase: 'error',
    text:
      result.ok > 0
        ? `${result.failed} de ${total} comandos fallaron: ${result.errors[0]}`
        : (result.errors[0] ?? 'No se pudo aplicar el comando'),
  };
}

/** Personas máximas admitidas al fijar una zona (el doble del aforo de diseño). */
export const maxPeople = (zoneId: string) => Math.max(2 * (ZONE_BY_ID[zoneId]?.occupants ?? 0), 0);

/** Valida un comando de ocupación; devuelve el motivo si no se puede aplicar. */
export function validateOccupancy(c: Extract<Command, { kind: 'occupancy' }>): string | undefined {
  if (!(c.durationMin > 0 && c.durationMin <= 7 * 24 * 60)) {
    return 'Duración inválida';
  }
  if (c.zone === '*') {
    return c.pct === undefined || c.pct < 0 || c.pct > 200 ? 'El porcentaje debe estar entre 0 y 200 %' : undefined;
  }
  const z = ZONE_BY_ID[c.zone];
  if (!z) {
    return `Zona desconocida: ${c.zone}`;
  }
  if (z.occupants === 0) {
    return `${z.id} no es una zona con personas`;
  }
  if (c.people === undefined || !Number.isInteger(c.people) || c.people < 0 || c.people > maxPeople(c.zone)) {
    return `Personas entre 0 y ${maxPeople(c.zone)} (el doble del aforo)`;
  }
  return undefined;
}

/** Aplica un comando de ocupación al conjunto local. */
export function applyOccupancy(occ: OccupancyOverrides, c: Command, now: number, user?: string): OccupancyOverrides {
  if (c.kind === 'occupancy_release') {
    if (c.zone === '*') {
      const { ['*']: _b, ...rest } = occ;
      return rest;
    }
    const { [c.zone]: _z, ...rest } = occ;
    return rest;
  }
  if (c.kind !== 'occupancy') {
    return occ;
  }
  return {
    ...occ,
    [c.zone]: { people: c.people, pct: c.pct, since: now, until: now + c.durationMin * 60_000, user },
  };
}

/** Quita las ocupaciones forzadas vencidas. */
export function pruneOccupancy(occ: OccupancyOverrides, now: number): OccupancyOverrides {
  return Object.fromEntries(Object.entries(occ).filter(([, v]) => v.until > now));
}

// ------------------------------------------------------------------ controladores (ems/controladores.py)
const L = CONTROLLER_LIMITS;
const inRange = (v: number | undefined, r: readonly [number, number]) =>
  v === undefined || (Number.isFinite(v) && v >= r[0] && v <= r[1]);
const fmtR = (r: readonly [number, number], unit: string) => `entre ${r[0]} y ${r[1]} ${unit}`.trim();

function validateDuration(d?: number): string | undefined {
  return d === undefined || (d > 0 && d <= L.maxDurationMin) ? undefined : 'Duración inválida';
}

/** Valida un ajuste de unidad (rangos del contrato; las unidades de zonas críticas exigen confirmación). */
export function validateUnit(c: Extract<Command, { kind: 'unit' }>): string | undefined {
  const u = HVAC_BY_ID[c.unit];
  if (!u) {
    return `Unidad desconocida: ${c.unit}`;
  }
  const a = c.adjust;
  if (
    a.on === undefined &&
    !a.mode &&
    a.capPct === undefined &&
    a.setpoint === undefined &&
    a.copFactor === undefined
  ) {
    return 'No hay cambios que aplicar';
  }
  if (!inRange(a.capPct, L.capPct)) {
    return `La capacidad debe estar ${fmtR(L.capPct, '%')}`;
  }
  if (!inRange(a.setpoint, L.unitSetpoint)) {
    return `El setpoint de la unidad debe estar ${fmtR(L.unitSetpoint, '°C')}`;
  }
  if (!inRange(a.copFactor, L.copFactor)) {
    return `El factor de COP debe estar ${fmtR(L.copFactor, '')}`;
  }
  if (u.critical && !c.confirm) {
    return `${u.id} atiende una zona crítica: hay que confirmar el ajuste`;
  }
  return validateDuration(c.durationMin);
}

/** Valida el forzado de un sensor de zona. */
export function validateSensor(c: Extract<Command, { kind: 'sensor' }>): string | undefined {
  const z = ZONE_BY_ID[c.zone];
  if (!z) {
    return `Zona desconocida: ${c.zone}`;
  }
  const f = c.force;
  if (f.tempOffset !== undefined && f.tempValue !== undefined) {
    return 'Use desfase o valor fijo de temperatura, no ambos';
  }
  if (
    f.tempOffset === undefined &&
    f.tempValue === undefined &&
    f.rh === undefined &&
    f.presence === undefined &&
    !f.frozen
  ) {
    return 'No hay cambios que aplicar';
  }
  if (!inRange(f.tempOffset, L.tempOffset)) {
    return `El desfase debe estar ${fmtR(L.tempOffset, '°C')}`;
  }
  if (!inRange(f.tempValue, L.tempValue)) {
    return `La temperatura fija debe estar ${fmtR(L.tempValue, '°C')}`;
  }
  if (!inRange(f.rh, L.rh)) {
    return `La HR debe estar ${fmtR(L.rh, '%')}`;
  }
  if (z.critical && !c.confirm) {
    return `${z.id} es una zona crítica: hay que confirmar el forzado`;
  }
  return validateDuration(c.durationMin);
}

const untilOf = (now: number, d?: number) => (d === undefined ? Infinity : now + d * 60_000);

/** Aplica un ajuste o liberación de unidad al conjunto local. */
export function applyUnits(units: UnitAdjustments, c: Command, now: number, user?: string): UnitAdjustments {
  if (c.kind === 'unit_release') {
    if (c.unit === '*') {
      return {};
    }
    const { [c.unit]: _u, ...rest } = units;
    return rest;
  }
  if (c.kind !== 'unit') {
    return units;
  }
  return { ...units, [c.unit]: { ...c.adjust, since: now, until: untilOf(now, c.durationMin), user } };
}

/** Aplica un forzado o liberación de sensor al conjunto local (`frozenAt` = lecturas del instante). */
export function applySensors(
  sensors: SensorOverrides,
  c: Command,
  now: number,
  user?: string,
  frozenAt?: (zone: string) => { temp: number; rh: number; occupied: boolean } | undefined
): SensorOverrides {
  if (c.kind === 'sensor_release') {
    if (c.zone === '*') {
      return {};
    }
    const { [c.zone]: _z, ...rest } = sensors;
    return rest;
  }
  if (c.kind !== 'sensor') {
    return sensors;
  }
  return {
    ...sensors,
    [c.zone]: {
      ...c.force,
      since: now,
      until: untilOf(now, c.durationMin),
      user,
      frozenAt: c.force.frozen ? frozenAt?.(c.zone) : undefined,
    },
  };
}

/** Quita los ajustes vencidos (unidades, sensores u otros registros con `until`). */
export function pruneTimed<T extends { until: number }>(rec: Record<string, T>, now: number): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v.until > now));
}

/** Texto corto de un ajuste de unidad. */
export function describeUnitAdjust(a: UnitAdjust): string {
  return (
    [
      a.on === false ? 'apagada' : undefined,
      a.on !== false && a.mode === 'frio' ? 'frío local (sin EMS)' : undefined,
      a.on !== false && a.mode === 'ventilacion' ? 'sólo ventilación' : undefined,
      a.capPct !== undefined ? `capacidad ${a.capPct} %` : undefined,
      a.setpoint !== undefined ? `setpoint ${a.setpoint.toFixed(1)} °C` : undefined,
      a.copFactor !== undefined ? `COP × ${a.copFactor.toFixed(2)}` : undefined,
    ]
      .filter(Boolean)
      .join(', ') || 'automático'
  );
}

/** Texto corto de un forzado de sensor. */
export function describeSensorForce(f: SensorForce): string {
  return (
    [
      f.frozen ? 'congelado' : undefined,
      f.tempValue !== undefined ? `T fija ${f.tempValue.toFixed(1)} °C` : undefined,
      f.tempOffset !== undefined ? `T ${f.tempOffset >= 0 ? '+' : ''}${f.tempOffset.toFixed(1)} °C` : undefined,
      f.rh !== undefined ? `HR ${Math.round(f.rh)} %` : undefined,
      f.presence !== undefined ? (f.presence ? 'presencia' : 'sin presencia') : undefined,
    ]
      .filter(Boolean)
      .join(', ') || 'real'
  );
}

const forLabel = (d?: number) => (d === undefined ? 'hasta liberar' : `por ${durationLabel(d)}`);

export interface LogEntry {
  at: number;
  ok: boolean;
  text: string;
}

export const DURATIONS = [5, 15, 30, 60, 240];

export const durationLabel = (d: number) => (d < 60 ? `${d} min` : `${d / 60} h`);

/** Valida un comando de zona; devuelve el motivo si no se puede aplicar. */
export function validate(cmd: ZoneCommand): string | undefined {
  const zone = ZONE_BY_ID[cmd.zone];
  if (!zone) {
    return `Zona desconocida: ${cmd.zone}`;
  }
  if (zone.critical) {
    return `${zone.id} es una carga crítica: no admite control manual`;
  }
  if (cmd.setpoint !== undefined && (cmd.setpoint < SP_RANGE[0] || cmd.setpoint > SP_RANGE[1])) {
    return `El setpoint debe estar entre ${SP_RANGE[0]} y ${SP_RANGE[1]} °C`;
  }
  for (const [k, v] of [
    ['iluminación', cmd.lights],
    ['enchufes', cmd.plugs],
  ] as const) {
    if (v !== undefined && (v < 0 || v > 1)) {
      return `Nivel de ${k} fuera de rango`;
    }
  }
  if (cmd.setpoint === undefined && !cmd.hvac && cmd.lights === undefined && cmd.plugs === undefined) {
    return 'No hay cambios que aplicar';
  }
  if (!(cmd.durationMin > 0 && cmd.durationMin <= 24 * 60)) {
    return 'Duración inválida';
  }
  return undefined;
}

/** Aplica un comando al conjunto local de overrides (modo demo y marca visual en vivo). */
export function applyLocal(overrides: Overrides, command: Command, now: number, user?: string): Overrides {
  if (command.kind === 'release') {
    if (command.zone === '*') {
      return {};
    }
    const { [command.zone]: _gone, ...rest } = overrides;
    return rest;
  }
  if (command.kind !== 'override') {
    return overrides;
  }
  const c = command.cmd;
  const ov: ZoneOverride = {
    setpoint: c.setpoint,
    hvac: c.hvac,
    lights: c.lights,
    plugs: c.plugs,
    since: now,
    until: now + c.durationMin * 60_000,
    user,
  };
  return { ...overrides, [c.zone]: ov };
}

/** Quita los overrides vencidos. */
export function prune(overrides: Overrides, now: number): Overrides {
  const out: Overrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v.until > now) {
      out[k] = v;
    }
  }
  return out;
}

/** Cuerpo JSON para el endpoint de Node-RED (nombres de campo del contrato). */
export function toPayload(command: Command, user?: string): Record<string, unknown> {
  switch (command.kind) {
    case 'override': {
      const c = command.cmd;
      const body: Record<string, unknown> = {
        tipo: 'override',
        zona: c.zone,
        duracion_min: c.durationMin,
        usuario: user,
      };
      if (c.setpoint !== undefined) {
        body.setpoint_c = c.setpoint;
      }
      if (c.hvac) {
        body.hvac_enable = c.hvac === 'on';
      }
      if (c.lights !== undefined) {
        body.luces_nivel = c.lights;
      }
      if (c.plugs !== undefined) {
        body.equipos_nivel = c.plugs;
      }
      return body;
    }
    case 'release':
      return { tipo: 'liberar', zona: command.zone, usuario: user };
    case 'event': {
      const e = command.event;
      return {
        tipo: 'evento',
        accion: 'iniciar',
        id: e.id,
        evento: e.kind,
        zona: e.zone,
        unidad: e.unit,
        duracion_min: Math.round((e.end - e.start) / 60_000),
        intensidad: e.intensity,
        usuario: user,
      };
    }
    case 'event_stop':
      return { tipo: 'evento', accion: 'detener', id: command.id, usuario: user };
    case 'occupancy': {
      const body: Record<string, unknown> = {
        tipo: 'ocupacion',
        zona: command.zone,
        duracion_min: command.durationMin,
        usuario: user,
      };
      if (command.people !== undefined) {
        body.personas = command.people;
      }
      if (command.pct !== undefined) {
        body.porcentaje = command.pct;
      }
      return body;
    }
    case 'occupancy_release':
      return { tipo: 'ocupacion', zona: command.zone, liberar: true, usuario: user };
    case 'unit': {
      const a = command.adjust;
      const body: Record<string, unknown> = { tipo: 'unidad', unidad: command.unit, usuario: user };
      if (a.on !== undefined) {
        body.encendido = a.on;
      }
      if (a.mode) {
        body.modo = a.mode;
      }
      if (a.capPct !== undefined) {
        body.capacidad_pct = a.capPct;
      }
      if (a.setpoint !== undefined) {
        body.setpoint_c = a.setpoint;
      }
      if (a.copFactor !== undefined) {
        body.cop_factor = a.copFactor;
      }
      if (command.durationMin !== undefined) {
        body.duracion_min = command.durationMin;
      }
      if (command.confirm) {
        body.confirmar = true;
      }
      return body;
    }
    case 'unit_release':
      return { tipo: 'unidad', unidad: command.unit, liberar: true, usuario: user };
    case 'sensor': {
      const f = command.force;
      const body: Record<string, unknown> = { tipo: 'sensor', zona: command.zone, usuario: user };
      if (f.tempOffset !== undefined) {
        body.temp_offset_c = f.tempOffset;
      }
      if (f.tempValue !== undefined) {
        body.temp_c = f.tempValue;
      }
      if (f.rh !== undefined) {
        body.hr_pct = f.rh;
      }
      if (f.presence !== undefined) {
        body.presencia = f.presence;
      }
      if (f.frozen) {
        body.congelado = true;
      }
      if (command.durationMin !== undefined) {
        body.duracion_min = command.durationMin;
      }
      if (command.confirm) {
        body.confirmar = true;
      }
      return body;
    }
    case 'sensor_release':
      return { tipo: 'sensor', zona: command.zone, liberar: true, usuario: user };
    default: {
      const body: Record<string, unknown> = { tipo: 'parametros', usuario: user };
      if (command.params.limitKw !== undefined) {
        body.limite_kw = command.params.limitKw;
      }
      if (command.params.spOccupied !== undefined) {
        body.sp_ocupado = command.params.spOccupied;
      }
      return body;
    }
  }
}

export function describe(command: Command): string {
  switch (command.kind) {
    case 'override': {
      const c = command.cmd;
      const parts = [
        c.setpoint !== undefined ? `setpoint ${c.setpoint.toFixed(1)} °C` : undefined,
        c.hvac ? `HVAC ${c.hvac === 'on' ? 'encendido' : 'apagado'}` : undefined,
        c.lights !== undefined ? `luces ${Math.round(c.lights * 100)} %` : undefined,
        c.plugs !== undefined ? `enchufes ${Math.round(c.plugs * 100)} %` : undefined,
      ].filter(Boolean);
      return `${c.zone}: ${parts.join(', ')} por ${c.durationMin} min`;
    }
    case 'release':
      return command.zone === '*' ? 'Todas las zonas vuelven a automático' : `${command.zone} vuelve a automático`;
    case 'event':
      return `Simulación: ${describeEvent(command.event)} por ${durationLabel(Math.round((command.event.end - command.event.start) / 60_000))}`;
    case 'event_stop':
      return command.id === '*' ? 'Fin de todas las simulaciones de eventos' : 'Fin de la simulación del evento';
    case 'occupancy':
      return command.zone === '*'
        ? `Ocupación del edificio al ${command.pct} % del horario por ${durationLabel(command.durationMin)}`
        : `${command.zone}: ${command.people} personas por ${durationLabel(command.durationMin)}`;
    case 'occupancy_release':
      return command.zone === '*' ? 'Ocupación del edificio según horario' : `${command.zone}: personas según horario`;
    case 'unit':
      return `${command.unit}: ${describeUnitAdjust(command.adjust)} ${forLabel(command.durationMin)}`;
    case 'unit_release':
      return command.unit === '*' ? 'Todas las unidades vuelven a automático' : `${command.unit} vuelve a automático`;
    case 'sensor':
      return `Sensor de ${command.zone}: ${describeSensorForce(command.force)} ${forLabel(command.durationMin)}`;
    case 'sensor_release':
      return command.zone === '*' ? 'Todos los sensores leen el valor real' : `Sensor de ${command.zone}: valor real`;
    default:
      return [
        command.params.limitKw !== undefined ? `límite de demanda ${command.params.limitKw} kW` : undefined,
        command.params.spOccupied !== undefined ? `setpoint con ocupación ${command.params.spOccupied} °C` : undefined,
      ]
        .filter(Boolean)
        .join(', ');
  }
}

/** Envía el comando al endpoint HTTP de Node-RED. */
/**
 * Resuelve la URL de control: `{host}` se reemplaza por el host con el que el navegador abrió Grafana, para que
 * el panel funcione desde cualquier equipo de la red sin fijar la IP del servidor.
 */
export function resolveControlUrl(url: string, host?: string): string {
  const h = host ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  return url.replace(/\{host\}/g, h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);
}

export async function sendToNodeRed(url: string, command: Command, user?: string, timeoutMs = 5000): Promise<string> {
  url = resolveControlUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toPayload(command, user)),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
