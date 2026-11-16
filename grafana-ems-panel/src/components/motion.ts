/**
 * Movimiento de la escena a la tasa de refresco de la pantalla (~60 fps) sin re-renderizar React.
 *
 * - Un único bucle `requestAnimationFrame` compartido (el «reloj visual») avanza mientras haya suscriptores
 *   activos y la pestaña esté visible.
 * - Los elementos animados de la escena llevan su animación descrita en `data-mo` (ver `mo()`); `useMotion`
 *   los recoge tras cada render y en cada frame escribe directamente sus atributos (`transform`, `opacity`,
 *   `stroke-dashoffset`…). React no gestiona esos atributos, así que los refrescos de la simulación (cada
 *   200 ms – 1 s) no reinician ni hacen saltar el movimiento.
 * - La fase de cada animación se integra frame a frame (fase += dt / duración): si la duración cambia con el
 *   estado (ventiladores según la carga, montante según la potencia) la velocidad cambia sin saltos.
 * - Sustituye a las animaciones SMIL (`<animate>`), que en Chrome recalculaban estilos de todo el SVG en cada
 *   frame (~100 ms por frame en la vista de planta).
 */
import { RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

type FrameFn = (now: number, dt: number) => void;

const subscribers = new Set<FrameFn>();
let rafId = 0;
let last = 0;

function frame(now: number) {
  // tras una pausa larga (pestaña oculta, depurador) no se avanza de golpe
  const dt = last ? Math.min(now - last, 100) : 16;
  last = now;
  subscribers.forEach((fn) => fn(now, dt));
  rafId = subscribers.size ? requestAnimationFrame(frame) : 0;
}

function hidden() {
  return typeof document !== 'undefined' && document.hidden;
}

function start() {
  if (!rafId && subscribers.size && !hidden() && typeof requestAnimationFrame === 'function') {
    last = 0;
    rafId = requestAnimationFrame(frame);
  }
}

function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
}

/** Suscribe una función al reloj visual (rAF compartido). Devuelve la baja. */
export function onFrame(fn: FrameFn): () => void {
  subscribers.add(fn);
  start();
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size) {
      stop();
    }
  };
}

/** Número de suscriptores activos (pruebas). */
export function frameSubscribers(): number {
  return subscribers.size;
}

