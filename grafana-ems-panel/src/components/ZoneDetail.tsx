import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { IconButton, useStyles2, useTheme2 } from '@grafana/ui';
import { FLOORS, ZONE_TYPE_LABELS, Zone } from 'building/model';
import { EmsAlarm, History, STATUS_LABELS, Status, ZoneState } from 'building/telemetry';
import { Sparkline } from './Sparkline';
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
  key?: string;
}

export const ZoneDetail: React.FC<Props> = ({ zone, state, status, history, alarms, onClose, control }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const series = history[zone.id] ?? {};
  const s = state && Number.isFinite(state.temp) ? state : undefined;
  const metrics: Metric[] = s
    ? [
        { label: 'Temperatura', value: `${s.temp.toFixed(1)} °C`, key: 'temp' },
        { label: 'Setpoint', value: `${s.setpoint.toFixed(1)} °C` },
        { label: 'Ocupantes', value: `${s.occupants} / ${zone.occupants}`, key: 'occupants' },
        { label: 'Potencia total', value: `${s.pTotal.toFixed(2)} kW`, key: 'pTotal' },
        {
          label: 'HVAC',
          value: `${s.pHvac.toFixed(2)} kW · ${s.drForced ? 'bloqueado (DR)' : s.hvacOn ? 'enfriando' : s.hvacEnable ? 'en espera' : 'apagado'}`,
          key: 'pHvac',
        },
        {
          label: 'Iluminación',
          value: `${Math.round(s.lights * 100)} % · ${s.pLights.toFixed(2)} kW · ${s.lux} lx`,
          key: 'lights',
        },
        { label: 'Enchufes / equipos', value: `${Math.round(s.plugs * 100)} % · ${s.pPlugs.toFixed(2)} kW` },
      ]
    : [];
  const own = alarms.filter((a) => a.zone === zone.id);
  const color = theme.visualization.getColorByName('blue');

  return (
    <div className={styles.detail} data-testid="ems-detail">
      <div className={styles.head}>
        <div>
          <div className={styles.title}>
            {zone.id} · {zone.name}
          </div>
          <div className={styles.sub}>
            {FLOORS[zone.floor].name} · {ZONE_TYPE_LABELS[zone.type]} · {zone.area} m² ·{' '}
            {zone.critical ? 'carga crítica' : 'carga gestionable'}
          </div>
        </div>
        <IconButton name="times" tooltip="Cerrar" onClick={onClose} />
      </div>
      <StatusBadge status={status} label={STATUS_LABELS[status]} />
      {!s && <div className={styles.sub}>Sin datos para esta zona.</div>}
      {metrics.map((m) => {
        const values = m.key ? (series[m.key] ?? []).map(([, v]) => v) : [];
        return (
          <div key={m.label} className={styles.metric}>
            <div>
              <div className={styles.label}>{m.label}</div>
              <div className={styles.value}>{m.value}</div>
            </div>
            {values.length > 1 && <Sparkline values={values} color={color} width={96} height={28} />}
          </div>
        );
      })}
      {control && (
        <>
          <div className={styles.section}>Control</div>
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
    gap: ${theme.spacing(1)};
  `,
  title: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  sub: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  metric: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
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
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
