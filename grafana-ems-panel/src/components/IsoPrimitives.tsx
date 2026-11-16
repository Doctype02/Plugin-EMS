import React from 'react';
import { Prism, Pt, path } from 'building/iso';
import { Materials, faceColor, lit } from 'building/materials';
import { Status } from 'building/telemetry';

/** Interpolación lineal entre dos puntos de pantalla. */
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Punto (u a lo largo, v en altura) sobre una cara lateral [b0, b1, t1, t0]. */
export const onFace = (q: Pt[], u: number, v: number): Pt => lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), v);

/** Sub-cuadrilátero de una cara lateral entre u0–u1 (largo) y v0–v1 (alto). */
export const faceQuad = (q: Pt[], u0: number, u1: number, v0: number, v1: number): Pt[] => [
  onFace(q, u0, v0),
  onFace(q, u1, v0),
  onFace(q, u1, v1),
  onFace(q, u0, v1),
];

/** Varios segmentos en un único `d` (menos nodos SVG). */
export const segments = (pairs: Array<[Pt, Pt]>) =>
  pairs.map(([a, b]) => `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`).join('');

/**
 * Caja iluminada: caras frontal y lateral con la luz de la escena y la superior con el color base.
 * `edge` dibuja un filo fino (más oscuro) que define la arista sin contornos pesados.
 */
export function boxPaths(
  p: Prism,
  color: string,
  key: string,
  opts: { top?: string; edge?: boolean; opacity?: number } = {}
): React.ReactNode[] {
  const stroke = opts.edge === false ? undefined : lit(color, 0.72);
  return [
    ...p.sides.map((sd, i) => (
      <path
        key={`${key}s${i}`}
        d={path(sd.points)}
        fill={faceColor(color, sd.facing)}
        stroke={stroke}
        strokeWidth={stroke ? 0.3 : undefined}
        strokeLinejoin="round"
        opacity={opts.opacity}
      />
    )),
    <path
      key={`${key}t`}
      d={path(p.top)}
      fill={opts.top ?? color}
      stroke={stroke}
      strokeWidth={stroke ? 0.3 : undefined}
      strokeLinejoin="round"
      opacity={opts.opacity}
    />,
  ];
}

/** Forma del indicador de estado (no sólo color): círculo, triángulo, rombo o anillo. */
export const StatusMark: React.FC<{ status: Status; color: string; size?: number; x?: number; y?: number }> = ({
  status,
  color,
  size = 9,
  x = 0,
  y = 0,
}) => {
  const r = size / 2;
  switch (status) {
    case 'warning':
      return <path d={`M${x},${y - r}L${x + r},${y + r * 0.8}L${x - r},${y + r * 0.8}Z`} fill={color} />;
    case 'critical':
      return <path d={`M${x},${y - r}L${x + r},${y}L${x},${y + r}L${x - r},${y}Z`} fill={color} />;
    case 'offline':
      return <circle cx={x} cy={y} r={r * 0.75} fill="none" stroke={color} strokeWidth={1.6} />;
    default:
      return <circle cx={x} cy={y} r={r * 0.8} fill={color} />;
  }
};

const CHIP_H = 22;
const CHIP_H_SMALL = 20;

/** Tamaño en px de la ficha de zona (estimado con el ancho medio de los dígitos y letras de Inter). */
export function chipSize(
  id: string,
  name: string,
  value: string,
  manual: boolean,
  small = false
): { w: number; h: number } {
  const idW = id.length * (small ? 7 : 7.4);
  const nameW = name ? name.length * 6.5 + 5 : 0;
  const valueW = value.length * (small ? 7 : 7.6);
  return {
    w: Math.ceil(8 + 12 + idW + nameW + 10 + valueW + 8 + (manual ? 18 : 0)),
    h: small ? CHIP_H_SMALL : CHIP_H,
  };
}

export interface ChipColors {
  surface: string;
  border: string;
  ink: string;
  ink2: string;
  accent: string;
}

/**
 * Ficha compacta de zona (px): marca de estado, código, nombre corto y valor de la capa; "M" si está en
 * manual. Se dibuja centrada en (0, 0) dentro de un grupo escalado a px.
 */
