import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Icon, useStyles2 } from '@grafana/ui';
import { LevelSummary } from 'building/layout';
import { STATUS_LABELS, Status } from 'building/telemetry';

export type FloorKey = 'all' | 'roof' | number;

interface Props {
  /** Resumen de la azotea y de las plantas, de arriba (azotea) hacia abajo (PB). */
  levels: Array<LevelSummary & { pv?: number }>;
  value: FloorKey;
  onChange: (v: FloorKey) => void;
  statusColors: Record<Status, string>;
  /** Columna estrecha: sólo nombre, color de estado y alarmas. */
  compact?: boolean;
  /** Muestra la generación FV en la fila de la azotea. */
  pv?: boolean;
}

const kw = (v: number) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)} kW`;

/**
 * Selector de planta con forma de corte del edificio: la azotea arriba, la planta baja sobre el terreno.
 * Cada fila muestra el peor estado de la planta (barra de color), la temperatura media, los kW y un
 * indicador de alarmas; el botón "Edificio" abre la vista de conjunto.
 */
export const FloorSelector: React.FC<Props> = ({ levels, value, onChange, statusColors, compact = false, pv }) => {
  const styles = useStyles2(getStyles);
  const total = levels.reduce((a, l) => a + l.crit + l.warn, 0);
  return (
    <nav
      className={cx(styles.root, compact && styles.compact)}
      aria-label="Plantas del edificio"
      data-testid="ems-floor-selector"
    >
      <button
        type="button"
        className={cx(styles.all, value === 'all' && styles.active)}
        onClick={() => onChange('all')}
        aria-pressed={value === 'all'}
        data-testid="ems-floorsel-all"
        title="Vista de conjunto del edificio"
      >
        <Icon name="building" size={compact ? 'md' : 'sm'} />
        {!compact && <span>Edificio</span>}
        {!compact && total > 0 && <span className={styles.allCount}>{total}</span>}
      </button>
      <div className={styles.stack}>
        {levels.map((l) => {
          const key = l.key;
          const active = value === key;
          const roof = key === 'roof';
          const alarms = l.crit + l.warn;
          const color = statusColors[l.status];
          const detail = roof
            ? pv && l.pv !== undefined
              ? `FV ${kw(l.pv)}`
              : `VRF ${kw(l.kw)}`
            : l.temp === undefined
              ? '—'
              : `${l.temp.toFixed(1)}°`;
          return (
            <button
              key={String(key)}
              type="button"
              className={cx(styles.row, roof && styles.roof, active && styles.active)}
              onClick={() => onChange(key)}
              aria-pressed={active}
              data-testid={`ems-floorsel-${roof ? 'roof' : l.short}`}
              data-status={l.status}
              title={`${l.name} · ${STATUS_LABELS[l.status]}${alarms ? ` · ${alarms} alarma${alarms > 1 ? 's' : ''}` : ''}`}
            >
              <span className={styles.bar} style={{ background: color }} />
              <span className={cx(styles.name, roof && styles.roofName)}>
                {roof ? (compact ? 'AZ' : 'Azotea') : l.short}
              </span>
              {!compact && (
                <span className={styles.values}>
                  <span className={cx(styles.temp, roof && styles.roofTemp)}>{detail}</span>
                  <span className={styles.kw}>
                    {roof ? (pv && l.pv !== undefined ? `VRF ${l.kw.toFixed(1)}` : `${l.zones} VRF`) : kw(l.kw)}
                  </span>
                </span>
              )}
              {alarms > 0 && (
                <span
                  className={styles.badge}
                  style={{ background: l.crit ? statusColors.critical : statusColors.warning }}
                  data-testid={`ems-floorsel-alarms-${roof ? 'roof' : l.short}`}
                >
                  {alarms}
                </span>
              )}
            </button>
          );
        })}
        <div className={styles.ground} aria-hidden />
      </div>
    </nav>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  root: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    width: 156px;
    flex-shrink: 0;
    padding: ${theme.spacing(1)};
    border-right: 1px solid ${theme.colors.border.weak};
    background: ${theme.colors.background.primary};
    min-height: 0;
  `,
  compact: css`
    width: 64px;
    padding: ${theme.spacing(0.75)};
  `,
  all: css`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${theme.spacing(0.75)};
    height: 32px;
    flex-shrink: 0;
    border-radius: ${theme.shape.radius.default};
    border: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    cursor: pointer;
    &:hover {
      border-color: ${theme.colors.border.strong};
    }
  `,
  allCount: css`
    margin-left: auto;
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: ${theme.colors.error.main};
    color: ${theme.colors.error.contrastText};
    font-size: 11px;
    line-height: 18px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-height: 0;
    justify-content: flex-end;
  `,
  row: css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex: 1 1 0;
    min-height: 30px;
    max-height: 84px;
    padding: 0 ${theme.spacing(1)} 0 0;
    border-radius: 3px;
    border: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.secondary};
    color: ${theme.colors.text.primary};
    cursor: pointer;
    overflow: hidden;
    text-align: left;
    &:hover {
      border-color: ${theme.colors.border.strong};
      background: ${theme.colors.action.hover};
    }
  `,
  roof: css`
    flex: 0.85 1 0;
    border-style: dashed;
  `,
  active: css`
    border-color: ${theme.colors.primary.border} !important;
    background: ${theme.colors.action.selected} !important;
    box-shadow: inset 0 0 0 1px ${theme.colors.primary.border};
  `,
  roofName: css`
    font-size: 12px;
    min-width: 0;
  `,
  roofTemp: css`
    font-size: 12px;
  `,
  bar: css`
    align-self: stretch;
    width: 6px;
    flex-shrink: 0;
  `,
  name: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
    line-height: 1;
    min-width: 26px;
    flex-shrink: 0;
  `,
  values: css`
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: auto;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
  `,
  temp: css`
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  kw: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  badge: css`
    position: absolute;
    top: 3px;
    right: 3px;
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    color: #fff;
    font-size: 10px;
    font-weight: ${theme.typography.fontWeightBold};
    line-height: 16px;
    text-align: center;
  `,
  ground: css`
    height: 4px;
    flex-shrink: 0;
    margin: 2px -4px 0;
    border-radius: 2px;
    background: repeating-linear-gradient(45deg, ${theme.colors.border.strong} 0 4px, transparent 4px 8px);
  `,
});
