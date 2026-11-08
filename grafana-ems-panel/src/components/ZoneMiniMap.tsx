import React from 'react';
import { Glyph } from './Glyph';
import { GrafanaTheme2 } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, ZONES } from 'building/model';
import { Snapshot } from 'building/telemetry';
import { EVENTS, EventKind } from 'building/events';

interface Props {
  snapshot: Snapshot;
  manual?: Set<string>;
  selected?: string;
  /** Zonas que no se pueden elegir (se dibujan atenuadas). */
  disabled?: (id: string) => boolean;
  onSelect: (id: string) => void;
}

/** Color de temperatura: azul (frío) → verde (confort) → ámbar → rojo (calor). */
export function tempColor(t: number, dark: boolean): string {
  const stops: Array<[number, [number, number, number]]> = [
    [19, [64, 120, 220]],
    [22.5, [56, 170, 200]],
    [24, [74, 180, 110]],
    [26, [230, 180, 60]],
    [29, [230, 100, 50]],
    [33, [200, 40, 60]],
  ];
  let c = stops[stops.length - 1][1];
  if (t <= stops[0][0]) {
    c = stops[0][1];
  } else {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, a] = stops[i - 1];
        const [t1, b] = stops[i];
        const k = (t - t0) / (t1 - t0);
        c = [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k)) as [number, number, number];
        break;
      }
    }
  }
  const alpha = dark ? 0.55 : 0.45;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Plano en planta de las dos plantas: cada zona con su temperatura; clic para elegirla. */
export const ZoneMiniMap: React.FC<Props> = ({ snapshot, manual, selected, disabled, onSelect }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const S = 5.4; // px por metro
  const W = BUILDING.width * S;
  const D = BUILDING.depth * S;
  return (
    <div className={styles.row}>
      {[...FLOORS].reverse().map((f) => (
        <div key={f.level} className={styles.floor}>
          <div className={styles.floorLabel}>{f.name}</div>
          <svg width="100%" viewBox={`-1 -1 ${W + 2} ${D + 2}`} className={styles.svg} role="group" aria-label={f.name}>
            <rect x={0} y={0} width={W} height={D} className={styles.slab} />
            {ZONES.filter((z) => z.floor === f.level).map((z) => {
              const s = snapshot.zones[z.id];
              const x = z.rect.x * S;
              const y = (BUILDING.depth - z.rect.y - z.rect.d) * S; // norte arriba
              const w = z.rect.w * S;
              const h = z.rect.d * S;
              const off = disabled?.(z.id);
              const ev = s?.events?.[0] as EventKind | undefined;
              const small = w < 30 || h < 22;
              return (
                <g
                  key={z.id}
                  className={cx(styles.zone, off && styles.off, selected === z.id && styles.sel)}
                  onClick={() => !off && onSelect(z.id)}
                  role="button"
                  aria-label={`${z.id} ${z.name}`}
                  data-testid={`ems-minimap-${z.id}`}
                >
                  <title>
                    {z.id} · {z.name}
                    {s ? ` — ${s.temp.toFixed(1)} °C, ${s.occupants} personas` : ''}
                  </title>
                  <rect
                    x={x + 0.6}
                    y={y + 0.6}
                    width={w - 1.2}
                    height={h - 1.2}
                    rx={2}
                    fill={s ? (s.fire ? 'rgba(230,60,30,0.75)' : tempColor(s.temp, theme.isDark)) : 'transparent'}
                  />
                  <text x={x + w / 2} y={y + h / 2 - (small ? 0 : 3)} className={styles.id} textAnchor="middle">
                    {z.id}
                  </text>
                  {!small && s && (
                    <text x={x + w / 2} y={y + h / 2 + 8} className={styles.temp} textAnchor="middle">
                      {s.temp.toFixed(1)}°
                    </text>
                  )}
                  {manual?.has(z.id) && (
                    <circle cx={x + 7} cy={y + 7} r={4.2} fill="#ff9830">
                      <title>Control manual</title>
                    </circle>
                  )}
                  {ev && (
                    <g>
                      <circle
                        cx={x + w - 8}
                        cy={y + 8}
                        r={6.5}
                        fill={EVENTS[ev].level === 'crit' ? '#e02f44' : '#ff9830'}
                      />
                      <Glyph name={EVENTS[ev].glyph} x={x + w - 12.5} y={y + 3.5} size={9} color="#fff" />
                    </g>
                  )}
                </g>
              );
            })}
            <text x={W - 2} y={8} className={styles.north} textAnchor="end">
              N ↑
            </text>
          </svg>
        </div>
      ))}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  row: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(1)};
  `,
  floor: css`
    min-width: 0;
  `,
  floorLabel: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    margin-bottom: 2px;
  `,
  svg: css`
    display: block;
  `,
  slab: css`
    fill: ${theme.colors.background.secondary};
    stroke: ${theme.colors.border.medium};
  `,
  zone: css`
    cursor: pointer;
    rect {
      stroke: ${theme.colors.border.medium};
      stroke-width: 0.8;
    }
    &:hover rect {
      stroke: ${theme.colors.text.primary};
      stroke-width: 1.6;
    }
  `,
  sel: css`
    rect {
      stroke: ${theme.colors.primary.main};
      stroke-width: 2.4;
    }
  `,
  off: css`
    cursor: not-allowed;
    opacity: 0.35;
  `,
  id: css`
    font-size: 8.5px;
    font-weight: 600;
    fill: ${theme.colors.text.primary};
    pointer-events: none;
  `,
  temp: css`
    font-size: 8px;
    fill: ${theme.colors.text.primary};
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  `,
  badge: css`
    font-size: 8px;
    pointer-events: none;
  `,
  north: css`
    font-size: 7px;
    fill: ${theme.colors.text.disabled};
  `,
});
