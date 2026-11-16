import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Icon, useStyles2, useTheme2 } from '@grafana/ui';
import { EmsState, MeterState } from 'building/telemetry';
import { Glyph } from './Glyph';
import { DEMAND_WARN, DemandLevel, demandLevel, gaugeScale } from 'building/demand';

export function useDemandColors(): Record<DemandLevel, string> {
  const theme = useTheme2();
  return {
    ok: theme.colors.primary.main,
    warning: theme.colors.warning.main,
    critical: theme.colors.error.main,
  };
}

interface BarProps {
  value: number;
  limit: number;
  /** Segunda marca (p. ej. la demanda de 15 min). */
  secondary?: number;
  height?: number;
  showLimitLabel?: boolean;
}

/** Barra horizontal de potencia frente al límite, con la franja de alerta y la marca del límite. */
export const LimitBar: React.FC<BarProps> = ({ value, limit, secondary, height = 12, showLimitLabel = true }) => {
  const styles = useStyles2(getStyles);
  const colors = useDemandColors();
  const theme = useTheme2();
  const scale = gaugeScale(Math.max(value, secondary ?? 0), limit);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;
  const level = demandLevel(value, limit);
  return (
    <div className={styles.barWrap} style={{ paddingTop: showLimitLabel ? 16 : 0 }}>
      <div
        className={styles.track}
        style={{ height }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.round(value * 10) / 10}
        aria-label={`Potencia ${value.toFixed(1)} kW de ${limit} kW`}
      >
        <div
          className={styles.warnBand}
          style={{
            left: pct(limit * DEMAND_WARN),
            width: `calc(${pct(limit)} - ${pct(limit * DEMAND_WARN)})`,
            background: colorManipulator.alpha(theme.colors.warning.main, 0.25),
          }}
        />
        <div className={styles.fill} style={{ width: pct(value), background: colors[level] }} />
        {secondary !== undefined && (
          <div
            className={styles.secondary}
            style={{ left: pct(secondary) }}
            title={`15 min: ${secondary.toFixed(1)} kW`}
          />
        )}
      </div>
      <div className={styles.limit} style={{ left: pct(limit), top: showLimitLabel ? 12 : -3 }}>
        {showLimitLabel && <span className={styles.limitLabel}>Límite {limit} kW</span>}
      </div>
    </div>
  );
};

interface Props {
  meter?: MeterState;
  ems?: EmsState;
  limit: number;
  /** Mostrar las fichas de FV, red y DR. */
  pv: boolean;
}

/** Medidor principal: potencia actual frente al límite de demanda, FV, red y estado de la respuesta a la demanda. */
export const DemandGauge: React.FC<Props> = ({ meter, ems, limit, pv }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const colors = useDemandColors();
  if (!meter) {
    return <div className={styles.muted}>Sin datos del medidor.</div>;
  }
  // con FV el limitador actúa sobre la importación neta
  const grid = meter.pGrid ?? (meter.pPv !== undefined ? meter.pTotal - meter.pPv : meter.pTotal);
  const controlled = meter.pPv !== undefined ? Math.max(grid, 0) : meter.pTotal;
  const level = demandLevel(Math.max(controlled, meter.demand15), limit);
  const pctOfLimit = limit > 0 ? (controlled / limit) * 100 : 0;
  const margin = limit - meter.demand15;
  const dr = !!ems?.drActive;
  const green = theme.visualization.getColorByName('green');
  return (
    <div className={styles.gauge} data-testid="ems-demand-gauge" data-level={level}>
      <div className={styles.top}>
        <div>
          <div className={styles.caption}>{meter.pPv !== undefined ? 'Importación de red' : 'Potencia actual'}</div>
          <div className={styles.big} style={{ color: level === 'ok' ? undefined : colors[level] }}>
            {controlled.toFixed(1)}
            <small> kW</small>
          </div>
        </div>
        <div className={styles.right}>
          <div className={styles.pct} style={{ color: level === 'ok' ? undefined : colors[level] }}>
            {pctOfLimit.toFixed(0)} %
          </div>
          <div className={styles.caption}>del límite</div>
        </div>
      </div>
      <LimitBar value={controlled} limit={limit} secondary={meter.demand15} />
      <div className={styles.sub}>
        <span>
          Demanda 15 min <b>{meter.demand15.toFixed(1)} kW</b>
        </span>
        <span className={cx(margin < 0 && styles.over)}>
          {margin >= 0 ? `margen ${margin.toFixed(0)} kW` : `excede ${(-margin).toFixed(0)} kW`}
        </span>
      </div>
      <div className={styles.chips}>
        <span className={cx(styles.chip, dr && styles.chipWarn)} data-testid="ems-dr-state">
          <Icon name="tachometer-fast" size="sm" />
          DR {dr ? `activo${ems?.drStage ? ` · etapa ${ems.drStage}` : ''}` : 'en espera'}
        </span>
        {pv && meter.pPv !== undefined && (
          <span className={styles.chip}>
            <Glyph name="sun" size={14} color={green} />
            FV <b>{meter.pPv.toFixed(1)} kW</b>
          </span>
        )}
        {pv && meter.pPv !== undefined && (
          <span className={styles.chip}>
            <Icon name="plug" size="sm" />
            {grid < 0 ? 'Exporta' : 'Red'} <b>{Math.abs(grid).toFixed(1)} kW</b>
          </span>
        )}
        {meter.pPv !== undefined && (
          <span className={styles.chip}>
            <Icon name="building" size="sm" />
            Consumo <b>{meter.pTotal.toFixed(1)} kW</b>
          </span>
        )}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  gauge: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  top: css`
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: ${theme.spacing(1)};
  `,
  caption: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  big: css`
    font-size: 28px;
    line-height: 1.1;
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    small {
      font-size: ${theme.typography.body.fontSize};
      color: ${theme.colors.text.secondary};
      font-weight: ${theme.typography.fontWeightRegular};
    }
  `,
  right: css`
    text-align: right;
  `,
  pct: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  `,
  sub: css`
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    b {
      color: ${theme.colors.text.primary};
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
  over: css`
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  chips: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)};
  `,
  chip: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.25, 1)};
    border-radius: ${theme.shape.radius.pill};
    border: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.primary};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    b {
      color: ${theme.colors.text.primary};
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
  chipWarn: css`
    border-color: ${theme.colors.warning.border};
    color: ${theme.colors.warning.text};
    background: ${colorManipulator.alpha(theme.colors.warning.main, 0.12)};
  `,
  barWrap: css`
    position: relative;
  `,
  track: css`
    position: relative;
    overflow: hidden;
    border-radius: ${theme.shape.radius.pill};
    background: ${theme.colors.background.canvas};
    border: 1px solid ${theme.colors.border.medium};
  `,
  warnBand: css`
    position: absolute;
    top: 0;
    bottom: 0;
  `,
  fill: css`
    position: relative;
    height: 100%;
    border-radius: ${theme.shape.radius.pill};
    transition: width 0.4s ease;
    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  secondary: css`
    position: absolute;
    top: 2px;
    bottom: 2px;
    width: 3px;
    margin-left: -1.5px;
    border-radius: 2px;
    background: ${theme.colors.text.primary};
    opacity: 0.55;
  `,
  limit: css`
    position: absolute;
    top: 12px;
    bottom: -4px;
    width: 2px;
    margin-left: -1px;
    background: ${theme.colors.text.primary};
  `,
  limitLabel: css`
    position: absolute;
    top: -14px;
    right: -2px;
    white-space: nowrap;
    font-size: 11px;
    line-height: 1;
    color: ${theme.colors.text.secondary};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