/** `true` mientras el elemento esté en pantalla (IntersectionObserver; sin soporte se supone visible). */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      return;
    }
    const io = new IntersectionObserver((entries) => setOn(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/**
 * Valor derivado del reloj visual: llama a `compute` en cada frame y sólo re-renderiza cuando el resultado
 * cambia (p. ej. la hora simulada redondeada al minuto). Inactivo, devuelve `fallback`.
 */
export function useFrameValue<T>(compute: () => T, active: boolean, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  const fn = useRef(compute);
  useLayoutEffect(() => {
    fn.current = compute;
  });
  useEffect(() => {
    if (!active) {
      return;
    }
    setValue(fn.current());
    return onFrame(() => {
      const v = fn.current();
      setValue((cur) => (Object.is(cur, v) ? cur : v));
    });
  }, [active]);
  return active ? value : fallback;
}

// --- animaciones declarativas -------------------------------------------------------------------------

/** Una pista: atributo, valores (listas de números separadas por `;`), tiempos clave, duración y desfase. */
export interface Track {
  /** `translate`, `rotate` (ángulo, cx, cy) o el nombre de un atributo numérico (`opacity`, `r`…). */
  attr: string;
  values: number[][];
  keyTimes: number[];
  /** Segundos por ciclo. */
  dur: number;
  /** Fase inicial en segundos (como `begin="-Xs"` de SMIL). */
  offset: number;
}

export interface MotionSpec {
  attr: 'translate' | 'rotate' | string;
  /** Valores del ciclo: números o listas («dx,dy», «ángulo cx cy»). */
  values: Array<number | string>;
  keyTimes?: number[];
  dur: number;
  offset?: number;
}

const fmt = (n: number) => (Math.abs(n) < 1e-6 ? '0' : String(Math.round(n * 100) / 100));

/** Atributo `data-mo` para un elemento animado (una o varias pistas). */
export function mo(...specs: MotionSpec[]): { 'data-mo': string } {
  const enc = specs.map((s) => {
    const values = s.values.map((v) => (typeof v === 'number' ? fmt(v) : v.trim().replace(/[\s,]+/g, ',')));
    const kt = (s.keyTimes ?? values.map((_, i) => i / Math.max(values.length - 1, 1))).map(fmt);
    return [s.attr, values.join(';'), kt.join(';'), fmt(Math.max(s.dur, 0.05)), fmt(s.offset ?? 0)].join('|');
  });
  return { 'data-mo': enc.join('/') };
}

const parsed = new Map<string, Track[]>();

export function parseMotion(code: string): Track[] {
  let tracks = parsed.get(code);
  if (!tracks) {
    tracks = code.split('/').map((part) => {
      const [attr, values, keyTimes, dur, offset] = part.split('|');
      return {
        attr,
        values: values.split(';').map((v) => v.split(',').map(Number)),
        keyTimes: keyTimes.split(';').map(Number),
        dur: Number(dur),
        offset: Number(offset),
      };
    });
    if (parsed.size > 2000) {
      parsed.clear();
    }
    parsed.set(code, tracks);
  }
  return tracks;
}

/** Valor de la pista en la fase `p` (0–1): interpolación lineal por tramos, como `calcMode="linear"`. */
export function sample(track: Track, p: number): number[] {
  const { values, keyTimes } = track;
  if (values.length === 1) {
    return values[0];
  }
  let i = 0;
  while (i < keyTimes.length - 2 && p >= keyTimes[i + 1]) {
    i++;
  }
  const t0 = keyTimes[i];
  const t1 = keyTimes[i + 1] ?? 1;
  const f = t1 > t0 ? Math.min(Math.max((p - t0) / (t1 - t0), 0), 1) : 0;
  const a = values[i];
  const b = values[i + 1] ?? a;
  return a.map((v, k) => v + ((b[k] ?? v) - v) * f);
}

/** Texto del atributo para el valor muestreado (redondeado para no reescribir el DOM por diferencias ínfimas). */
export function render(track: Track, v: number[]): [string, string] {
  switch (track.attr) {
    case 'translate':
      return ['transform', `translate(${v[0].toFixed(1)},${(v[1] ?? 0).toFixed(1)})`];
    case 'rotate':
      return ['transform', `rotate(${v[0].toFixed(1)} ${fmt(v[1] ?? 0)} ${fmt(v[2] ?? 0)})`];
    case 'opacity':
    case 'fill-opacity':
      return [track.attr, v[0].toFixed(2)];
    default:
      return [track.attr, v[0].toFixed(1)];
  }
}

/** Fotograma clave CSS (Web Animations) para un valor de la pista. */
export function keyframeOf(track: Track, v: number[]): Keyframe {
  switch (track.attr) {
    case 'translate':
      return { transform: `translate(${v[0]}px,${v[1] ?? 0}px)` };
    case 'rotate': {
      // rotate(a cx cy) de SVG = trasladar al centro, girar y volver (unidades de usuario = px en CSS)
      const [a, cx = 0, cy = 0] = v;
      return { transform: `translate(${cx}px,${cy}px) rotate(${a}deg) translate(${-cx}px,${-cy}px)` };
    }
    case 'stroke-dashoffset':
      return { strokeDashoffset: `${v[0]}` };
    default:
      return { [track.attr]: `${v[0]}` };
  }
}

interface Live {
  code: string;
  tracks: Track[];
  /** Web Animations (una por pista) cuando el navegador las soporta. */
  anims?: Animation[];
  /** Respaldo por rAF: fase de cada pista y último texto escrito. */
  phases: number[];
  written: string[];
}

const hasWaapi = () => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

/** Estado mutable de las animaciones de una escena (fuera de React: no provoca renders). */
class MotionEngine {
  private els: Element[] = [];
  private state = new WeakMap<Element, Live>();
  private clock = 0;
  private running = false;
  private unsubscribe?: () => void;

  /** Tras cada render: recoge los elementos animados y les da su estado sin esperar al siguiente frame. */
  sync(root: Element | null, active: boolean) {
    this.els = root && active ? Array.from(root.querySelectorAll('[data-mo]')) : [];
    if (this.els.length) {
      this.step(0);
    }
  }

  setRunning(running: boolean) {
    this.running = running;
    if (hasWaapi()) {
      // Web Animations: pausar/reanudar fuera de pantalla; el navegador ya las detiene en pestañas ocultas
      this.els.forEach((el) => this.state.get(el)?.anims?.forEach((a) => (running ? a.play() : a.pause())));
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = running ? onFrame((_, dt) => this.step(dt)) : undefined;
  }

  private prepare(el: Element, code: string): Live {
    const prev = this.state.get(el);
    if (prev && prev.code === code) {
      return prev;
    }
    const tracks = parseMotion(code);
    const same = (k: number) => !!prev && prev.tracks[k]?.attr === tracks[k].attr;
    // la fase se conserva si sólo cambia la duración (velocidad de ventiladores, flujo de la montante)
    const start = (t: Track) => ((((this.clock + t.offset) / t.dur) % 1) + 1) % 1;
    const phases = tracks.map((t, k) => (same(k) ? prev!.phases[k] : start(t)));
    const live: Live = { code, tracks, phases, written: tracks.map(() => '') };
    if (hasWaapi()) {
      live.anims = tracks.map((t, k) => {
        const old = same(k) ? prev!.anims?.[k] : undefined;
        const progress = old ? Number(old.effect?.getComputedTiming().progress ?? 0) : start(t);
        old?.cancel();
        const frames = t.values.map((v, j) => ({ ...keyframeOf(t, v), offset: t.keyTimes[j] }));
        const anim = (el as HTMLElement).animate(frames, {
          duration: t.dur * 1000,
          iterations: Infinity,
          easing: 'linear',
        });
        // misma fase que el reloj visual (o la que llevaba si sólo cambió la duración)
        anim.currentTime = progress * t.dur * 1000;
        if (!this.running) {
          anim.pause();
        }
        return anim;
      });
    }
    this.state.set(el, live);
    return live;
  }

  /** Avanza `dt` ms: con Web Animations sólo crea/actualiza; sin ellas escribe los atributos (bucle rAF). */
  step(dt: number) {
    this.clock += dt / 1000;
    for (const el of this.els) {
      const code = el.getAttribute('data-mo');
      if (!code) {
        continue;
      }
      const live = this.prepare(el, code);
      if (live.anims) {
        continue;
      }
      const { tracks, phases, written } = live;
      for (let k = 0; k < tracks.length; k++) {
        const t = tracks[k];
        phases[k] = (phases[k] + dt / 1000 / t.dur) % 1;
        const [name, text] = render(t, sample(t, phases[k]));
        if (text !== written[k]) {
          el.setAttribute(name, text);
          written[k] = text;
        }
      }
    }
  }
}

/**
 * Anima los elementos `[data-mo]` dentro de `root` mientras `active` sea verdadero y el elemento esté en
 * pantalla. Inactivo no escribe nada: los elementos muestran lo que pinta React (estado de reposo).
 *
 * Con Web Animations (todos los navegadores actuales) cada pista es una animación del documento: el motor de
 * animación del navegador la avanza en cada frame del reloj de la pantalla con su recálculo de estilos «sólo
 * animación», sin JavaScript por frame. Medido en la vista de planta de Grafana: escribir los atributos desde
 * rAF costaba ~28 ms de estilos por frame (cada escritura repasa los selectores de toda la página de Grafana);
 * con Web Animations ~3 ms. Sin Web Animations (jsdom) se usa el bucle rAF compartido.
 */
export function useMotion(root: RefObject<Element | null>, active: boolean): void {
  const onScreen = useOnScreen(root);
  const [engine] = useState(() => new MotionEngine());
  // sin dependencias: tras cada render (los refrescos de la simulación pueden añadir o quitar elementos)
  useLayoutEffect(() => engine.sync(root.current, active));
  const running = active && onScreen;
  useEffect(() => {
    engine.setRunning(running);
    return () => engine.setRunning(false);
  }, [engine, running]);
}
