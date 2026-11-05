import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Button, Icon, useStyles2 } from '@grafana/ui';
import { ZONE_BY_ID } from 'building/model';
import { AlarmLevel, EmsAlarm, Status } from 'building/telemetry';
import { StatusBadge } from './StatusBadge';

interface Props {
  alarms: EmsAlarm[];
  acknowledged: Set<string>;
  onSelectZone: (zoneId: string) => void;
  onAcknowledge: (key: string) => void;
  onAcknowledgeAll: () => void;
}

export const alarmKey = (a: EmsAlarm) => `${a.zone}:${a.code}:${a.ts}`;

const LEVEL_STATUS: Record<AlarmLevel, Status> = { crit: 'critical', warn: 'warning', info: 'ok' };
const LEVEL_LABEL: Record<AlarmLevel, string> = { crit: 'Crítica', warn: 'Alerta', info: 'Info' };

export const AlarmList: React.FC<Props> = ({ alarms, acknowledged, onSelectZone, onAcknowledge, onAcknowledgeAll }) => {
  const styles = useStyles2(getStyles);
  const pending = alarms.filter((a) => a.level !== 'info' && !acknowledged.has(alarmKey(a)));

  if (alarms.length === 0) {
    return (
      <div className={styles.empty} data-testid="ems-alarms-empty">
        <Icon name="check-circle" /> Sin alarmas activas
      </div>
    );
  }
  return (
    <div className={styles.list} data-testid="ems-alarms">
      {pending.length > 1 && (
        <Button size="sm" variant="secondary" icon="check" onClick={onAcknowledgeAll}>
          Reconocer todas ({pending.length})
        </Button>
      )}
      {alarms.map((a) => {
        const key = alarmKey(a);
        const zone = ZONE_BY_ID[a.zone];
        const acked = acknowledged.has(key);
        return (
          <div key={key} className={styles.item} data-testid={`ems-alarm-${a.code}`}>
            <div className={styles.head}>
              <StatusBadge status={LEVEL_STATUS[a.level]} label={LEVEL_LABEL[a.level]} />
              <span className={styles.code}>{a.code}</span>
              <span className={styles.time}>
                {new Date(a.ts).toLocaleTimeString('es-PA', {
                  timeZone: 'America/Panama',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <div className={styles.msg}>{a.message}</div>
            <div className={styles.actions}>
              {zone ? (
                <Button
                  size="sm"
                  variant="secondary"
                  fill="text"
                  icon="crosshair"
                  onClick={() => onSelectZone(zone.id)}
                >
                  {zone.id} · {zone.name}
                </Button>
              ) : (
                <span className={styles.time}>Edificio</span>
              )}
              {a.level !== 'info' &&
                (acked ? (
                  <span className={styles.time}>
                    <Icon name="check" size="sm" /> Reconocida
                  </span>
                ) : (
                  <Button size="sm" variant="secondary" fill="outline" onClick={() => onAcknowledge(key)}>
                    Reconocer
                  </Button>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  empty: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: center;
    color: ${theme.colors.text.secondary};
    padding: ${theme.spacing(1, 0)};
  `,
  item: css`
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  code: css`
    font-weight: ${theme.typography.fontWeightMedium};
    font-size: ${theme.typography.bodySmall.fontSize};
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  time: css`
    margin-left: auto;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  msg: css`
    margin: ${theme.spacing(0.5, 0)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  actions: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
  `,
});
