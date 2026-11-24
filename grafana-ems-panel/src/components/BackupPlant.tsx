/**
 * Planta de respaldo dibujada en el patio técnico, junto a la fachada lateral visible del edificio:
 * grupo electrógeno insonorizado con su escape, tanque de diésel (con el nivel) y tablero de transferencia
 * automática. Cambia con el estado en vivo: en espera (gris), en marcha (naranja, humo en el escape, LED del
 * tablero en «planta») o en falla (rojo). Diseño y cálculos: docs/PLANTA_RESPALDO.md.
 */
import React from 'react';
import { BACKUP, BUILDING } from 'building/model';
import { Azimuth, IsoConfig, Prism, Pt, path, prism, rotate, toScreen } from 'building/iso';

interface Rect {
  x: number;
  y: number;
  w: number;
  d: number;
}
import { Materials, faceColor, lit } from 'building/materials';
import { MeterState } from 'building/telemetry';

/** Patio técnico en el plano rotado (origen en el centro del edificio): al costado x' visible. */
// (dibujada algo mayor que a escala para que se distinga junto a un edificio de 20 m)
const YARD = { x: BUILDING.width / 2 + 1.4, y: -BUILDING.depth / 2 + 4.0, w: 5.2, d: 13.6 };

/** Rectángulo del plano rotado → rectángulo en coordenadas del edificio (para `prism`). */
function fromRotated(r: Rect, az: Azimuth): Rect {
  const inv = ((360 - az) % 360) as Azimuth;
  const cx = BUILDING.width / 2;
  const cy = BUILDING.depth / 2;
  // `rotate` gira alrededor del centro y devuelve coordenadas relativas a él
  const a = rotate(cx + r.x, cy + r.y, inv);
  const b = rotate(cx + r.x + r.w, cy + r.y + r.d, inv);
  return { x: cx + Math.min(a.x, b.x), y: cy + Math.min(a.y, b.y), w: Math.abs(a.x - b.x), d: Math.abs(a.y - b.y) };
}

const sub = (dx: number, dy: number, w: number, d: number): Rect => ({ x: YARD.x + dx, y: YARD.y + dy, w, d });

/** Esquinas del patio en pantalla, para que el encuadre de la vista lo incluya. */
export function plantScreenPoints(cfg: IsoConfig): Pt[] {
  const r = fromRotated(YARD, cfg.azimuth);
  const out: Pt[] = [];
  for (const z of [0, 6.5]) {
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.d],
      [r.x, r.y + r.d],
    ]) {
      out.push(toScreen(x, y, z, cfg));
    }
  }
  return out;
}

export type PlantStatus = 'espera' | 'marcha' | 'falla';

export function plantStatus(meter?: MeterState): PlantStatus {
  if (meter?.powerMode === 'generador') {
    return 'marcha';
  }
  return meter?.gridOk === false ? 'falla' : 'espera';
}

interface Props {
  iso: IsoConfig;
  meter?: MeterState;
  M: Materials;
  dark: boolean;
  ink: string;
  ink2: string;
  surface: string;
  border: string;
  animate: boolean;
  /** Unidades de dibujo por píxel de pantalla (para textos de tamaño constante). */
  u: number;
}

