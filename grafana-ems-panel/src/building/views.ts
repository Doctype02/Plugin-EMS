import { Zone } from './model';
import { Status, ZoneState } from './telemetry';

export type ViewMode = 'status' | 'temperature' | 'occupancy' | 'power' | 'lighting' | 'hvac';

export const VIEW_LABELS: Record<ViewMode, string> = {
  status: 'Estado',
  temperature: 'Temperatura',
  occupancy: 'Ocupación',
  power: 'Potencia',
  lighting: 'Iluminación',
  hvac: 'HVAC',
};

// Rampa secuencial azul (100 → 700) y polos del divergente azul ↔ rojo con punto medio gris.
const BLUE = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
const ORANGE = ['#fde3d6', '#f9bfa2', '#f39a6f', '#eb6834', '#c9521f', '#9e3f16', '#73300f'];
const RED_ARM = ['#f5c6c0', '#ec8f86', '#e34948', '#b52f2f', '#821f1f'];
const BLUE_ARM = ['#b7d3f6', '#6da7ec', '#2a78d6', '#1c5cab', '#104281'];
const MID = { light: '#e4e3df', dark: '#4a4a46' };

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Interpola sobre una rampa con t ∈ [0, 1]. */
export function ramp(stops: string[], t: number): string {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mix(stops[i], stops[i + 1], x - i);
}

/** Divergente centrado en el setpoint: azul = más frío, gris = en banda, rojo = más caliente. */
export function temperatureColor(temp: number, setpoint: number, dark: boolean): string {
  const d = temp - setpoint;
  if (Math.abs(d) <= 0.5) {
    return dark ? MID.dark : MID.light;
  }
  const t = Math.min((Math.abs(d) - 0.5) / 2.5, 1);
  return d > 0
    ? ramp([dark ? MID.dark : MID.light, ...RED_ARM], t)
    : ramp([dark ? MID.dark : MID.light, ...BLUE_ARM], t);
}

export interface LegendSpec {
  title: string;
  kind: 'status' | 'gradient' | 'categories';
  stops?: string[];
  min?: string;
  max?: string;
  mid?: string;
  categories?: Array<{ label: string; color: string }>;
}

export interface ViewContext {
  dark: boolean;
  statusColors: Record<Status, string>;
  status: Record<string, Status>;
  maxPowerDensity: number;
}

export function zoneFill(mode: ViewMode, zone: Zone, s: ZoneState | undefined, ctx: ViewContext): string {
  const offline = ctx.dark ? '#2b2b29' : '#d8d7d2';
  if (!s || !Number.isFinite(s.temp)) {
    return offline;
  }
  switch (mode) {
    case 'temperature':
      return temperatureColor(s.temp, s.setpoint, ctx.dark);
    case 'occupancy':
      return s.occupants === 0
        ? ctx.dark
          ? '#34343a'
          : '#eef3fa'
        : ramp(BLUE, s.occupants / Math.max(zone.occupants, 1));
    case 'power':
      return ramp(ORANGE, ((s.pTotal / zone.area) * 1000) / ctx.maxPowerDensity);
    case 'lighting':
      return s.lights <= 0.001
        ? ctx.dark
          ? '#2f2f2c'
          : '#ecebe6'
        : ramp(['#fff3c4', '#ffd95a', '#eda100', '#b77b00'], s.lights);
    case 'hvac':
      if (s.drForced) {
        return '#eb6834';
      }
      if (s.hvacOn) {
        return '#2a78d6';
      }
      return s.hvacEnable ? (ctx.dark ? '#3c4b5c' : '#b7d3f6') : ctx.dark ? '#2f2f2c' : '#e4e3df';
    default:
      return ctx.statusColors[ctx.status[zone.id] ?? 'offline'];
  }
}

export function legendFor(mode: ViewMode, ctx: ViewContext): LegendSpec {
  switch (mode) {
    case 'temperature':
      return {
        title: 'Temperatura respecto al setpoint',
        kind: 'gradient',
        stops: [...[...BLUE_ARM].reverse(), ctx.dark ? MID.dark : MID.light, ...RED_ARM],
        min: '−3 °C',
        mid: 'en banda ±0.5',
        max: '+3 °C',
      };
    case 'occupancy':
      return { title: 'Ocupación / aforo', kind: 'gradient', stops: BLUE, min: '0 %', max: '100 %' };
    case 'power':
      return {
        title: 'Densidad de potencia',
        kind: 'gradient',
        stops: ORANGE,
        min: '0',
        max: `${ctx.maxPowerDensity} W/m²`,
      };
    case 'lighting':
      return {
        title: 'Nivel de iluminación artificial',
        kind: 'gradient',
        stops: ['#fff3c4', '#ffd95a', '#eda100', '#b77b00'],
        min: 'apagado',
        max: '100 %',
      };
    case 'hvac':
      return {
        title: 'Estado del compresor',
        kind: 'categories',
        categories: [
          { label: 'Enfriando', color: '#2a78d6' },
          { label: 'En espera (termostato)', color: ctx.dark ? '#3c4b5c' : '#b7d3f6' },
          { label: 'Bloqueado por DR', color: '#eb6834' },
          { label: 'Apagado', color: ctx.dark ? '#2f2f2c' : '#e4e3df' },
        ],
      };
    default:
      return { title: 'Estado de la zona', kind: 'status' };
  }
}

/** Valor que se rotula sobre cada zona según la vista. */
export function zoneLabel(mode: ViewMode, zone: Zone, s: ZoneState | undefined): string {
  if (!s || !Number.isFinite(s.temp)) {
    return '—';
  }
  switch (mode) {
    case 'occupancy':
      return `${s.occupants}/${zone.occupants}`;
    case 'power':
      return `${s.pTotal.toFixed(1)} kW`;
    case 'lighting':
      return `${Math.round(s.lights * 100)} %`;
    case 'hvac':
      return s.drForced ? 'DR' : s.hvacOn ? 'ON' : s.hvacEnable ? 'auto' : 'OFF';
    default:
      return `${s.temp.toFixed(1)}°`;
  }
}

export const MAX_POWER_DENSITY = 160; // W/m² (cuarto de servidores ≈ 400; se satura a propósito)
