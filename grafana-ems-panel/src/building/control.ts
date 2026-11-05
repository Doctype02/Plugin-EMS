/**
 * Comandos del operador hacia el EMS (docs/CONTRATO.md §2, tópicos `ems/<edif>/ems/override` y
 * `ems/<edif>/ems/parametros`). En modo demostración se aplican al simulador del navegador; en modo
 * en vivo se envían por HTTP al flujo de Node-RED, que los publica por MQTT y los respeta en sus reglas.
 */
import { ZONE_BY_ID } from './model';
import { EmsParams, Overrides, ZoneOverride } from './telemetry';

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
  | { kind: 'params'; params: Partial<EmsParams> };

export interface LogEntry {
  at: number;
  ok: boolean;
  text: string;
}

export const DURATIONS = [30, 60, 240];

/** Valida un comando de zona; devuelve el motivo si no se puede aplicar. */
export function validate(cmd: ZoneCommand): string | undefined {
  const zone = ZONE_BY_ID[cmd.zone];
  if (!zone) {
    return `Zona desconocida: ${cmd.zone}`;
  }
  if (zone.critical) {
    return `${zone.id} es una carga crítica: no admite control manual`;
  }
  if (cmd.setpoint !== undefined && (cmd.setpoint < 20 || cmd.setpoint > 28)) {
    return 'El setpoint debe estar entre 20 y 28 °C';
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
export async function sendToNodeRed(url: string, command: Command, user?: string, timeoutMs = 5000): Promise<string> {
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
