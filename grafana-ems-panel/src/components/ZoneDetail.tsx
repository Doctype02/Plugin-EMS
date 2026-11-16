import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { IconButton, useStyles2, useTheme2 } from '@grafana/ui';
import { FLOOR_BY_LEVEL, ZONE_TYPE_LABELS, Zone, systemLabel } from 'building/model';
import { EmsAlarm, History, STATUS_LABELS, Status, ZoneState } from 'building/telemetry';
import { Sparkline } from './Sparkline';
import { useStatusColors } from './useStatusColors';
import { StatusBadge } from './StatusBadge';

interface Props {
  zone: Zone;
  state?: ZoneState;
  status: Status;
  history: History;
  alarms: EmsAlarm[];
  onClose: () => void;
  /** Controles manuales de la zona. */
  control?: React.ReactNode;
}

interface Metric {
  label: string;
  value: string;
  sub?: string;
  key?: string;
  accent?: string;
}

export const ZoneDetail: React.FC<Props> = ({ zone, state, status, history, alarms, onClose, control }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const series = history[zone.id] ?? {};
  const s = state && Number.isFinite(state.temp) ? state : undefined;
  const statusColors = useStatusColors();
  const hvacState = s
    ? s.drForced
      ? 'bloqueado (DR)'
      : s.hvacOn
        ? 'enfriando'
        : s.hvacEnable
          ? 'en espera'
          : 'apagado'
    : '';
  const dT = s ? s.temp - s.setpoint : 0;
  const tiles: Metric[] = s
    ? [
        {
          label: 'Temperatura',
          value: `${s.temp.toFixed(1)} °C`,
          sub: `setpoint ${s.setpoint.toFixed(1)} °C · ${dT >= 0 ? '+' : ''}${dT.toFixed(1)}`,
          key: 'temp',
          accent: status === 'warning' || status === 'critical' ? statusColors[status] : undefined,
        },
        { label: 'Potencia', value: `${s.pTotal.toFixed(2)} kW`, sub: `HVAC ${s.pHvac.toFixed(2)} kW`, key: 'pTotal' },
        {
          label: 'Ocupantes',
          value: zone.occupants ? `${s.occupants} / ${zone.occupants}` : '—',
          sub: zone.occupants ? `${Math.round((s.occupants / zone.occupants) * 100)} % del aforo` : 'sin puestos',
          key: 'occupants',
        },
        {
          label: 'HVAC',
          value: hvacState,
          sub: s.override ? 'control manual' : 'automático (EMS)',
          key: 'pHvac',
          accent: s.drForced ? statusColors.warning : undefined,
        },
      ]
    : [];
  const rows: Metric[] = s
    ? [
        { label: 'Iluminación', value: `${Math.round(s.lights * 100)} % · ${s.pLights.toFixed(2)} kW · ${s.lux} lx` },
        { label: 'Enchufes / equipos', value: `${Math.round(s.plugs * 100)} % · ${s.pPlugs.toFixed(2)} kW` },
      ]
    : [];
  const own = alarms.filter((a) => a.zone === zone.id);
  const color = theme.visualization.getColorByName('blue');

  return (
    <div className={styles.detail} data-testid="ems-detail">
      <div className={styles.head} style={{ borderLeftColor: statusColors[status] }}>
        <div className={styles.headText}>
          <div className={styles.title}>
            <span className={styles.zid}>{zone.id}</span> {zone.name}
          </div>
          <div className={styles.sub}>
            {FLOOR_BY_LEVEL[zone.floor]?.name} · {ZONE_TYPE_LABELS[zone.type]} · {zone.area} m²
          </div>
          <div className={styles.sub} data-testid="ems-detail-system">
            Climatización: {systemLabel(zone)}
          </div>
          <div className={styles.badges}>
            <StatusBadge status={status} label={STATUS_LABELS[status]} />
            <span className={zone.critical ? styles.critTag : styles.tag}>
              {zone.critical ? 'carga crítica' : 'carga gestionable'}
            </span>
          </div>
        </div>
        <IconButton name="times" tooltip="Cerrar detalle" onClick={onClose} />
      </div>
      {!s && <div className={styles.sub}>Sin datos para esta zona.</div>}
      {tiles.length > 0 && (
        <div className={styles.tiles}>
          {tiles.map((m) => {
            const values = m.key ? (series[m.key] ?? []).map(([, v]) => v) : [];
            return (
              <div key={m.label} className={styles.tile}>
                <div className={styles.label}>{m.label}</div>
                <div className={styles.tileValue} style={m.accent ? { color: m.accent } : undefined}>
                  {m.value}
                </div>
                {m.sub && <div className={styles.sub}>{m.sub}</div>}
                {values.length > 1 && (
                  <div className={styles.spark}>
                    <Sparkline values={values} color={m.accent ?? color} width={120} height={22} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {rows.map((m) => (
        <div key={m.label} className={styles.metric}>
          <span className={styles.label}>{m.label}</span>
          <span className={styles.value}>{m.value}</span>
        </div>
      ))}
      {control && (
        <>
          <div className={styles.section}>Control manual</div>
          {control}
        </>
      )}
      <div className={styles.section}>Diseño</div>
      <div className={styles.sub}>
        Iluminación {zone.lpd} W/m² · equipos {zone.epd} W/m²{zone.itKw ? ` · TI ${zone.itKw} kW` : ''} · HVAC{' '}
        {zone.hvacKw} kWt (COP {zone.cop})
      </div>
      <div className={styles.section}>Alarmas de la zona</div>
      {own.length === 0 ? (
        <div className={styles.sub}>Ninguna</div>
      ) : (
        own.map((a) => (
          <div key={`${a.code}${a.ts}`} className={styles.sub}>
            <strong>{a.code}</strong> — {a.message}
          </div>
        ))
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  detail: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  head: css`
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: ${theme.spacing(1)};
    padding-left: ${theme.spacing(1.25)};
    border-left: 4px solid;
  `,
  headText: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    line-height: 1.2;
  `,
  zid: css`
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  badges: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    flex-wrap: wrap;
    margin-top: ${theme.spacing(0.5)};
  `,
  tag: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  critTag: css`
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.pill};
    border: 1px solid ${theme.colors.error.border};
    color: ${theme.colors.error.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  tiles: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: ${theme.spacing(0.75)};
  `,
  tile: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: ${theme.spacing(0.75, 1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  tileValue: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  spark: css`
    margin-top: 2px;
    overflow: hidden;
  `,
  sub: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  metric: css`
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: ${theme.typography.bodySmall.fontSize};
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.5, 0)};
    border-bottom: 1px solid ${theme.colors.border.weak};
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  value: css`
    font-variant-numeric: tabular-nums;
  `,
  section: css`
    margin-top: ${theme.spacing(1)};
    padding-bottom: ${theme.spacing(0.5)};
    border-bottom: 1px solid ${theme.colors.border.weak};
    font-size: ${theme.typography.h6.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
