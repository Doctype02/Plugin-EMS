import React from 'react';
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
}

/** Gráfico de líneas liviano en SVG para las proyecciones (sin dependencias). */
export const MiniChart: React.FC<Props> = ({ series, rules = [], xLabel, yUnit, height = 140 }) => {
  const styles = useStyles2(getStyles);
  const W = 280;
  const H = height;
  const pad = { l: 30, r: 6, t: 8, b: 18 };
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = [...series.flatMap((s) => s.points.map((p) => p[1])), ...rules.map((r) => r.y)];
  if (!xs.length) {
    return null;
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const span = Math.max(y1 - y0, 1);
  y0 -= span * 0.08;
  y1 += span * 0.08;
  const sx = (x: number) => pad.l + ((x - x0) / Math.max(x1 - x0, 1e-9)) * (W - pad.l - pad.r);
  const sy = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [0, 0.5, 1].map((k) => y0 + (y1 - y0) * k);
  const xt = [0, 0.25, 0.5, 0.75, 1].map((k) => x0 + (x1 - x0) * k);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className={styles.svg} role="img">
        {ticks.map((y) => (
          <g key={y}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(y)} y2={sy(y)} className={styles.grid} />
            <text x={pad.l - 3} y={sy(y) + 3} textAnchor="end" className={styles.axis}>
              {y.toFixed(span < 5 ? 1 : 0)}
            </text>
          </g>
        ))}
        {xt.map((x) => (
          <text key={x} x={sx(x)} y={H - 5} textAnchor="middle" className={styles.axis}>
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
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round"
            points={s.points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')}
          />
        ))}
        <text x={2} y={pad.t + 2} className={styles.axis}>
          {yUnit}
        </text>
      </svg>
      {series.length > 1 && (
        <div className={styles.legend}>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

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
  rule: css`
    font-size: 9px;
  `,
  legend: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    i {
      display: inline-block;
      width: 10px;
      height: 3px;
      vertical-align: middle;
      margin-right: 3px;
    }
  `,
});
