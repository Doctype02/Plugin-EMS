import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { STATUS_LABELS, Status } from 'building/telemetry';
import { LegendSpec } from 'building/views';
import { useStatusColors } from './useStatusColors';
import { StatusMark } from './IsoPrimitives';

interface Props {
  spec: LegendSpec;
  counts: Record<Status, number>;
  statusFilter?: Status;
  onStatusFilter: (s?: Status) => void;
  /** Escena estrecha: sin título y con los textos más cortos (una sola fila). */
  compact?: boolean;
  /** Dentro de la barra superior (sin posición absoluta). */
  inline?: boolean;
}

const ORDER: Status[] = ['ok', 'warning', 'critical', 'offline'];

export const Legend: React.FC<Props> = ({
  spec,
  counts,
  statusFilter,
  onStatusFilter,
  compact = false,
  inline = false,
}) => {
  const styles = useStyles2(getStyles);
  const colors = useStatusColors();

  return (
    <div className={cx(styles.legend, inline && styles.inline)} data-testid="ems-legend">
      {!compact && <div className={styles.title}>{spec.title}</div>}
      {spec.kind === 'status' && (
        <div className={styles.row}>
          {ORDER.map((s) => (
            <button
              key={s}
              type="button"
              className={cx(styles.item, styles.button, statusFilter === s && styles.active)}
              onClick={() => onStatusFilter(statusFilter === s ? undefined : s)}
              data-testid={`ems-count-${s}`}
              title={STATUS_LABELS[s]}
            >
              <svg width={10} height={10} viewBox="-5 -5 10 10" aria-hidden className={styles.mark}>
                <StatusMark status={s} color={colors[s]} size={9} />
              </svg>
              {compact ? '' : `${STATUS_LABELS[s]} `}
              <strong>{counts[s]}</strong>
            </button>
          ))}
        </div>
      )}
      {spec.kind === 'gradient' && spec.stops && (
        <div>
          <div className={styles.gradient} style={{ background: `linear-gradient(90deg, ${spec.stops.join(',')})` }} />
          <div className={styles.scale}>
            <span>{spec.min}</span>
            {spec.mid && <span>{spec.mid}</span>}
            <span>{spec.max}</span>
          </div>
        </div>
      )}
      {spec.kind === 'categories' && (
        <div className={styles.row}>
          {spec.categories?.map((c) => (
            <span key={c.label} className={styles.item}>
              <span className={styles.swatch} style={{ background: c.color }} />
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  legend: css`
    position: absolute;
    left: ${theme.spacing(1)};
    bottom: ${theme.spacing(1)};
    max-width: calc(100% - ${theme.spacing(2)});
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    min-height: 32px;
    padding: ${theme.spacing(0.25, 1)};
    z-index: 1;
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    box-shadow: ${theme.shadows.z1};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  inline: css`
    position: static;
    max-width: none;
  `,
  title: css`
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.25, 1)};
  `,
  item: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    color: ${theme.colors.text.primary};
  `,
  button: css`
    background: none;
    border: 1px solid transparent;
    border-radius: ${theme.shape.radius.default};
    padding: 0 ${theme.spacing(0.5)};
    cursor: pointer;
  `,
  active: css`
    border-color: ${theme.colors.border.strong};
    background: ${theme.colors.action.selected};
  `,
  mark: css`
    flex-shrink: 0;
    overflow: visible;
  `,
  swatch: css`
    width: 10px;
    height: 10px;
    border-radius: 2px;
  `,
  gradient: css`
    width: 180px;
    max-width: 100%;
    height: 8px;
    border-radius: 4px;
  `,
  scale: css`
    font-size: 11px;
    line-height: 1.2;
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
});
