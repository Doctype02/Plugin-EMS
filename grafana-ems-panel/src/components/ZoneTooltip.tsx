import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { Zone } from 'building/model';
import { STATUS_LABELS, Status, ZoneState } from 'building/telemetry';
import { StatusBadge } from './StatusBadge';

interface Props {
  zone: Zone;
  state?: ZoneState;
  status: Status;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
}

const W = 230;

export const ZoneTooltip: React.FC<Props> = ({ zone, state, status, x, y, containerWidth, containerHeight }) => {
  const styles = useStyles2(getStyles);
  const left = Math.max(4, x + 16 + W > containerWidth ? x - W - 16 : x + 16);
  const top = Math.min(y + 12, containerHeight - 170);
  const rows: Array<[string, string]> =
    state && Number.isFinite(state.temp)
      ? [
          ['Temperatura', `${state.temp.toFixed(1)} °C (sp ${state.setpoint.toFixed(1)})`],
          ['Ocupantes', `${state.occupants} / ${zone.occupants}`],
          [
            'HVAC',
            state.drForced
              ? 'Bloqueado por DR'
              : state.hvacOn
                ? 'Enfriando'
                : state.hvacEnable
                  ? 'En espera'
                  : 'Apagado',
          ],
          ['Iluminación', `${Math.round(state.lights * 100)} % · ${state.lux} lx`],
          ['Potencia', `${state.pTotal.toFixed(2)} kW`],
        ]
      : [];
  return (
    <div className={styles.tooltip} style={{ left, top, width: W }} data-testid="ems-tooltip">
      <div className={styles.head}>
        <strong>
          {zone.id} · {zone.name}
        </strong>
        <StatusBadge status={status} label={STATUS_LABELS[status]} />
      </div>
      {rows.length === 0 && <div className={styles.muted}>Sin datos</div>}
      {rows.map(([k, v]) => (
        <div key={k} className={styles.row}>
          <span className={styles.muted}>{k}</span>
          <span>{v}</span>
        </div>
      ))}
      {zone.critical && <div className={styles.muted}>Carga crítica: no se deslastra</div>}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  tooltip: css`
    position: absolute;
    z-index: 4;
    pointer-events: none;
    padding: ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    box-shadow: ${theme.shadows.z3};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  head: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: ${theme.spacing(1)};
    margin-bottom: ${theme.spacing(0.5)};
  `,
  row: css`
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    font-variant-numeric: tabular-nums;
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
  `,
});
