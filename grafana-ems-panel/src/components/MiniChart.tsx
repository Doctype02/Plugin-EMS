import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';

export interface ChartSeries {
  name: string;
  color: string;
  points: Array<[number, number]>;
  dashed?: boolean;
}

interface Props {
  series: ChartSeries[];
  /** Líneas horizontales de referencia (umbral, límite). */
  rules?: Array<{ y: number; label: string; color: string }>;
  xLabel: (x: number) => string;
  yUnit: string;
  height?: number;
  /** Línea vertical (p. ej. «ahora»). */
  marker?: { x: number; label: string };
  /** Eje x fijo (si no, el rango de los datos). */
  xDomain?: [number, number];
  /** Ticks del eje x (si no, 5 equiespaciados). */
  xTicks?: number[];
  /** Rellena bajo la primera serie. */
  area?: boolean;
  /** Dibuja las series en escalones (potencia: cada escalón es un equipo que entra o sale). */
  step?: boolean;
}

/** Convierte una serie en escalones: mantiene el valor hasta el punto siguiente. */
function stepped(points: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  points.forEach((p, i) => {
    if (i > 0) {
      out.push([p[0], points[i - 1][1]]);
    }
    out.push(p);
  });
  return out;
}

/** Gráfico de líneas liviano en SVG para las proyecciones (sin dependencias). */
export const MiniChart: React.FC<Props> = ({
  series,
  rules = [],
  xLabel,
  yUnit,
  height = 140,
  marker,
  xDomain,
  xTicks,
  area,
  step,
}) => {
  const styles = useStyles2(getStyles);
  const [hoverX, setHoverX] = useState<number | undefined>(undefined);
  const W = 280;
  const H = height;
  const pad = { l: 30, r: 8, t: 14, b: 18 };
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = [...series.flatMap((s) => s.points.map((p) => p[1])), ...rules.map((r) => r.y)];
  if (!xs.length) {
    return null;
  }
  const x0 = xDomain ? xDomain[0] : Math.min(...xs);
  const x1 = xDomain ? xDomain[1] : Math.max(...xs);
  const dataMin = Math.min(...ys);
  let y0 = Math.min(0, dataMin);
  let y1 = Math.max(...ys);
  const span = Math.max(y1 - y0, 1);
  y0 = dataMin >= 0 && y0 === 0 ? 0 : y0 - span * 0.08;
  y1 += span * 0.08;
  const sx = (x: number) => pad.l + ((x - x0) / Math.max(x1 - x0, 1e-9)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((k) => y0 + (y1 - y0) * k);
  const xt = xTicks ?? [0, 0.25, 0.5, 0.75, 1].map((k) => x0 + (x1 - x0) * k);
  // lectura al pasar el cursor: el valor de cada serie en ese instante
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / Math.max(r.width, 1)) * W;
    const x = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    setHoverX(x < x0 || x > x1 ? undefined : x);
  };
  const readout =
    hoverX === undefined
      ? []
      : series
          .map((s) => ({ s, v: valueAt(s.points, hoverX, !!step) }))
          .filter((r): r is { s: ChartSeries; v: number } => r.v !== undefined);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        className={styles.svg}
        role="img"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(undefined)}
      >
        {ticks.map((y) => (
          <g key={y}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(y)} y2={sy(y)} className={styles.grid} />
            <text x={pad.l - 3} y={sy(y) + 3} textAnchor="end" className={styles.axis}>
              {y.toFixed(span < 5 ? 1 : 0)}
            </text>
          </g>
        ))}
        {xt.map((x, i) => (
          <text
            key={x}
            x={sx(x)}
            y={H - 5}
            textAnchor={i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}
            className={styles.axis}
          >
            {xLabel(x)}
          </text>
        ))}
        {rules.map((r) => (
          <g key={r.label}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={sy(r.y)}
              y2={sy(r.y)}
              stroke={r.color}
              strokeDasharray="4 3"
              strokeWidth={1}
            />
            <text x={W - pad.r - 2} y={sy(r.y) - 3} textAnchor="end" className={styles.rule} fill={r.color}>
              {r.label}
            </text>
          </g>
        ))}
        {area && series[0] && series[0].points.length > 1 && (
          <path
            d={`M${sx(series[0].points[0][0])},${sy(y0)}L${(step ? stepped(series[0].points) : series[0].points)
              .map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
              .join('L')}L${sx(series[0].points[series[0].points.length - 1][0])},${sy(y0)}Z`}
            fill={series[0].color}
            opacity={0.14}
          />
        )}
        {marker && (
          <g>
            <line x1={sx(marker.x)} x2={sx(marker.x)} y1={pad.t} y2={H - pad.b} className={styles.marker} />
            <text
              x={sx(marker.x) > W - 40 ? sx(marker.x) - 3 : sx(marker.x) + 3}
              y={H - pad.b - 4}
              textAnchor={sx(marker.x) > W - 40 ? 'end' : 'start'}
              className={styles.axis}
            >
              {marker.label}
            </text>
          </g>
        )}
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
            points={(step ? stepped(s.points) : s.points)
              .map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
              .join(' ')}
          />
        ))}
        <text x={2} y={8} className={styles.axis}>
          {yUnit}
        </text>
        {readout.length > 0 && (
          <g pointerEvents="none">
            <line x1={sx(hoverX!)} x2={sx(hoverX!)} y1={pad.t} y2={H - pad.b} className={styles.cross} />
            {readout.map(({ s, v }) => (
              <circle key={s.name} cx={sx(hoverX!)} cy={sy(v)} r={3} fill={s.color} className={styles.dot} />
            ))}
          </g>
        )}
      </svg>
      {readout.length > 0 ? (
        <div className={styles.legend} data-testid="ems-chart-readout">
          <b>{xLabel(hoverX!)}</b>
          {readout.map(({ s, v }) => (
            <span key={s.name}>
              <i style={{ background: s.color }} /> {s.name} <b>{v.toFixed(Math.abs(v) < 10 ? 1 : 0)}</b> {yUnit}
            </span>
          ))}
        </div>
      ) : (
        series.length > 1 && (
          <div className={styles.legend}>
            {series.map((s) => (
              <span key={s.name}>
                <i style={{ background: s.color }} /> {s.name}
              </span>
            ))}
          </div>
        )
      )}
    </div>
  );
};