export const BackupPlant: React.FC<Props> = ({ iso, meter, M, dark, ink, ink2, surface, border, animate, u }) => {
  if (!BACKUP.enabled) {
    return null;
  }
  const status = plantStatus(meter);
  const running = status === 'marcha';
  const accent = running ? '#FF780A' : status === 'falla' ? '#F2495C' : '#E8B10C';
  const fuel = Math.max(0, Math.min(1, (meter?.genFuelPct ?? 100) / 100));
  const R = (r: Rect) => fromRotated(r, iso.azimuth);
  const box = (r: Rect, z0: number, h: number) => prism(R(r), z0, h, iso);

  const pad = box(sub(0, 0, YARD.w, YARD.d), 0, 0.12);
  const genset = box(sub(1.2, 0.8, 2.6, 6.2), 0.12, 3.0); // cabina insonorizada
  const stack = box(sub(2.2, 1.3, 0.6, 0.6), 3.12, 1.4); // escape
  const tank = box(sub(1.2, 7.8, 2.6, 2.8), 0.12, 2.2);
  const tankFuel = box(sub(1.2, 7.8, 2.6, 2.8), 0.12, 2.2 * fuel);
  const ats = box(sub(1.7, 11.4, 1.6, 1.2), 0.12, 2.8);

  const body = dark ? '#8a94a0' : '#e6e9ed';
  const solid = (p: Prism, color: string, key: string, stroke = true) => (
    <g key={key}>
      {p.sides.map((sd, i) => (
        <path
          key={i}
          d={path(sd.points)}
          fill={faceColor(color, sd.facing)}
          stroke={stroke ? lit(color, dark ? 1.35 : 0.8) : 'none'}
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        d={path(p.top)}
        fill={lit(color, dark ? 1.2 : 1.05)}
        stroke={stroke ? lit(color, dark ? 1.35 : 0.8) : 'none'}
        strokeWidth={0.5}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
  /** Punto sobre una cara lateral (u, v ∈ [0, 1]). */
  const onSide = (p: Prism, facing: 'front' | 'side', fu: number, fv: number): Pt => {
    const q = (p.sides.find((s) => s.facing === facing) ?? p.sides[0]).points;
    const bottom = { x: q[0].x + (q[1].x - q[0].x) * fu, y: q[0].y + (q[1].y - q[0].y) * fu };
    const top = { x: q[3].x + (q[2].x - q[3].x) * fu, y: q[3].y + (q[2].y - q[3].y) * fu };
    return { x: bottom.x + (top.x - bottom.x) * fv, y: bottom.y + (top.y - bottom.y) * fv };
  };
  const louvers = [0.25, 0.4, 0.55, 0.7].map((v) => [onSide(genset, 'side', 0.12, v), onSide(genset, 'side', 0.5, v)]);
  const stripe = [onSide(genset, 'side', 0.04, 0.86), onSide(genset, 'side', 0.96, 0.86)];
  const led = onSide(ats, 'side', 0.5, 0.78);
  const smokeAt = { x: stack.top.reduce((a, p) => a + p.x, 0) / 4, y: stack.top.reduce((a, p) => a + p.y, 0) / 4 };
  const labelAt = { x: genset.top.reduce((a, p) => a + p.x, 0) / 4, y: Math.min(...stack.top.map((p) => p.y)) };
  const kw = meter?.pGen ?? 0;
  const text = running
    ? `Planta ${kw.toFixed(0)} kW · diésel ${(fuel * 100).toFixed(0)} %`
    : status === 'falla'
      ? 'Planta fuera de servicio'
      : `Planta ${BACKUP.genKw} kW · en espera`;
  const fs = 10.5 * u;
  const tw = (text.length * 5.9 + 18) * u;

  return (
    <g data-testid="ems-backup-plant" pointerEvents="none">
      {solid(pad, dark ? '#3b424b' : '#c3c9d1', 'pad')}
      {solid(genset, body, 'genset')}
      <path
        d={`M${stripe[0].x.toFixed(1)},${stripe[0].y.toFixed(1)}L${stripe[1].x.toFixed(1)},${stripe[1].y.toFixed(1)}`}
        stroke={accent}
        strokeWidth={3.5}
        vectorEffect="non-scaling-stroke"
      />
      {louvers.map(([a, b], i) => (
        <path
          key={i}
          d={`M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`}
          stroke={lit(body, dark ? 0.6 : 0.62)}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {solid(stack, dark ? '#59616b' : '#8b929b', 'stack')}
      {running && (
        <g>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={smokeAt.x} cy={smokeAt.y} r={2.2 * u} fill={dark ? '#aeb4bc' : '#8b929b'} opacity={0.45}>
              {animate && (
                <>
                  <animate attributeName="cy" from={smokeAt.y} to={smokeAt.y - 26 * u} dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />
                  <animate attributeName="r" from={2 * u} to={7 * u} dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />
                  <animate attributeName="opacity" from={0.5} to={0} dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" />
                </>
              )}
            </circle>
          ))}
        </g>
      )}
      {solid(tank, dark ? '#4b535d' : '#f2f4f6', 'tank')}
      {fuel > 0.01 && solid(tankFuel, fuel < 0.2 ? '#F2495C' : fuel < 0.4 ? '#FF9830' : '#C9A227', 'fuel', false)}
      {solid(ats, dark ? '#6b7480' : '#c9ced5', 'ats')}
      <circle
        cx={led.x}
        cy={led.y}
        r={2.6 * u}
        fill={running ? '#FF780A' : status === 'falla' ? '#F2495C' : '#73BF69'}
        stroke={surface}
        strokeWidth={0.8 * u}
      />
      <g transform={`translate(${(labelAt.x - tw / 2).toFixed(1)} ${(labelAt.y - 26 * u).toFixed(1)})`}>
        <rect
          width={tw}
          height={18 * u}
          rx={9 * u}
          fill={surface}
          stroke={running || status === 'falla' ? accent : border}
          strokeWidth={1 * u}
          opacity={0.96}
        />
        <circle cx={9 * u} cy={9 * u} r={3 * u} fill={accent} />
        <text x={16 * u} y={12.6 * u} fontSize={fs} fontWeight={600} fill={running ? ink : ink2}>
          {text}
        </text>
      </g>
    </g>
  );
};
