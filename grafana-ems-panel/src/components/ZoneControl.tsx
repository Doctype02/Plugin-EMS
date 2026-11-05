import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Alert, Button, RadioButtonGroup, Slider, useStyles2 } from '@grafana/ui';
import { Zone } from 'building/model';
import { Command, DURATIONS, ZoneCommand, validate } from 'building/control';
import { ZoneOverride, ZoneState } from 'building/telemetry';

interface Props {
  zone: Zone;
  state?: ZoneState;
  override?: ZoneOverride;
  canControl: boolean;
  reason?: string;
  busy: boolean;
  onCommand: (c: Command) => void;
}

type Mode = 'auto' | 'on' | 'off';

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('es-PA', {
    timeZone: 'America/Panama',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** Control manual de una zona: setpoint, HVAC, iluminación y enchufes por un tiempo limitado. */
export const ZoneControl: React.FC<Props> = ({ zone, state, override, canControl, reason, busy, onCommand }) => {
  const styles = useStyles2(getStyles);
  const [setpoint, setSetpoint] = useState(override?.setpoint ?? state?.setpoint ?? 24);
  const [useSetpoint, setUseSetpoint] = useState(override?.setpoint !== undefined);
  const [hvac, setHvac] = useState<Mode>(override?.hvac ?? 'auto');
  const [lightsMode, setLightsMode] = useState<'auto' | 'manual'>(override?.lights !== undefined ? 'manual' : 'auto');
  const [lights, setLights] = useState(Math.round((override?.lights ?? state?.lights ?? 0.8) * 100));
  const [plugs, setPlugs] = useState<Mode>(
    override?.plugs === undefined ? 'auto' : override.plugs > 0.5 ? 'on' : 'off'
  );
  const [duration, setDuration] = useState(60);

  if (zone.critical) {
    return (
      <Alert severity="info" title="Carga crítica" data-testid="ems-control-locked">
        {zone.name} no admite control manual: el EMS mantiene su climatización y alimentación siempre.
      </Alert>
    );
  }

  const cmd: ZoneCommand = {
    zone: zone.id,
    setpoint: useSetpoint && hvac !== 'off' ? setpoint : undefined,
    hvac: hvac === 'auto' ? undefined : hvac,
    lights: lightsMode === 'manual' ? lights / 100 : undefined,
    plugs: plugs === 'auto' ? undefined : plugs === 'on' ? 1 : 0.1,
    durationMin: duration,
  };
  const error = validate(cmd);
  const disabled = !canControl || busy;

  return (
    <div className={styles.box} data-testid="ems-zone-control">
      {override && (
        <div className={styles.manual}>
          Control manual hasta {fmtTime(override.until)}
          {override.user ? ` · ${override.user}` : ''}
        </div>
      )}
      {!canControl && <div className={styles.muted}>{reason ?? 'Sin permiso para controlar el edificio'}</div>}

      <div className={styles.row}>
        <span className={styles.label}>HVAC</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={hvac}
          onChange={setHvac}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'Encender' },
            { value: 'off', label: 'Apagar' },
          ]}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Setpoint</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || hvac === 'off'}
          value={useSetpoint ? 'manual' : 'auto'}
          onChange={(v) => setUseSetpoint(v === 'manual')}
          options={[
            { value: 'auto', label: 'EMS' },
            { value: 'manual', label: 'Fijar' },
          ]}
        />
      </div>
      {useSetpoint && hvac !== 'off' && (
        <div className={styles.slider} data-testid="ems-control-setpoint">
          <Slider min={20} max={28} step={0.5} value={setpoint} onChange={setSetpoint} ariaLabelForHandle="Setpoint" />
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.label}>Iluminación</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={lightsMode}
          onChange={setLightsMode}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'manual', label: 'Fijar' },
          ]}
        />
      </div>
      {lightsMode === 'manual' && (
        <div className={styles.slider}>
          <Slider min={0} max={100} step={5} value={lights} onChange={setLights} ariaLabelForHandle="Nivel de luces" />
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.label}>Enchufes</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={plugs}
          onChange={setPlugs}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'Energizar' },
            { value: 'off', label: 'Cortar standby' },
          ]}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Duración</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={duration}
          onChange={setDuration}
          options={DURATIONS.map((d) => ({ value: d, label: d < 60 ? `${d} min` : `${d / 60} h` }))}
        />
      </div>
      <div className={styles.actions}>
        <Button
          size="sm"
          icon="check"
          disabled={disabled || !!error}
          tooltip={error}
          onClick={() => onCommand({ kind: 'override', cmd })}
          data-testid="ems-control-apply"
        >
          Aplicar
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="sync"
          disabled={disabled || !override}
          onClick={() => onCommand({ kind: 'release', zone: zone.id })}
          data-testid="ems-control-release"
        >
          Volver a automático
        </Button>
      </div>
      <div className={styles.muted}>
        El control manual tiene prioridad sobre las reglas del EMS y el limitador de demanda hasta que vence.
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  label: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  slider: css`
    padding: ${theme.spacing(0, 0.5)};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  manual: css`
    padding: ${theme.spacing(0.5, 1)};
    border-radius: ${theme.shape.radius.default};
    border: 1px solid ${theme.colors.warning.border};
    color: ${theme.colors.warning.text};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
