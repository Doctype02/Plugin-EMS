import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Icon, IconName, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { Status } from 'building/telemetry';
import { VIEW_LABELS, ViewMode } from 'building/views';
import { useStatusColors } from './useStatusColors';

export interface Kpi {
  label: string;
  value: string;
  icon: IconName;
  status: Status;
}

interface Props {
  title: string;
  subtitle: string;
  demoMode: boolean;
  kpis: Kpi[];
  showKpis: boolean;
  /** Pone los indicadores en su propia fila (paneles angostos). */
  compact: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

const VIEW_OPTIONS = (Object.keys(VIEW_LABELS) as ViewMode[]).map((value) => ({ value, label: VIEW_LABELS[value] }));

export const Header: React.FC<Props> = ({
  title,
  subtitle,
  demoMode,
  kpis,
  showKpis,
  compact,
  viewMode,
  onViewModeChange,
}) => {
  const styles = useStyles2(getStyles);
  const colors = useStatusColors();

  return (
    <div className={styles.header}>
      <div className={styles.titleBlock}>
        <div className={styles.title}>
          <Icon name="building" />
          {title}
        </div>
        <div className={styles.subtitle}>
          {subtitle}
          {demoMode && <span className={styles.demo}>Simulado</span>}
        </div>
      </div>

      {showKpis && (
        <div className={cx(styles.kpis, compact && styles.kpisCompact)}>
          {kpis.map((kpi) => {
            const accent = kpi.status === 'ok' || kpi.status === 'offline' ? undefined : colors[kpi.status];
            return (
              <div
                key={kpi.label}
                className={cx(styles.kpi)}
                style={
                  accent
                    ? {
                        borderColor: colorManipulator.alpha(accent, 0.6),
                        background: colorManipulator.alpha(accent, 0.1),
                      }
                    : undefined
                }
                data-testid={`ems-kpi-${kpi.icon}`}
              >
                <Icon name={kpi.icon} className={styles.kpiIcon} style={accent ? { color: accent } : undefined} />
                <div className={styles.kpiText}>
                  <div className={styles.kpiLabel}>{kpi.label}</div>
                  <div className={styles.kpiValue} style={accent ? { color: accent } : undefined}>
                    {kpi.value}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.viewMode}>
        <RadioButtonGroup size="sm" options={VIEW_OPTIONS} value={viewMode} onChange={onViewModeChange} />
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  header: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: ${theme.spacing(1, 2)};
    padding-bottom: ${theme.spacing(1)};
  `,
  titleBlock: css`
    min-width: 0;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
  `,
  subtitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  demo: css`
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.pill};
    border: 1px solid ${theme.colors.warning.border};
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  kpis: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${theme.spacing(1)};
    flex: 1;
    max-width: 760px;
  `,
  kpisCompact: css`
    order: 3;
    flex-basis: 100%;
    max-width: none;
  `,
  kpi: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    min-width: 0;
    padding: ${theme.spacing(0.5, 1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  kpiText: css`
    min-width: 0;
  `,
  kpiIcon: css`
    flex-shrink: 0;
    color: ${theme.colors.text.secondary};
  `,
  kpiLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  kpiValue: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    white-space: nowrap;
  `,
  viewMode: css`
    margin-left: auto;
  `,
});
