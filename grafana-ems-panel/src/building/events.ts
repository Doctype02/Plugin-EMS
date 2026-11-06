/**
 * Eventos que el operador puede simular: fallas, accidentes y condiciones extremas.
 *
 * Cada evento tiene un efecto físico en el gemelo (simulator.ts) y genera las alarmas que el EMS
 * real emitiría. Efectos basados en práctica habitual:
 * - Incendio: la alarma apaga la climatización de todo el edificio para no propagar humo (NFPA 90A /
 *   control de humo) y se evacua; la zona afectada sube de temperatura rápidamente.
 * - Corte de energía: se pierde la red; las cargas críticas (servidores, cuarto eléctrico) siguen con el
 *   UPS durante su autonomía, pero sin climatización (el UPS no alimenta el VRF).
 * - Falla de una unidad exterior VRF: todas las zonas que atiende quedan sin enfriamiento.
 */
import { VRF_UNITS, ZONE_BY_ID } from './model';
import { AlarmLevel } from './telemetry';

export type EventKind =
  | 'incendio'
  | 'corte_energia'
  | 'falla_vrf'
  | 'falla_terminal'
  | 'puerta_abierta'
  | 'sensor'
  | 'ola_calor'
  | 'sobreocupacion'
  | 'pico_carga';

export type EventTarget = 'zona' | 'unidad' | 'edificio';

export interface SimEvent {
  id: string;
  kind: EventKind;
  zone?: string;
  unit?: string;
  start: number;
  end: number;
  /** Intensidad según el tipo (°C, kW, %, minutos de autonomía…). */
  intensity?: number;
}

export interface EventDef {
  label: string;
  /** Emoji corto para listas y el banner (sin depender del set de íconos). */
  glyph: string;
  level: AlarmLevel;
  target: EventTarget;
  description: string;
  defaultMinutes: number;
  intensity?: { label: string; min: number; max: number; step: number; value: number; unit: string };
  /** Zonas no permitidas (p. ej. no se simula sobreocupación en cuartos sin personas). */
  zones?: (zoneId: string) => boolean;
}

const conPersonas = (id: string) => (ZONE_BY_ID[id]?.occupants ?? 0) > 0;
const noCritica = (id: string) => !ZONE_BY_ID[id]?.critical;

export const EVENTS: Record<EventKind, EventDef> = {
  incendio: {
    label: 'Incendio',
    glyph: '🔥',
    level: 'crit',
    target: 'zona',
    description:
      'Conato de incendio: alarma, evacuación del edificio y paro de la climatización para no propagar humo.',
    defaultMinutes: 45,
  },
  corte_energia: {
    label: 'Corte de energía',
    glyph: '⚡',
    level: 'crit',
    target: 'edificio',
    description:
      'Se pierde la red. Servidores y cuarto eléctrico siguen con el UPS durante su autonomía, sin climatización.',
    defaultMinutes: 60,
    intensity: { label: 'Autonomía del UPS', min: 5, max: 120, step: 5, value: 30, unit: 'min' },
  },
  falla_vrf: {
    label: 'Falla de unidad VRF',
    glyph: '❄',
    level: 'crit',
    target: 'unidad',
    description: 'La unidad exterior deja de enfriar: todas las zonas que atiende se calientan.',
    defaultMinutes: 120,
  },
  falla_terminal: {
    label: 'Falla de terminal (zona)',
    glyph: '🛠',
    level: 'warn',
    target: 'zona',
    description: 'El terminal VRF de una zona deja de enfriar.',
    defaultMinutes: 120,
  },
  puerta_abierta: {
    label: 'Puerta o ventana abierta',
    glyph: '🚪',
    level: 'warn',
    target: 'zona',
    description: 'Entra aire exterior caliente y húmedo: sube la carga del VRF y la temperatura.',
    defaultMinutes: 60,
    intensity: { label: 'Apertura', min: 10, max: 100, step: 10, value: 50, unit: '%' },
    zones: noCritica,
  },
  sensor: {
    label: 'Falla de sensor',
    glyph: '🌡',
    level: 'crit',
    target: 'zona',
    description: 'El sensor de temperatura se congela: el EMS lo detecta y pasa la zona a modo seguro.',
    defaultMinutes: 60,
  },
  ola_calor: {
    label: 'Ola de calor',
    glyph: '☀',
    level: 'info',
    target: 'edificio',
    description: 'La temperatura exterior sube: más carga de enfriamiento y riesgo de superar el límite de demanda.',
    defaultMinutes: 360,
    intensity: { label: 'Aumento', min: 1, max: 8, step: 0.5, value: 4, unit: '°C' },
  },
  sobreocupacion: {
    label: 'Sobreocupación',
    glyph: '👥',
    level: 'warn',
    target: 'zona',
    description: 'Más personas que el aforo de diseño (reunión, evento).',
    defaultMinutes: 90,
    intensity: { label: 'Sobre el aforo', min: 10, max: 150, step: 10, value: 50, unit: '%' },
    zones: conPersonas,
  },
  pico_carga: {
    label: 'Pico de carga',
    glyph: '📈',
    level: 'warn',
    target: 'zona',
    description: 'Equipos adicionales conectados: el limitador de demanda debe responder.',
    defaultMinutes: 60,
    intensity: { label: 'Carga extra', min: 2, max: 25, step: 1, value: 10, unit: 'kW' },
    zones: noCritica,
  },
};

export function isActive(e: SimEvent, t: number): boolean {
  return t >= e.start && t < e.end;
}

export function activeEvents(events: SimEvent[] | undefined, t: number): SimEvent[] {
  return (events ?? []).filter((e) => isActive(e, t));
}

/** ¿Afecta el evento a la zona? (los de edificio afectan a todas; los de unidad, a sus zonas). */
export function affectsZone(e: SimEvent, zoneId: string): boolean {
  if (EVENTS[e.kind].target === 'edificio') {
    return true;
  }
  if (e.unit) {
    return VRF_UNITS.find((u) => u.id === e.unit)?.zones.includes(zoneId) ?? false;
  }
  return e.zone === zoneId;
}

export function describeEvent(e: SimEvent): string {
  const def = EVENTS[e.kind];
  const where = e.unit ? ` en ${e.unit}` : e.zone ? ` en ${e.zone} · ${ZONE_BY_ID[e.zone]?.name ?? ''}` : '';
  const amount =
    def.intensity && e.intensity !== undefined
      ? ` (${def.intensity.label.toLowerCase()} ${e.intensity} ${def.intensity.unit})`
      : '';
  return `${def.label}${where}${amount}`;
}

let counter = 0;
export function newEvent(kind: EventKind, start: number, minutes: number, opts: Partial<SimEvent> = {}): SimEvent {
  counter += 1;
  return {
    id: `ev-${start}-${counter}`,
    kind,
    start,
    end: start + minutes * 60_000,
    intensity: EVENTS[kind].intensity?.value,
    ...opts,
  };
}
