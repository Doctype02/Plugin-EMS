/**
 * Reloj de la simulación: el operador elige el día y la hora y la velocidad a la que avanza.
 * Funciones puras (el componente sólo guarda el estado y refresca la pantalla).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = -5 * HOUR; // America/Panama

export interface ClockState {
  /** Instante real y simulado del último cambio (re-anclaje). */
  anchorReal: number;
  anchorSim: number;
  /** Veces más rápido que el reloj real. */
  speed: number;
  playing: boolean;
}

export const SPEEDS = [
  { value: 1, label: 'Real', hint: 'Avanza como el reloj (1 s = 1 s)' },
  { value: 60, label: '1 min/s', hint: 'Cada segundo avanza un minuto' },
  { value: 600, label: '10 min/s', hint: 'Cada segundo avanza 10 minutos' },
  { value: 3600, label: '1 h/s', hint: 'Un día en 24 segundos' },
];

export const WEEKDAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
export const WEEKDAY_NAMES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

export function initialClock(real: number, speed: number): ClockState {
  return { anchorReal: real, anchorSim: real, speed: Math.max(1, speed || 1), playing: true };
}

export function simNow(s: ClockState, real: number): number {
  return s.playing ? s.anchorSim + (real - s.anchorReal) * s.speed : s.anchorSim;
}

export function setTime(s: ClockState, t: number, real: number): ClockState {
  return { ...s, anchorSim: t, anchorReal: real };
}

export function setSpeed(s: ClockState, speed: number, real: number): ClockState {
  return { ...s, anchorSim: simNow(s, real), anchorReal: real, speed, playing: true };
}

export function togglePlay(s: ClockState, real: number): ClockState {
  return { ...s, anchorSim: simNow(s, real), anchorReal: real, playing: !s.playing };
}

/** Vuelve a la hora real de Panamá en tiempo real. */
export function goLive(real: number): ClockState {
  return { anchorReal: real, anchorSim: real, speed: 1, playing: true };
}

/** Hora decimal local (0–24) y día de la semana (0 = lunes). */
export function localParts(t: number): { hour: number; dow: number; dayStart: number } {
  const local = t + TZ;
  const dayStart = Math.floor(local / DAY) * DAY - TZ;
  const dow = (new Date(local).getUTCDay() + 6) % 7;
  return { hour: (t - dayStart) / HOUR, dow, dayStart };
}

/** Mismo día, a la hora indicada. */
export function atHour(t: number, hour: number): number {
  return localParts(t).dayStart + Math.min(Math.max(hour, 0), 24 - 1 / 60) * HOUR;
}

/** Mismo instante del día, en el día de la semana `dow` (0 = lunes) de la misma semana. */
export function atWeekday(t: number, dow: number): number {
  const p = localParts(t);
  return t + (dow - p.dow) * DAY;
}

export function tickMs(s: ClockState): number {
  return !s.playing ? 1000 : s.speed <= 1 ? 1000 : 200;
}

export function formatClock(t: number): { time: string; day: string; date: string } {
  const p = localParts(t);
  const h = Math.floor(p.hour);
  const m = Math.floor((p.hour - h) * 60);
  const d = new Date(t + TZ);
  return {
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    day: WEEKDAY_NAMES[p.dow],
    date: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`,
  };
}

/** Franja del día para orientar al operador. */
export function dayPeriod(hour: number, dow: number): string {
  if (dow >= 5) {
    return hour >= 8 && hour < 12 && dow === 5 ? 'Sábado (media jornada)' : 'Fin de semana';
  }
  if (hour < 6 || hour >= 20) {
    return 'Noche · edificio cerrado';
  }
  if (hour < 8) {
    return 'Pre-apertura';
  }
  if (hour < 12) {
    return 'Jornada (mañana)';
  }
  if (hour < 13) {
    return 'Almuerzo';
  }
  if (hour < 17) {
    return 'Jornada (tarde) · punta tarifaria';
  }
  return 'Cierre';
}

/** Posición del sol en Ciudad de Panamá (NOAA simplificado): azimut desde el norte (°) y elevación (°). */
export function sunPosition(t: number, lat = 8.97, lon = -79.5): { azimuth: number; elevation: number } {
  const rad = Math.PI / 180;
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = (t - start) / 86_400_000;
  const g = ((2 * Math.PI) / 365) * (doy - 1);
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g);
  const eqt =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const tst = utcMin + eqt + 4 * lon;
  const ha = (tst / 4 - 180) * rad;
  const phi = lat * rad;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / rad + 180;
  return { azimuth: (az + 360) % 360, elevation: 90 - zen / rad };
}
