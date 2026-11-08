import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Alert, Button, RadioButtonGroup, Slider, useStyles2 } from '@grafana/ui';
import { Zone } from 'building/model';
import { Command, DURATIONS, ZoneCommand, durationLabel, maxPeople, validate } from 'building/control';
import { OccupancyOverride, ZoneOverride, ZoneState } from 'building/telemetry';

interface Props {
  zone: Zone;
  state?: ZoneState;
  override?: ZoneOverride;
  /** Personas fijadas por el operador en esta zona. */
  occupancy?: OccupancyOverride;
  canControl: boolean;
  reason?: string;
  busy: boolean;
  onCommand: (c: Command | Command[]) => void;
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
export const ZoneControl: React.FC<Props> = ({
  zone,
  state,
  override,
  occupancy,
  canControl,
  reason,
  busy,
  onCommand,
}) => {
  const styles = useStyles2(getStyles);
  const [setpoint, setSetpoint] = useState(override?.setpoint ?? state?.setpoint ?? 24);
  const [useSetpoint, setUseSetpoint] = useState(override?.setpoint !== undefined);
  const [hvac, setHvac] = useState<Mode>(override?.hvac ?? 'auto');
  const [lightsMode, setLightsMode] = useState<'auto' | 'manual'>(override?.lights !== undefined ? 'manual' : 'auto');
  const [lights, setLights] = useState(Math.round((override?.lights ?? state?.lights ?? 0.8) * 100));
  const [plugs, setPlugs] = useState<Mode>(
    override?.plugs === undefined ? 'auto' : override.plugs > 0.5 ? 'on' : 'off'
  );
  const [duration, setDuration] = useState(15);
  const hasPeople = zone.occupants > 0;
  const [peopleMode, setPeopleMode] = useState<'auto' | 'manual'>(occupancy?.people !== undefined ? 'manual' : 'auto');
  const [people, setPeople] = useState(occupancy?.people ?? state?.occupants ?? zone.occupants);

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
  const hvacChange = validate(cmd) === undefined;
  const peopleChange = hasPeople && (peopleMode === 'manual' || occupancy !== undefined);
  const error = hvacChange || peopleChange ? undefined : validate(cmd);
  const disabled = !canControl || busy;
  const max = maxPeople(zone.id);
  const apply = () => {
    const cmds: Command[] = [];
    if (hvacChange) {
      cmds.push({ kind: 'override', cmd });
    }
    if (hasPeople && peopleMode === 'manual') {
      cmds.push({ kind: 'occupancy', zone: zone.id, people, durationMin: duration });
    } else if (hasPeople && occupancy) {
      cmds.push({ kind: 'occupancy_release', zone: zone.id });
    }
    onCommand(cmds);
  };
  const release = () => {
    const cmds: Command[] = [];
    if (override) {
      cmds.push({ kind: 'release', zone: zone.id });
    }
    if (occupancy) {
      cmds.push({ kind: 'occupancy_release', zone: zone.id });
    }
    onCommand(cmds);
  };

  return (
    <div className={styles.box} data-testid="ems-zone-control">
      {override && (
        <div className={styles.manual}>
          Control manual hasta {fmtTime(override.until)}
          {override.user ? ` · ${override.user}` : ''}
        </div>
      )}
      {occupancy?.people !== undefined && (
        <div className={styles.manual}>
          {occupancy.people} personas fijadas hasta {fmtTime(occupancy.until)}
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
      {hasPeople && (
        <>
          <div className={styles.row}>
            <span className={styles.label}>Personas</span>
            <RadioButtonGroup
              size="sm"
              disabled={disabled}
              value={peopleMode}
              onChange={setPeopleMode}
              options={[
                { value: 'auto', label: 'Horario' },
                { value: 'manual', label: 'Fijar' },
              ]}
            />
          </div>
          {peopleMode === 'manual' && (
            <div className={styles.people} data-testid="ems-control-people">
              <Button
                size="sm"
                variant="secondary"
                icon="minus"
                aria-label="Menos personas"
                disabled={disabled || people <= 0}
                onClick={() => setPeople((p) => Math.max(0, p - 1))}
              />
              <input
                type="range"
                className={styles.range}
                min={0}
                max={max}
                step={1}
                value={people}
                disabled={disabled}
                aria-label="Cantidad de personas"
                onChange={(e) => setPeople(Number(e.currentTarget.value))}
              />
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                aria-label="Más personas"
                disabled={disabled || people >= max}
                onClick={() => setPeople((p) => Math.min(max, p + 1))}
              />
              <span className={styles.peopleValue}>
                {people}
                <small> / {zone.occupants}</small>
              </span>
            </div>
          )}
          {peopleMode === 'manual' && (
            <div className={people > zone.occupants ? styles.warnText : styles.muted}>
              {people === 0
                ? 'Zona vacía: el EMS apaga luces y pasa el HVAC a vacancia.'
                : people > zone.occupants
                  ? `Sobre el aforo de diseño (${zone.occupants}): más calor interno (≈ ${((people * 75) / 1000).toFixed(1)} kW sensibles) y ventilación.`
                  : `≈ ${((people * 75) / 1000).toFixed(1)} kW de calor sensible de las personas.`}
            </div>
          )}
        </>
      )}
      <div className={styles.row}>
        <span className={styles.label}>Duración</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={duration}
          onChange={setDuration}
          options={DURATIONS.map((d) => ({ value: d, label: durationLabel(d) }))}
        />
      </div>
      <div className={styles.actions}>
        <Button
          size="sm"
          icon="check"
          disabled={disabled || !!error}
          tooltip={error}
          onClick={apply}
          data-testid="ems-control-apply"
        >
          Aplicar
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="sync"
          disabled={disabled || (!override && !occupancy)}
          onClick={release}
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
  people: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
  `,
  range: css`
    flex: 1;
    accent-color: ${theme.colors.primary.main};
  `,
  peopleValue: css`
    min-width: 54px;
    text-align: right;
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    small {
      font-size: ${theme.typography.bodySmall.fontSize};
      color: ${theme.colors.text.secondary};
    }
  `,
  warnText: css`
    color: ${theme.colors.warning.text};
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
