import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { EmsState, History, MeterState } from 'building/telemetry';
import { Sparkline } from './Sparkline';

interface Props {
  meter?: MeterState;
  ems?: EmsState;
  limitKw: number;
  history: History;
}

/** Variables eléctricas del medidor general y desglose de la potencia por uso. */
export const MeterCard: React.FC<Props> = ({ meter, ems, limitKw, history }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  if (!meter) {
    return <div className={styles.muted}>Sin datos del medidor.</div>;
  }
  const limit = ems?.limitKw || limitKw;
  const ratio = Math.min(meter.demand15 / limit, 1.2);
  const over = meter.demand15 > limit;
  const parts = [
    { label: 'HVAC', v: meter.pHvac, c: theme.visualization.getColorByName('blue') },
    { label: 'Iluminación', v: meter.pLights, c: theme.visualization.getColorByName('orange') },
    { label: 'Equipos + TI', v: meter.pPlugs, c: theme.visualization.getColorByName('green') },
    { label: 'Fijas', v: meter.pFixed, c: theme.visualization.getColorByName('yellow') },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const trend = (history.EDIF?.pTotal ?? []).map(([, v]) => v);
  const rows: Array<[string, string]> = [
    ['Potencia activa', `${meter.pTotal.toFixed(1)} kW`],
    ['Potencia reactiva', `${meter.q.toFixed(1)} kvar`],
    ['Potencia aparente', `${meter.s.toFixed(1)} kVA`],
    ['Factor de potencia', meter.pf.toFixed(3)],
    ['Tensión L-L', `${meter.vll.toFixed(1)} V`],
    ['Corriente', `${meter.i.toFixed(1)} A`],
    ['Crítica / no crítica', `${meter.pCritical.toFixed(1)} / ${meter.pNonCritical.toFixed(1)} kW`],
    ['Energía del día', `${meter.eKwh.toFixed(0)} kWh`],
    ['Precio vigente', `${meter.price.toFixed(3)} USD/kWh`],
  ];

  return (
    <div className={styles.card} data-testid="ems-meter">
      <div className={styles.label}>Demanda 15 min vs límite ({limit} kW)</div>
      <div className={styles.bar} role="meter" aria-valuenow={meter.demand15} aria-valuemax={limit}>
        <div
          className={styles.fill}
          style={{
            width: `${(ratio / 1.2) * 100}%`,
            background: over ? theme.visualization.getColorByName('red') : theme.visualization.getColorByName('blue'),
          }}
        />
        <div className={styles.limit} style={{ left: `${(1 / 1.2) * 100}%` }} />
      </div>
      <div className={styles.value}>
        {meter.demand15.toFixed(1)} kW {ems?.drActive ? '· limitador activo' : ''}
      </div>
      {trend.length > 1 && (
        <Sparkline values={trend} color={theme.visualization.getColorByName('blue')} width={260} height={40} />
      )}

      <div className={styles.label}>Desglose por uso</div>
      <div className={styles.stack}>
        {parts.map((p) => (
          <div
            key={p.label}
            style={{ width: `${(p.v / total) * 100}%`, background: p.c }}
            title={`${p.label}: ${p.v.toFixed(1)} kW`}
          />
        ))}
      </div>
      <div className={styles.legend}>
        {parts.map((p) => (
          <span key={p.label}>
            <span className={styles.swatch} style={{ background: p.c }} />
            {p.label} {p.v.toFixed(1)} kW
          </span>
        ))}
      </div>

      {rows.map(([k, v]) => (
        <div key={k} className={styles.row}>
          <span className={styles.muted}>{k}</span>
          <span className={styles.num}>{v}</span>
        </div>
      ))}
      {ems && (
        <div className={styles.muted}>
          EMS: {ems.mode} · etapa DR {ems.drStage} · latencia {ems.latencyMs.toFixed(2)} ms
          {ems.safeMode.length ? ` · modo seguro: ${ems.safeMode.join(', ')}` : ''}
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  label: css`
    margin-top: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  value: css`
    font-size: ${theme.typography.h5.fontSize};
    font-variant-numeric: tabular-nums;
  `,
  bar: css`
    position: relative;
    height: 10px;
    border-radius: 5px;
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
  `,
  fill: css`
    height: 100%;
    border-radius: 5px;
  `,
  limit: css`
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: ${theme.colors.text.primary};
  `,
  stack: css`
    display: flex;
    gap: 2px;
    height: 10px;
    border-radius: 4px;
    overflow: hidden;
  `,
  legend: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5, 1.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  swatch: css`
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 4px;
  `,
  row: css`
    display: flex;
    justify-content: space-between;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  num: css`
    font-variant-numeric: tabular-nums;
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
