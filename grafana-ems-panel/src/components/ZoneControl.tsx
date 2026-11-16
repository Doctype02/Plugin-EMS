import React, { useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Alert, Button, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { Zone } from 'building/model';
import {
  Command,
  CommandResult,
  DURATIONS,
  SP_RANGE,
  SendFeedback,
  ZoneCommand,
  durationLabel,
  maxPeople,
  validate,
} from 'building/control';
import { ConfirmInline, ControlGroup, NumberParam, SendStatus } from './controls';
import { Glyph } from './Glyph';
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
  feedback?: SendFeedback;
  onDismissFeedback?: () => void;
  onCommand: (c: Command | Command[]) => Promise<CommandResult> | void;
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
  feedback,
  onDismissFeedback,
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
  const [confirming, setConfirming] = useState(false);

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
    setConfirming(false);
    onCommand(cmds);
  };
  // apagar el HVAC de una zona ocupada es la acción de mayor impacto: se confirma antes
  const needsConfirm = hvacChange && hvac === 'off';
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
      <SendStatus busy={busy} feedback={feedback} onDismiss={onDismissFeedback} />
      {!canControl && <div className={styles.muted}>{reason ?? 'Sin permiso para controlar el edificio'}</div>}

      <ControlGroup
        title="Climatización"
        icon={<Glyph name="snow" size={16} />}
        aside={state ? `${state.temp.toFixed(1)} °C ahora` : undefined}
      >
        <div className={styles.row}>
          <span className={styles.label}>Equipo</span>
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
          <NumberParam
            label="Setpoint de la zona"
            value={setpoint}
            current={state?.setpoint}
            unit="°C"
            min={SP_RANGE[0]}
            max={SP_RANGE[1]}
            step={0.5}
            disabled={disabled}
            onChange={setSetpoint}
            testId="ems-control-setpoint"
          />
        )}
      </ControlGroup>

      <ControlGroup title="Iluminación y enchufes" icon={<Glyph name="bolt" size={16} />}>
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
          <NumberParam
            label="Nivel de luces"
            value={lights}
            unit="%"
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            onChange={setLights}
          />
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
      </ControlGroup>
      {hasPeople && (
        <ControlGroup
          title="Personas"
          icon={<Glyph name="users" size={16} />}
          aside={state ? `${state.occupants} / ${zone.occupants} ahora` : undefined}
        >
          <div className={styles.row}>
            <span className={styles.label}>Cantidad</span>
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
        </ControlGroup>
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
      {confirming && needsConfirm ? (
        <ConfirmInline
          title={`¿Apagar la climatización de ${zone.id} durante ${durationLabel(duration)}?`}
          detail={`${zone.name} se calentará${state && state.occupants > 0 ? ` con ${state.occupants} personas dentro` : ''}; el EMS no la enfriará hasta que venza o vuelva a automático.`}
          confirmLabel="Apagar HVAC"
          destructive
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={apply}
          testId="ems-control-confirm"
        />
      ) : (
        <div className={styles.actions}>
          <Button
            size="sm"
            icon={busy ? undefined : 'check'}
            disabled={disabled || !!error}
            tooltip={error}
            onClick={() => (needsConfirm ? setConfirming(true) : apply())}
            data-testid="ems-control-apply"
          >
            {busy ? 'Enviando…' : 'Aplicar'}
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
      )}
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
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    & > button:first-child {
      flex: 1;
      justify-content: center;
    }
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
