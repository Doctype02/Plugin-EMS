/**
 * Las tres líneas del servicio trifásico (L1, L2, L3): corriente, tensión línea-neutro y potencia de cada una,
 * desbalance de corriente y la corriente por línea a lo largo del día. La climatización y el ascensor cargan
 * las tres por igual; la iluminación y los tomacorrientes son monofásicos y el UPS de los servidores cuelga de
 * L1, por eso las líneas no van idénticas.
 */
import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { MeterState } from 'building/telemetry';
import { MiniChart } from './MiniChart';

/** Un color fijo por línea (validado para ambos temas y para daltonismo); mismo color en los dashboards. */
export const LINE_COLORS = ['#3987e5', '#d95926', '#199e70'] as const;
export const LINE_NAMES = ['L1', 'L2', 'L3'] as const;

export type LineCurves = [Array<[number, number]>, Array<[number, number]>, Array<[number, number]>];

/** Corriente, tensión y potencia de las tres líneas, si el medidor las trae. */
export function meterLines(m?: MeterState): Array<{ name: string; color: string; i: number; v: number; p: number }> {
  if (!m || m.iL1 === undefined) {
    return [];
  }
  const i = [m.iL1, m.iL2 ?? 0, m.iL3 ?? 0];
  const v = [m.vL1 ?? 0, m.vL2 ?? 0, m.vL3 ?? 0];
  const p = [m.pL1 ?? 0, m.pL2 ?? 0, m.pL3 ?? 0];
  return LINE_NAMES.map((name, k) => ({ name, color: LINE_COLORS[k], i: i[k], v: v[k], p: p[k] }));
}

interface Props {
  meter?: MeterState;
  /** Corriente de cada línea a lo largo del día (t, A). */
  curves?: LineCurves;
  now: number;
  xDomain: [number, number];
  xTicks: number[];
  xLabel: (t: number) => string;
}

export const PhaseLines: React.FC<Props> = ({ meter, curves, now, xDomain, xTicks, xLabel }) => {
  const styles = useStyles2(getStyles);
  const lines = meterLines(meter);
  if (!lines.length) {
    return null;
  }
  const past = (curves ?? [[], [], []]).map((c) => c.filter(([t]) => t <= now));
  const top = Math.max(...lines.map((l) => l.i), ...past.flatMap((c) => c.map(([, a]) => a)), 1);
  return (
    <div className={styles.box} data-testid="ems-phase-lines">
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Línea</th>
            <th />
            <th>A</th>
            <th>V</th>
            <th>kW</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.name} data-testid={`ems-phase-${l.name}`}>
              <td className={styles.name}>
                <i style={{ background: l.color }} />
                {l.name}
              </td>
              <td className={styles.barCell}>
                <div className={styles.track} title={`${l.name}: ${l.i.toFixed(0)} A`}>
                  <div style={{ width: `${Math.min(100, (100 * l.i) / top)}%`, background: l.color }} />
                </div>
              </td>
              <td>{l.i.toFixed(0)}</td>
              <td>{l.v.toFixed(0)}</td>
              <td>{l.p.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {past[0].length > 1 && (
        <MiniChart
          height={120}
          step
          series={LINE_NAMES.map((name, k) => ({ name, color: LINE_COLORS[k], points: past[k] }))}
          marker={{ x: now, label: 'ahora' }}
          xDomain={xDomain}
          xTicks={xTicks}
          xLabel={xLabel}
          yUnit="A"
        />
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    th {
      text-align: right;
      font-weight: ${theme.typography.fontWeightRegular};
      font-size: 11px;
      color: ${theme.colors.text.secondary};
      padding: 0 0 2px 8px;
    }
    th:first-child {
      text-align: left;
      padding-left: 0;
    }
    td {
      text-align: right;
      padding: 3px 0 3px 8px;
      white-space: nowrap;
    }
  `,
  name: css`
    text-align: left !important;
    padding-left: 0 !important;
    font-weight: ${theme.typography.fontWeightMedium};
    i {
      display: inline-block;
      width: 10px;
      height: 3px;
      border-radius: 2px;
      vertical-align: middle;
      margin-right: 6px;
    }
  `,
  barCell: css`
    width: 100%;
  `,
  track: css`
    height: 8px;
    border-radius: 4px;
    background: ${theme.colors.border.weak};
    overflow: hidden;
    div {
      height: 100%;
      border-radius: 0 4px 4px 0;
    }
  `,
});
