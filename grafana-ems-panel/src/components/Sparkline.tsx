import React from 'react';
import { colorManipulator } from '@grafana/data';

interface Props {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}

/** Mini gráfica de tendencia (sin ejes) para el detalle de un equipo. */
export const Sparkline: React.FC<Props> = ({ values, color, width = 120, height = 32 }) => {
  if (values.length < 2) {
    return null;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const points = values.map((v, i) => [
    (i / (values.length - 1)) * width,
    pad + (1 - (v - min) / range) * (height - pad * 2),
  ]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={`${line}L${width} ${height}L0 ${height}Z`} fill={colorManipulator.alpha(color, 0.15)} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
};
