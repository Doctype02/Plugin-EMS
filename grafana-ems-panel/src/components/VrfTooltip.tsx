import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { VrfUnit, ZONE_BY_ID } from 'building/model';
import { Snapshot } from 'building/telemetry';
import { UNIT_MODE_LABEL, unitState } from './Rooftop';

interface Props {
  unit: VrfUnit;
  snapshot: Snapshot;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
}

const W = 250;

/** Ventana emergente de una unidad exterior VRF de la azotea. */
export const VrfTooltip: React.FC<Props> = ({ unit, snapshot, x, y, containerWidth, containerHeight }) => {
  const styles = useStyles2(getStyles);
  const st = unitState(unit, snapshot);
  const left = x + 16 + W > containerWidth ? x - W - 16 : x + 16;
  const top = Math.max(4, Math.min(y + 12, containerHeight - 60 - unit.zones.length * 20 - 150));
  const cop = ZONE_BY_ID[unit.zones[0]]?.cop ?? 2;
  return (
    <div className={styles.tooltip} style={{ left, top, width: W }} data-testid="ems-vrf-tooltip">
      <div className={styles.head}>
        <strong>Unidad exterior {unit.id}</strong>
        <span className={cx(styles.badge, styles[st.mode])}>{UNIT_MODE_LABEL[st.mode]}</span>
      </div>
      <div className={styles.grid}>
        <span className={styles.muted}>Capacidad</span>
        <span>{unit.capacityKw.toFixed(1)} kW térmicos</span>
        <span className={styles.muted}>Potencia eléctrica</span>
        <span>{st.kw.toFixed(2)} kW</span>
        <span className={styles.muted}>COP estacional</span>
        <span>{cop.toFixed(2)}</span>
        <span className={styles.muted}>Carga</span>
        <span className={styles.bar}>
          <i style={{ width: `${Math.round(st.load * 100)}%` }} />
          <b>{Math.round(st.load * 100)} %</b>
        </span>
      </div>
      <div className={styles.section}>Zonas que atiende</div>
      {unit.zones.map((id) => {
        const s = snapshot.zones[id];
        const z = ZONE_BY_ID[id];
        return (
          <div key={id} className={styles.zone}>
            <span className={cx(styles.dot, s?.hvacOn ? styles.on : s?.drForced ? styles.drDot : styles.off)} />
            <span className={styles.zname}>
              {id} · {z?.name}
            </span>
            <span>{s ? `${s.temp.toFixed(1)} °C` : '—'}</span>
          </div>
        );
      })}
      {st.mode === 'falla' && <div className={styles.alert}>Sin enfriamiento: las zonas se calientan libremente.</div>}
      {st.mode === 'sin_energia' && (
        <div className={styles.alert}>Corte de energía: la unidad no tiene alimentación.</div>
      )}
      {st.mode === 'dr' && <div className={styles.note}>El limitador de demanda tiene compresores en espera.</div>}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  tooltip: css`
    position: absolute;
    z-index: 5;
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
    margin-bottom: ${theme.spacing(0.75)};
  `,
  badge: css`
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.pill};
    font-size: 11px;
    border: 1px solid;
  `,
  enfriando: css`
    color: ${theme.colors.info.text};
    border-color: ${theme.colors.info.border};
  `,
  dr: css`
    color: ${theme.colors.warning.text};
    border-color: ${theme.colors.warning.border};
  `,
  espera: css`
    color: ${theme.colors.text.secondary};
    border-color: ${theme.colors.border.medium};
  `,
  falla: css`
    color: ${theme.colors.error.contrastText};
    background: ${theme.colors.error.main};
    border-color: ${theme.colors.error.border};
  `,
  sin_energia: css`
    color: ${theme.colors.text.secondary};
    border-color: ${theme.colors.border.strong};
  `,
  grid: css`
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px ${theme.spacing(1)};
    font-variant-numeric: tabular-nums;
    span:nth-child(2n) {
      text-align: right;
    }
  `,
  bar: css`
    position: relative;
    height: 14px;
    border-radius: 3px;
    background: ${theme.colors.border.weak};
    overflow: hidden;
    i {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: ${colorManipulator.alpha(theme.colors.info.main, 0.6)};
    }
    b {
      position: relative;
      font-weight: 500;
      font-size: 10px;
      padding-right: 3px;
    }
  `,
  section: css`
    margin: ${theme.spacing(0.75, 0, 0.25)};
    color: ${theme.colors.text.secondary};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  zone: css`
    display: grid;
    grid-template-columns: 10px 1fr auto;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-variant-numeric: tabular-nums;
  `,
  zname: css`
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  on: css`
    background: #3d9df3;
  `,
  drDot: css`
    background: #ff9830;
  `,
  off: css`
    background: ${theme.colors.text.disabled};
  `,
  alert: css`
    margin-top: ${theme.spacing(0.75)};
    color: ${theme.colors.error.text};
  `,
  note: css`
    margin-top: ${theme.spacing(0.75)};
    color: ${theme.colors.warning.text};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
  `,
});
