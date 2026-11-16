import React, { useState } from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, RadioButtonGroup, Switch, useStyles2 } from '@grafana/ui';
import { CONTROLLER_LIMITS, Zone } from 'building/model';
import { Command, CommandResult, describeSensorForce, durationLabel, validateSensor } from 'building/control';
import { CONTROLLER_DURATIONS, SensorForm, forceFromForm, formFromForce, remainingText } from 'building/controllers';
import { SensorForce, SensorOverride, ZoneState } from 'building/telemetry';
import { ConfirmInline, ControlGroup, NumberParam } from './controls';
import { Glyph } from './Glyph';

interface Props {
  zone: Zone;
  state?: ZoneState;
  /** Forzado vigente (del gemelo o local). */
  force?: SensorForce;
  local?: SensorOverride;
  canControl: boolean;
  busy: boolean;
  onCommand: (c: Command | Command[]) => Promise<CommandResult> | void;
}

const L = CONTROLLER_LIMITS;
const yesNo = (v?: boolean) => (v === undefined ? '—' : v ? 'sí' : 'no');
const num = (v: number | undefined, d: number, u: string) =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)} ${u}`;

/**
 * «Datos del sensor» de una zona: lo que lee el controlador frente al valor real, y forzado de la lectura
 * (desfase o valor fijo de temperatura, HR, presencia, congelado). La física no cambia: el EMS y el
 * termostato reaccionan a la lectura como con un sensor mal calibrado.
 */
export const SensorControl: React.FC<Props> = ({ zone, state, force, local, canControl, busy, onCommand }) => {
  const styles = useStyles2(getStyles);
  const [form, setForm] = useState(() => formFromForce(force, state));
  const [duration, setDuration] = useState<number | undefined>(60);
  const [confirming, setConfirming] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const f = forceFromForm(form);
  const cmd: Command = { kind: 'sensor', zone: zone.id, force: f, durationMin: duration, confirm: zone.critical };
  const error = validateSensor(cmd);
  const disabled = !canControl || busy;
  const left =
    state?.sensorRemainingMin ??
    (local && Number.isFinite(local.until) && state ? (local.until - state.updatedAt) / 60_000 : undefined);
  const apply = () => {
    setConfirming(false);
    onCommand(cmd);
  };
  const forcedTemp = !!force && (force.frozen || force.tempOffset !== undefined || force.tempValue !== undefined);
  const forcedRh = !!force && (force.frozen || force.rh !== undefined);
  const forcedOcc = !!force && (force.frozen || force.presence !== undefined);

  return (
    <ControlGroup
      title="Datos del sensor"
      icon={<Glyph name="thermometer" size={16} />}
      aside={force ? <span className={styles.forcedTag}>forzado · {remainingText(left)}</span> : 'lectura real'}
      testId="ems-sensor-control"
    >
      <table className={styles.table}>
        <thead>
          <tr>
            <th />
            <th>Lee el controlador</th>
            <th>Real</th>
          </tr>
        </thead>
        <tbody>
          <tr className={cx(forcedTemp && styles.forcedRow)}>
            <td>Temperatura</td>
            <td>{num(state?.temp, 1, '°C')}</td>
            <td>{num(state?.tempReal ?? state?.temp, 1, '°C')}</td>
          </tr>
          <tr className={cx(forcedRh && styles.forcedRow)}>
            <td>Humedad rel.</td>
            <td>{num(state?.rh, 0, '%')}</td>
            <td>{num(state?.rhReal ?? state?.rh, 0, '%')}</td>
          </tr>
          <tr className={cx(forcedOcc && styles.forcedRow)}>
            <td>Presencia</td>
            <td>{yesNo(state?.occupied)}</td>
            <td>{yesNo(state?.occupiedReal ?? state?.occupied)}</td>
          </tr>
        </tbody>
      </table>
      {force && <div className={styles.forcedText}>Forzado: {describeSensorForce(force)}</div>}

      <div className={styles.row}>
        <span className={styles.label}>Temperatura</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || form.frozen}
          value={form.temp}
          onChange={(v) => set('temp', v as SensorForm['temp'])}
          options={[
            { value: 'real', label: 'Real' },
            { value: 'offset', label: 'Desfase' },
            { value: 'value', label: 'Fija' },
          ]}
        />
      </div>
      {form.temp === 'offset' && !form.frozen && (
        <NumberParam
          label="Desfase del sensor"
          value={form.offset}
          unit="°C"
          min={L.tempOffset[0]}
          max={L.tempOffset[1]}
          step={0.5}
          disabled={disabled}
          onChange={(v) => set('offset', v)}
          note={
            form.offset > 0
              ? 'Lee de más: el EMS enfriará la zona por debajo del setpoint.'
              : 'Lee de menos: el EMS dejará de enfriar y la zona se calentará.'
          }
          testId="ems-sensor-offset"
        />
      )}
      {form.temp === 'value' && !form.frozen && (
        <NumberParam
          label="Temperatura leída"
          value={form.value}
          current={state?.tempReal}
          unit="°C"
          min={L.tempValue[0]}
          max={L.tempValue[1]}
          step={0.5}
          disabled={disabled}
          onChange={(v) => set('value', v)}
          note="Con el ruido normal del sensor (para no parecer congelado)."
        />
      )}
      <div className={styles.row}>
        <span className={styles.label}>Humedad</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || form.frozen}
          value={form.rhMode}
          onChange={(v) => set('rhMode', v as SensorForm['rhMode'])}
          options={[
            { value: 'real', label: 'Real' },
            { value: 'value', label: 'Fija' },
          ]}
        />
      </div>
      {form.rhMode === 'value' && !form.frozen && (
        <NumberParam
          label="HR leída"
          value={form.rh}
          current={state?.rhReal}
          unit="%"
          min={L.rh[0]}
          max={L.rh[1]}
          step={5}
          disabled={disabled}
          onChange={(v) => set('rh', v)}
          note="Informativa: el VRF no controla la humedad (como en el modelo E+)."
        />
      )}
      <div className={styles.row}>
        <span className={styles.label}>Presencia</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || form.frozen}
          value={form.presence}
          onChange={(v) => set('presence', v as SensorForm['presence'])}
          options={[
            { value: 'real', label: 'Real' },
            { value: 'on', label: 'Ocupada' },
            { value: 'off', label: 'Vacía' },
          ]}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Congelar todas las lecturas</span>
        <Switch
          value={form.frozen}
          disabled={disabled}
          onChange={(e) => set('frozen', e.currentTarget.checked)}
          aria-label="Congelar el sensor"
          data-testid="ems-sensor-frozen"
        />
      </div>
      {form.frozen && (
        <div className={styles.muted}>
          Las lecturas quedan fijas en el último valor; el supervisor lo detecta en ≈ 30 min (SENSOR_CONGELADO) y pasa
          la zona a modo seguro.
        </div>
      )}
      <div className={styles.row}>
        <span className={styles.label}>Duración</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={duration ?? 0}
          onChange={(v) => setDuration(v === 0 ? undefined : v)}
          options={CONTROLLER_DURATIONS.map((d) => ({
            value: d ?? 0,
            label: d === undefined ? 'Sin límite' : durationLabel(d),
          }))}
        />
      </div>
      {confirming ? (
        <ConfirmInline
          title={`${zone.id} es una zona crítica. ¿Forzar su sensor (${describeSensorForce(f)})?`}
          detail="El control del cuarto de servidores actuará con un dato falso: puede sobrecalentarse."
          confirmLabel="Forzar sensor"
          destructive
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={apply}
          testId="ems-sensor-confirm"
        />
      ) : (
        <div className={styles.actions}>
          <Button
            size="sm"
            icon="check"
            disabled={disabled || !!error}
            tooltip={error}
            onClick={() => (zone.critical ? setConfirming(true) : apply())}
            data-testid="ems-sensor-apply"
          >
            Forzar lectura
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="sync"
            disabled={disabled || !force}
            onClick={() => onCommand({ kind: 'sensor_release', zone: zone.id })}
            data-testid="ems-sensor-release"
          >
            Valor real
          </Button>
        </div>
      )}
    </ControlGroup>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: ${theme.typography.bodySmall.fontSize};
    font-variant-numeric: tabular-nums;
    th {
      font-weight: ${theme.typography.fontWeightRegular};
      color: ${theme.colors.text.secondary};
      text-align: right;
      padding: 2px 4px;
      font-size: 11px;
    }
    td {
      padding: 3px 4px;
      text-align: right;
      border-top: 1px solid ${theme.colors.border.weak};
    }
    td:first-child {
      text-align: left;
      color: ${theme.colors.text.secondary};
    }
  `,
  forcedRow: css`
    td:nth-child(2) {
      color: ${theme.colors.warning.text};
      font-weight: ${theme.typography.fontWeightMedium};
      background: ${colorManipulator.alpha(theme.colors.warning.main, theme.isDark ? 0.12 : 0.08)};
    }
  `,
  forcedTag: css`
    color: ${theme.colors.warning.text};
  `,
  forcedText: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.warning.text};
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
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    & > button:first-child {
      flex: 1;
      justify-content: center;
    }
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