export const ZoneChip: React.FC<{
  id: string;
  name: string;
  value: string;
  status: Status;
  statusColor: string;
  manual: boolean;
  small?: boolean;
  selected?: boolean;
  hovered?: boolean;
  colors: ChipColors;
  /** Capas de datos: muestra el color de la capa (cuadro) en lugar de la marca de estado normal. */
  swatch?: string;
}> = ({ id, name, value, status, statusColor, manual, small = false, selected, hovered, colors, swatch }) => {
  const { w, h } = chipSize(id, name, value, manual, small);
  const x0 = -w / 2;
  const alert = status === 'warning' || status === 'critical';
  const border = selected || hovered ? colors.accent : alert ? statusColor : colors.border;
  const fs = small ? 11 : 11.5;
  return (
    <>
      <rect
        x={x0}
        y={-h / 2}
        width={w}
        height={h}
        rx={4}
        fill={colors.surface}
        fillOpacity={0.96}
        stroke={border}
        strokeWidth={selected ? 2 : alert || hovered ? 1.5 : 1}
      />
      {swatch && !alert ? (
        <rect x={x0 + 7} y={-5} width={10} height={10} rx={2} fill={swatch} stroke={colors.border} strokeWidth={0.8} />
      ) : (
        <StatusMark status={status} color={statusColor} x={x0 + 12} y={0} size={small ? 8 : 9} />
      )}
      <text x={x0 + 20} y={fs * 0.36} fontSize={fs} fill={colors.ink} style={{ fontVariantNumeric: 'tabular-nums' }}>
        <tspan fontWeight={600}>{id}</tspan>
        {name && (
          <tspan dx={5} fill={colors.ink2}>
            {name}
          </tspan>
        )}
      </text>
      <text
        x={w / 2 - 8 - (manual ? 18 : 0)}
        y={fs * 0.38}
        textAnchor="end"
        fontSize={small ? 11.5 : 12}
        fontWeight={600}
        fill={colors.ink}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </text>
      {manual && (
        <g data-testid={`ems-manual-${id}`}>
          <rect x={w / 2 - 18} y={-7} width={14} height={14} rx={3} fill="#eda100" />
          <text x={w / 2 - 11} y={3.5} fontSize={9.5} fontWeight={700} textAnchor="middle" fill="#1a1a19">
            M
          </text>
        </g>
      )}
    </>
  );
};

/**
 * Definiciones compartidas de la escena (una sola vez por SVG): patrones de piso en metros del plano,
 * rayados de estado, sombras ambientales, vidrio, follaje, celdas FV y degradados de efectos.
 */
