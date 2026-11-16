import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Icon, IconName, RadioButtonGroup, useStyles2, useTheme2 } from '@grafana/ui';
import { Status } from 'building/telemetry';
import { VIEW_LABELS, ViewMode } from 'building/views';
import { useStatusColors } from './useStatusColors';
import { Glyph, GlyphName } from './Glyph';

export interface Kpi {
  label: string;
  value: string;
  icon: IconName;
  /** Ícono propio del panel en lugar del de Grafana (p. ej. sol para FV). */
  glyph?: GlyphName;
  status: Status;
  /** Fracción de un máximo (p. ej. potencia / límite): dibuja una barra bajo el valor. */
  ratio?: number;
  /** Texto secundario junto al valor (p. ej. «de 170 kW»). */
  hint?: string;
}

interface Props {
  title: string;
  subtitle: string;
  demoMode: boolean;
  kpis: Kpi[];
  showKpis: boolean;
  /** Pone los indicadores en su propia fila (paneles angostos). */
  compact: boolean;
  /** Panel bajo: indicadores en una línea y sin subtítulo. */
  dense?: boolean;
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
  dense,
  viewMode,
  onViewModeChange,
}) => {
  const styles = useStyles2(getStyles);
  const colors = useStatusColors();
  const theme = useTheme2();

  return (
    <div className={cx(styles.header, dense && styles.headerDense)}>
      <div className={styles.titleBlock}>
        <div className={styles.title} title={title}>
          <Icon name="building" />
          <span className={styles.titleText}>{title}</span>
          {dense && demoMode && <span className={styles.demo}>Simulado</span>}
        </div>
        {!dense && (
          <div className={styles.subtitle}>
            {subtitle}
            {demoMode && <span className={styles.demo}>Simulado</span>}
          </div>
        )}
      </div>

      {showKpis && (
        <div className={cx(styles.kpis, compact && styles.kpisCompact, dense && styles.kpisDense)}>
          {kpis.map((kpi) => {
            const accent = kpi.status === 'ok' || kpi.status === 'offline' ? undefined : colors[kpi.status];
            return (
              <div
                key={kpi.label}
                className={cx(styles.kpi, dense && styles.kpiDense)}
                style={
                  accent
                    ? {
                        borderColor: colorManipulator.alpha(accent, 0.6),
                        background: colorManipulator.alpha(accent, 0.1),
                      }
                    : undefined
                }
                data-testid={`ems-kpi-${kpi.glyph ?? kpi.icon}`}
              >
                {kpi.glyph ? (
                  <Glyph name={kpi.glyph} size={16} color={accent} className={styles.kpiIcon} />
                ) : (
                  <Icon name={kpi.icon} className={styles.kpiIcon} style={accent ? { color: accent } : undefined} />
                )}
                <div className={styles.kpiText}>
                  <div className={styles.kpiLabelRow}>
                    <span className={styles.kpiLabel}>{kpi.label}</span>
                    {kpi.hint && <span className={styles.kpiHint}>{kpi.hint}</span>}
                  </div>
                  <div className={styles.kpiValue} style={accent ? { color: accent } : undefined}>
                    {kpi.value}
                  </div>
                  {kpi.ratio !== undefined && (
                    <div className={styles.kpiBar} aria-hidden>
                      <div
                        style={{
                          width: `${Math.min(1, Math.max(0, kpi.ratio)) * 100}%`,
                          background: accent ?? theme.colors.primary.main,
                        }}
                      />
                    </div>
                  )}
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
  headerDense: css`
    gap: ${theme.spacing(0.75, 1.5)};
    padding-bottom: ${theme.spacing(0.75)};
  `,
  titleBlock: css`
    min-width: 0;
    flex: 0 1 auto;
  `,
  titleText: css`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
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
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: ${theme.spacing(1)};
    flex: 1;
    max-width: 860px;
  `,
  kpisDense: css`
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: ${theme.spacing(0.5)};
  `,
  kpiDense: css`
    padding: ${theme.spacing(0.25, 1)};
    gap: ${theme.spacing(0.75)};
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
    flex: 1;
  `,
  kpiIcon: css`
    flex-shrink: 0;
    color: ${theme.colors.text.secondary};
  `,
  kpiLabel: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    min-width: 0;
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
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  kpiLabelRow: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(0.5)};
    min-width: 0;
  `,
  kpiHint: css`
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: ${theme.typography.fontWeightRegular};
    color: ${theme.colors.text.secondary};
  `,
  kpiBar: css`
    height: 4px;
    margin-top: 3px;
    border-radius: 2px;
    overflow: hidden;
    background: ${theme.colors.border.weak};
    div {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }
  `,
  viewMode: css`
    margin-left: auto;
  `,
});