/** Valor de una serie en x: el último punto anterior (escalones) o la interpolación lineal. */
function valueAt(points: Array<[number, number]>, x: number, step: boolean): number | undefined {
  if (!points.length || x < points[0][0] || x > points[points.length - 1][0]) {
    return undefined;
  }
  let i = 0;
  while (i < points.length - 1 && points[i + 1][0] <= x) {
    i++;
  }
  const [xa, ya] = points[i];
  const next = points[i + 1];
  if (step || !next || next[0] === xa) {
    return ya;
  }
  return ya + ((next[1] - ya) * (x - xa)) / (next[0] - xa);
}

const getStyles = (theme: GrafanaTheme2) => ({
  svg: css`
    display: block;
  `,
  grid: css`
    stroke: ${theme.colors.border.weak};
    stroke-width: 1;
  `,
  axis: css`
    font-size: 9px;
    fill: ${theme.colors.text.secondary};
  `,
  marker: css`
    stroke: ${theme.colors.text.secondary};
    stroke-width: 1;
    stroke-dasharray: 2 2;
  `,
  rule: css`
    font-size: 9px;
  `,
  cross: css`
    stroke: ${theme.colors.text.secondary};
    stroke-width: 1;
  `,
  dot: css`
    stroke: ${theme.colors.background.secondary};
    stroke-width: 1.5;
  `,
  legend: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0, 1.5)};
    min-height: 17px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: ${theme.colors.text.secondary};
    b {
      color: ${theme.colors.text.primary};
      font-weight: 500;
    }
    i {
      display: inline-block;
      width: 10px;
      height: 3px;
      vertical-align: middle;
      margin-right: 3px;
    }
  `,
});