export const SceneDefs: React.FC<{
  id: string;
  M: Materials;
  statusColors: Record<Status, string>;
  ink2: string;
  sky: { top: string; bottom: string };
  night: boolean;
  blur: number;
}> = ({ id, M, statusColors, ink2, sky, night, blur }) => {
  const line = M.dark ? '#ffffff' : '#000000';
  return (
    <defs>
      {/* rayados de estado en metros del plano (se usan dentro de planeMatrix) */}
      {(
        [
          ['offline', ink2, 0.5],
          ['warning', statusColors.warning, 0.55],
          ['critical', statusColors.critical, 0.6],
        ] as const
      ).map(([k, c, o]) => (
        <pattern
          key={k}
          id={`${id}-hatch-${k}`}
          width={0.7}
          height={0.7}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={0.7} stroke={c} strokeWidth={0.12} opacity={o} />
        </pattern>
      ))}
      {/* los mismos rayados en px de pantalla (caras dibujadas fuera de planeMatrix) */}
      {(
        [
          ['offline', ink2, 0.5],
          ['warning', statusColors.warning, 0.6],
          ['critical', statusColors.critical, 0.65],
        ] as const
      ).map(([k, c, o]) => (
        <pattern
          key={`s${k}`}
          id={`${id}-hatchs-${k}`}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={6} stroke={c} strokeWidth={1.2} opacity={o} />
        </pattern>
      ))}
      {/* acabados de piso */}
      <pattern id={`${id}-fl-carpet`} width={0.5} height={0.5} patternUnits="userSpaceOnUse">
        <path d="M0,0H0.5M0,0V0.5" stroke={line} strokeWidth={0.012} opacity={M.dark ? 0.07 : 0.06} fill="none" />
      </pattern>
      <pattern id={`${id}-fl-tile`} width={0.3} height={0.3} patternUnits="userSpaceOnUse">
        <path d="M0,0H0.3M0,0V0.3" stroke={line} strokeWidth={0.014} opacity={M.dark ? 0.14 : 0.12} fill="none" />
      </pattern>
      <pattern id={`${id}-fl-raised`} width={0.6} height={0.6} patternUnits="userSpaceOnUse">
        <path d="M0,0H0.6M0,0V0.6" stroke={line} strokeWidth={0.02} opacity={M.dark ? 0.18 : 0.14} fill="none" />
        <circle cx={0.3} cy={0.3} r={0.012} fill={line} opacity={0.12} />
      </pattern>
      <pattern id={`${id}-fl-stone`} width={1.2} height={0.6} patternUnits="userSpaceOnUse">
        <path d="M0,0H1.2M0,0V0.6" stroke={line} strokeWidth={0.014} opacity={M.dark ? 0.1 : 0.08} fill="none" />
      </pattern>
      <pattern id={`${id}-fl-wood`} width={1.8} height={0.2} patternUnits="userSpaceOnUse">
        <path d="M0,0H1.8M0,0V0.2" stroke={line} strokeWidth={0.01} opacity={M.dark ? 0.12 : 0.1} fill="none" />
      </pattern>
      <pattern id={`${id}-fl-plain`} width={1} height={1} patternUnits="userSpaceOnUse" />
      {/* sombra ambiental al pie de los muros: del muro (n/s/e/w) hacia el interior */}
      {(
        [
          ['n', 0, 1, 0, 0],
          ['s', 0, 0, 0, 1],
          ['e', 1, 0, 0, 0],
          ['w', 0, 0, 1, 0],
        ] as const
      ).map(([k, x1, y1, x2, y2]) => (
        <linearGradient key={k} id={`${id}-ao-${k}`} x1={x1} y1={y1} x2={x2} y2={y2}>
          <stop offset="0%" stopColor="#000" stopOpacity={M.aoOpacity} />
          <stop offset="100%" stopColor="#000" stopOpacity={0} />
        </linearGradient>
      ))}
      {/* sombra de contacto de muebles y equipos */}
      <radialGradient id={`${id}-contact`}>
        <stop offset="40%" stopColor="#000" stopOpacity={M.aoOpacity * 1.3} />
        <stop offset="100%" stopColor="#000" stopOpacity={0} />
      </radialGradient>
      {/* vidrio: reflejo del cielo (de día) o noche, con brillo diagonal */}
      <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor={night ? lit(M.glass, 0.45) : M.glassHi} stopOpacity={0.95} />
        <stop offset="45%" stopColor={night ? lit(M.glass, 0.35) : M.glass} stopOpacity={0.9} />
        <stop offset="100%" stopColor={lit(M.glass, night ? 0.3 : 0.78)} stopOpacity={0.95} />
      </linearGradient>
      <linearGradient id={`${id}-glassLit`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#fff4d1" stopOpacity={0.95} />
        <stop offset="100%" stopColor="#f2d58e" stopOpacity={0.9} />
      </linearGradient>
      <linearGradient id={`${id}-curtain`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor={M.glassHi} stopOpacity={M.dark ? 0.16 : 0.3} />
        <stop offset="50%" stopColor={M.glass} stopOpacity={0.1} />
        <stop offset="62%" stopColor={M.glassHi} stopOpacity={M.dark ? 0.12 : 0.22} />
        <stop offset="100%" stopColor={M.glass} stopOpacity={0.08} />
      </linearGradient>
      <radialGradient id={`${id}-leaf`} cx="0.35" cy="0.3" r="0.75">
        <stop offset="0%" stopColor={M.leafHi} />
        <stop offset="100%" stopColor={M.leaf} />
      </radialGradient>
      <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={sky.top} />
        <stop offset="100%" stopColor={sky.bottom} />
      </linearGradient>
      <radialGradient id={`${id}-vignette`} cx="0.5" cy="0.55" r="0.65">
        <stop offset="0%" stopColor={M.dark ? '#ffffff' : '#ffffff'} stopOpacity={M.dark ? 0.035 : 0.5} />
        <stop offset="100%" stopColor={M.dark ? '#ffffff' : '#ffffff'} stopOpacity={0} />
      </radialGradient>
      <filter id={`${id}-soft`} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation={blur} />
      </filter>
      <radialGradient id={`${id}-fire`}>
        <stop offset="0%" stopColor="#ffdd55" stopOpacity={0.95} />
        <stop offset="45%" stopColor="#ff7a1a" stopOpacity={0.75} />
        <stop offset="100%" stopColor="#e0301e" stopOpacity={0} />
      </radialGradient>
      <radialGradient id={`${id}-glow`}>
        <stop offset="0%" stopColor="#ffe9a8" stopOpacity={M.dark ? 0.55 : 0.75} />
        <stop offset="100%" stopColor="#ffe9a8" stopOpacity={0} />
      </radialGradient>
    </defs>
  );
};
