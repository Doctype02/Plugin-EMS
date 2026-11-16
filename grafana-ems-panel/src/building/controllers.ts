/**
 * Lógica de la pestaña «Controladores» y del bloque «Datos del sensor»: formularios ⇄ ajustes del contrato
 * (docs/CONTRATO.md, `tipo: "unidad"` y `tipo: "sensor"`) y estado de cada unidad VRF/PTAC.
 */
import { HvacSystem, ZONE_BY_ID } from './model';
import {
  SensorForce,
  SensorOverride,
  Snapshot,
  Status,
  UnitAdjust,
  UnitAdjustment,
  UnitMode,
  UnitStatus,
  ZoneState,
} from './telemetry';

export const UNIT_MODE_TEXT: Record<UnitStatus['mode'], string> = {
  auto: 'Auto (EMS)',
  frio: 'Frío local',
  ventilacion: 'Ventilación',
  apagado: 'Apagada',
};

/** Duraciones del ajuste; `undefined` = hasta liberar. */
export const CONTROLLER_DURATIONS: Array<number | undefined> = [15, 60, 240, undefined];

export interface UnitForm {
  on: boolean;
  mode: UnitMode;
  capPct: number;
  useSetpoint: boolean;
  setpoint: number;
  copFactor: number;
}

export function formFromAdjust(a?: UnitAdjust, setpoint = 24): UnitForm {
  return {
    on: a?.on !== false,
    mode: a?.mode ?? 'auto',
    capPct: a?.capPct ?? 100,
    useSetpoint: a?.setpoint !== undefined,
    setpoint: a?.setpoint ?? setpoint,
    copFactor: a?.copFactor ?? 1,
  };
}

/** Sólo los campos que difieren del automático (lo demás sigue en manos del EMS). */
export function adjustFromForm(f: UnitForm): UnitAdjust {
  const a: UnitAdjust = {};
  if (!f.on) {
    a.on = false;
  } else if (f.mode !== 'auto') {
    a.mode = f.mode;
  }
  if (f.capPct < 100) {
    a.capPct = f.capPct;
  }
  if (f.useSetpoint) {
    a.setpoint = f.setpoint;
  }
  if (Math.abs(f.copFactor - 1) > 1e-9) {
    a.copFactor = f.copFactor;
  }
  return a;
}

/** Se pide confirmación al apagar una unidad o al tocar la que atiende una zona crítica. */
export function needsUnitConfirm(u: HvacSystem, a: UnitAdjust): boolean {
  return u.critical || a.on === false || a.capPct === 0;
}

/**
 * Estado de una unidad: el que publica el gemelo (`snapshot.units`) o, si no llega, una estimación con la
 * telemetría de sus zonas y el ajuste local.
 */
export function unitView(u: HvacSystem, snapshot: Snapshot, local?: UnitAdjustment): UnitStatus {
  const live = snapshot.units?.[u.id];
  if (live) {
    return live;
  }
  const zs = u.zones.map((id) => snapshot.zones[id]).filter(Boolean);
  const pKw = zs.reduce((a, s) => a + (Number.isFinite(s.pHvac) ? s.pHvac : 0), 0);
  const q = u.zones.reduce((a, id) => {
    const s = snapshot.zones[id];
    return a + (s?.hvacOn ? Math.max(0, s.pHvac - (ZONE_BY_ID[id]?.fanKw ?? 0)) * u.cop : 0);
  }, 0);
  const mode: UnitStatus['mode'] = !local ? 'auto' : local.on === false ? 'apagado' : (local.mode ?? 'auto');
  return {
    pKw,
    qKw: q,
    loadPct: (100 * q) / u.capacityKw,
    cop: q > 0 ? u.cop * (local?.copFactor ?? 1) : undefined,
    mode,
    on: mode !== 'apagado',
    capPct: local?.capPct ?? 100,
    setpoint: local?.setpoint,
    copFactor: local?.copFactor ?? 1,
    forced: !!local,
    remainingMin:
      local && Number.isFinite(local.until) ? Math.max(0, (local.until - snapshot.time) / 60_000) : undefined,
    fault: zs.length > 0 && zs.every((s) => s.events?.includes('falla_vrf')),
    noPower: snapshot.meter?.gridOk === false,
    updatedAt: snapshot.time,
  };
}

/** Rótulo y color del estado de la unidad. */
export function unitBadge(st: UnitStatus): { text: string; status: Status } {
  if (st.noPower) {
    return { text: 'Sin energía', status: 'offline' };
  }
  if (st.fault) {
    return { text: 'Falla', status: 'critical' };
  }
  if (!st.on) {
    return { text: 'Apagada', status: 'critical' };
  }
  if (st.forced) {
    return { text: 'Manual', status: 'warning' };
  }
  return { text: st.qKw > 0.05 ? 'Enfriando' : 'En espera', status: 'ok' };
}

export const remainingText = (min?: number) =>
  min === undefined ? 'hasta liberar' : min < 60 ? `${Math.max(1, Math.round(min))} min` : `${(min / 60).toFixed(1)} h`;

// ------------------------------------------------------------------ sensor de zona

export interface SensorForm {
  temp: 'real' | 'offset' | 'value';
  offset: number;
  value: number;
  rhMode: 'real' | 'value';
  rh: number;
  presence: 'real' | 'on' | 'off';
  frozen: boolean;
}

export function formFromForce(f: SensorForce | undefined, s?: ZoneState): SensorForm {
  return {
    temp: f?.tempValue !== undefined ? 'value' : f?.tempOffset !== undefined ? 'offset' : 'real',
    offset: f?.tempOffset ?? 2,
    value: f?.tempValue ?? Math.round((s?.tempReal ?? s?.temp ?? 24) * 2) / 2,
    rhMode: f?.rh !== undefined ? 'value' : 'real',
    rh: f?.rh ?? Math.round(s?.rhReal ?? s?.rh ?? 60),
    presence: f?.presence === undefined ? 'real' : f.presence ? 'on' : 'off',
    frozen: !!f?.frozen,
  };
}

export function forceFromForm(f: SensorForm): SensorForce {
  const out: SensorForce = {};
  if (f.frozen) {
    out.frozen = true;
  }
  if (f.temp === 'offset') {
    out.tempOffset = f.offset;
  } else if (f.temp === 'value') {
    out.tempValue = f.value;
  }
  if (f.rhMode === 'value') {
    out.rh = f.rh;
  }
  if (f.presence !== 'real') {
    out.presence = f.presence === 'on';
  }
  return out;
}

/** Forzado vigente de la zona: el que informa el gemelo o, si no, el registrado localmente. */
export function sensorForceOf(s: ZoneState | undefined, local?: SensorOverride): SensorForce | undefined {
  if (s?.sensorForce) {
    return s.sensorForce;
  }
  if (!local) {
    return undefined;
  }
  const { since: _s, until: _u, user: _w, frozenAt: _f, ...f } = local;
  return f;
}
