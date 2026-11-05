import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Button, Icon, Slider, useStyles2 } from '@grafana/ui';
import { ZONES, ZONE_BY_ID } from 'building/model';
import { Command, LogEntry } from 'building/control';
import { EmsParams, Overrides } from 'building/telemetry';

interface Props {
  params: EmsParams;
  overrides: Overrides;
  log: LogEntry[];
  canControl: boolean;
  reason?: string;
  busy: boolean;
  live: boolean;
  onCommand: (c: Command | Command[]) => void;
  onSelectZone: (id: string) => void;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('es-PA', {
    timeZone: 'America/Panama',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const OFFICES = ZONES.filter((z) => !z.critical);

/** Control del edificio: parámetros del EMS, acciones rápidas, overrides activos y registro de comandos. */
export const BuildingControl: React.FC<Props> = ({
  params,
  overrides,
  log,
  canControl,
  reason,
  busy,
  live,
  onCommand,
  onSelectZone,
}) => {
  const styles = useStyles2(getStyles);
  const [limit, setLimit] = useState(params.limitKw);
  const [sp, setSp] = useState(params.spOccupied);
  const disabled = !canControl || busy;
  const active = Object.entries(overrides);
  const changed = limit !== params.limitKw || sp !== params.spOccupied;

  const quick = (kind: 'precool' | 'shed' | 'night') => {
    const cmds: Command[] = OFFICES.map((z) => ({
      kind: 'override',
      cmd:
        kind === 'precool'
          ? { zone: z.id, hvac: 'on', setpoint: 23, durationMin: 30 }
          : kind === 'shed'
            ? { zone: z.id, lights: 0.6, plugs: 0.85, setpoint: 25, durationMin: 30 }
            : { zone: z.id, hvac: 'off', lights: 0, plugs: 0.1, durationMin: 240 },
    }));
    onCommand(cmds);
  };

  return (
    <div className={styles.box} data-testid="ems-building-control">
      <div className={styles.muted}>
        {live
          ? 'Los comandos se envían a Node-RED (MQTT) y se aplican en el siguiente paso del EMS.'
          : 'Modo demostración: los comandos se aplican al simulador del navegador.'}
      </div>
      {!canControl && <div className={styles.warn}>{reason ?? 'Sin permiso para controlar el edificio'}</div>}

      <div className={styles.section}>Parámetros del EMS</div>
      <div className={styles.label}>Límite de demanda (kW)</div>
      <Slider min={100} max={200} step={5} value={limit} onChange={setLimit} ariaLabelForHandle="Límite de demanda" />
      <div className={styles.label}>Setpoint con ocupación (°C)</div>
      <Slider min={22} max={26} step={0.5} value={sp} onChange={setSp} ariaLabelForHandle="Setpoint con ocupación" />
      <Button
        size="sm"
        icon="check"
        disabled={disabled || !changed}
        onClick={() => onCommand({ kind: 'params', params: { limitKw: limit, spOccupied: sp } })}
        data-testid="ems-params-apply"
      >
        Aplicar parámetros
      </Button>

      <div className={styles.section}>Acciones rápidas (zonas no críticas)</div>
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          icon="repeat"
          disabled={disabled}
          onClick={() => quick('precool')}
          tooltip="HVAC encendido a 23 °C por 30 min"
        >
          Pre-enfriar ahora
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="bolt"
          disabled={disabled}
          onClick={() => quick('shed')}
          tooltip="Luces 60 %, enchufes 85 %, setpoint 25 °C por 30 min"
          data-testid="ems-quick-shed"
        >
          Deslastre manual
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="eye-slash"
          disabled={disabled}
          onClick={() => quick('night')}
          tooltip="HVAC y luces apagados, standby cortado por 4 h"
        >
          Cierre nocturno
        </Button>
      </div>

      <div className={styles.section}>
        Zonas en control manual ({active.length})
        {active.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            fill="text"
            disabled={disabled}
            onClick={() => onCommand({ kind: 'release', zone: '*' })}
            data-testid="ems-release-all"
          >
            Liberar todas
          </Button>
        )}
      </div>
      {active.length === 0 && <div className={styles.muted}>Todas las zonas en automático (EMS).</div>}
      {active.map(([id, ov]) => (
        <div key={id} className={styles.item}>
          <Button size="sm" variant="secondary" fill="text" onClick={() => onSelectZone(id)}>
            {id} · {ZONE_BY_ID[id]?.name}
          </Button>
          <span className={styles.muted}>hasta {fmtTime(ov.until)}</span>
          <Button
            size="sm"
            variant="secondary"
            fill="outline"
            disabled={disabled}
            onClick={() => onCommand({ kind: 'release', zone: id })}
          >
            Liberar
          </Button>
        </div>
      ))}

      <div className={styles.section}>Registro de comandos</div>
      {log.length === 0 && <div className={styles.muted}>Sin comandos en esta sesión.</div>}
      {log.slice(0, 8).map((e, i) => (
        <div key={`${e.at}-${i}`} className={styles.log} data-testid="ems-command-log">
          <Icon
            name={e.ok ? 'check-circle' : 'exclamation-triangle'}
            size="sm"
            className={e.ok ? styles.ok : styles.bad}
          />
          <span className={styles.muted}>{fmtTime(e.at)}</span>
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  section: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: ${theme.spacing(1)};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)};
  `,
  item: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(0.5)};
  `,
  log: css`
    display: flex;
    gap: ${theme.spacing(0.75)};
    align-items: baseline;
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  ok: css`
    color: ${theme.colors.success.text};
  `,
  bad: css`
    color: ${theme.colors.error.text};
  `,
  warn: css`
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
