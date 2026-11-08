import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { Azimuth, rotate } from 'building/iso';
import { BUILDING } from 'building/model';
import { formatClock, sunPosition } from 'building/clock';

interface Props {
  azimuth: Azimuth;
  time: number;
  irradiance?: number;
  tExt?: number;
}

/** Dirección en pantalla (ángulo SVG) de un vector del plano (este, norte) en la vista isométrica. */
function screenAngle(e: number, n: number, az: Azimuth): number {
  const c = rotate(BUILDING.width / 2 + e, BUILDING.depth / 2 + n, az);
  const x = (c.x + c.y) * Math.cos(Math.PI / 6);
  const y = -(c.y - c.x) * 0.5;
  return Math.atan2(y, x);
}

/** Brújula con la orientación de la vista y la posición del sol a la hora simulada. */
export const SceneCompass: React.FC<Props> = ({ azimuth, time, irradiance, tExt }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const sun = sunPosition(time);
  const R = 30;
  const dirs: Array<[string, number, number]> = [
    ['N', 0, 1],
    ['E', 1, 0],
    ['S', 0, -1],
    ['O', -1, 0],
  ];
  const up = sun.elevation > 0;
  const sa = screenAngle(Math.sin((sun.azimuth * Math.PI) / 180), Math.cos((sun.azimuth * Math.PI) / 180), azimuth);
  const sr = R * Math.max(0.15, Math.cos((Math.max(sun.elevation, 0) * Math.PI) / 180));
  const f = formatClock(time);
  return (
    <div className={styles.box} data-testid="ems-compass">
      <svg width={80} height={80} viewBox="-40 -40 80 80" aria-label="Brújula y posición del sol">
        <circle r={R} className={styles.ring} />
        <circle r={R * 0.55} className={styles.inner} />
        {dirs.map(([l, e, n]) => {
          const a = screenAngle(e, n, azimuth);
          const x = Math.cos(a) * (R + 0.5);
          const y = Math.sin(a) * (R + 0.5);
          return (
            <g key={l}>
              <line x1={Math.cos(a) * (R - 5)} y1={Math.sin(a) * (R - 5)} x2={x} y2={y} className={styles.tick} />
              <text
                x={Math.cos(a) * (R + 7)}
                y={Math.sin(a) * (R + 7) + 3}
                textAnchor="middle"
                className={l === 'N' ? styles.north : styles.dir}
              >
                {l}
              </text>
            </g>
          );
        })}
        {(() => {
          const a = screenAngle(0, 1, azimuth);
          return (
            <path
              d={`M${Math.cos(a) * (R - 6)},${Math.sin(a) * (R - 6)} L${Math.cos(a + 2.6) * 6},${Math.sin(a + 2.6) * 6} L${Math.cos(a - 2.6) * 6},${Math.sin(a - 2.6) * 6}Z`}
              fill={theme.colors.error.main}
              opacity={0.85}
            />
          );
        })()}
        {up && (
          <g>
            <line
              x1={0}
              y1={0}
              x2={Math.cos(sa) * sr}
              y2={Math.sin(sa) * sr}
              stroke="#f2a900"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle
              cx={Math.cos(sa) * sr}
              cy={Math.sin(sa) * sr}
              r={5}
              fill="#f5b400"
              stroke={theme.colors.background.primary}
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
      <div className={styles.text}>
        <div className={styles.time}>{f.time}</div>
        <div className={styles.muted}>
          {up ? `Sol ${sun.elevation.toFixed(0)}° · az ${sun.azimuth.toFixed(0)}°` : 'Sol bajo el horizonte'}
        </div>
        <div className={styles.muted}>
          {irradiance !== undefined ? `${irradiance.toFixed(0)} W/m²` : ''}
          {tExt !== undefined ? ` · ${tExt.toFixed(1)} °C` : ''}
        </div>
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    position: absolute;
    right: ${theme.spacing(1)};
    bottom: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(0.5, 1, 0.5, 0.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    box-shadow: ${theme.shadows.z1};
    pointer-events: none;
    z-index: 1;
  `,
  ring: css`
    fill: ${theme.colors.background.secondary};
    stroke: ${theme.colors.border.medium};
  `,
  inner: css`
    fill: none;
    stroke: ${theme.colors.border.weak};
    stroke-dasharray: 2 2;
  `,
  tick: css`
    stroke: ${theme.colors.text.secondary};
  `,
  dir: css`
    font-size: 8px;
    fill: ${theme.colors.text.secondary};
  `,
  north: css`
    font-size: 9px;
    font-weight: 700;
    fill: ${theme.colors.error.text};
  `,
  text: css`
    display: flex;
    flex-direction: column;
    gap: 1px;
  `,
  time: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  muted: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
});
