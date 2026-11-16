import React, { useState } from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, Icon, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { CONTROLLER_LIMITS, HVAC_SYSTEMS, HvacSystem, ZONE_BY_ID } from 'building/model';
import {
  Command,
  CommandResult,
  SendFeedback,
  describeSensorForce,
  describeUnitAdjust,
  durationLabel,
  validateUnit,
} from 'building/control';
import {
  CONTROLLER_DURATIONS,
  UNIT_MODE_TEXT,
  adjustFromForm,
  formFromAdjust,
  needsUnitConfirm,
  remainingText,
  sensorForceOf,
  unitBadge,
  unitView,
} from 'building/controllers';
import { newEvent } from 'building/events';
import { SensorOverrides, Snapshot, UnitAdjustments, UnitMode, UnitStatus } from 'building/telemetry';
import { ConfirmInline, ControlGroup, NumberParam, SendStatus } from './controls';
import { Glyph } from './Glyph';
import { StatusBadge } from './StatusBadge';

interface Props {
  snapshot: Snapshot;
  now: number;
  units: UnitAdjustments;
  sensors: SensorOverrides;
  canControl: boolean;
  reason?: string;
  busy: boolean;
  feedback?: SendFeedback;
  onDismissFeedback?: () => void;
  live: boolean;
  onCommand: (c: Command | Command[]) => Promise<CommandResult> | void;
  onSelectZone: (id: string) => void;
}

const L = CONTROLLER_LIMITS;
const fmt = (v: number | undefined, d: number) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const durText = (d?: number) => (d === undefined ? 'Sin límite' : durationLabel(d));

/** Pestaña «Controladores»: estado real de las 11 unidades VRF/PTAC y ajuste de su controlador local. */
export const ControllersPanel: React.FC<Props> = (props) => {
  const {
    snapshot,
    units,
    sensors,
    canControl,
    reason,
    busy,
    feedback,
    onDismissFeedback,
    live,
    onCommand,
    onSelectZone,
  } = props;
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState<string>();
  const views = HVAC_SYSTEMS.map((u) => ({ u, st: unitView(u, snapshot, units[u.id]) }));
  const nUnits = views.filter((v) => v.st.forced).length;
  const forcedZones = Object.keys(ZONE_BY_ID).filter((id) => sensorForceOf(snapshot.zones[id], sensors[id]));
  const totalKw = views.reduce((a, v) => a + v.st.pKw, 0);
  const disabled = !canControl || busy;

  return (
    <div className={styles.box} data-testid="ems-controllers">
      <SendStatus busy={busy} feedback={feedback} onDismiss={onDismissFeedback} />
      {!canControl && <div className={styles.muted}>{reason ?? 'Sin permiso para controlar el edificio'}</div>}
      <div className={styles.summary}>
        <span>
          <b>{HVAC_SYSTEMS.length}</b> unidades · <b>{totalKw.toFixed(1)}</b> kW
        </span>
        <span className={nUnits ? styles.warnText : styles.muted}>
          {nUnits ? `${nUnits} en manual` : 'todas en automático'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          fill="outline"
          icon="sync"
          disabled={disabled || (!nUnits && !forcedZones.length)}
          onClick={() =>
            onCommand([
              ...(nUnits ? [{ kind: 'unit_release', unit: '*' } as Command] : []),
              ...(forcedZones.length ? [{ kind: 'sensor_release', zone: '*' } as Command] : []),
            ])
          }
          data-testid="ems-ctl-release-all"
        >
          Liberar todo
        </Button>
      </div>
      <div className={styles.list}>
        {views.map(({ u, st }) => (
          <UnitCard
            key={u.id}
            unit={u}
            status={st}
            open={open === u.id}
            onToggle={() => setOpen((o) => (o === u.id ? undefined : u.id))}
            {...props}
          />
        ))}
      </div>
      <ControlGroup
        title="Sensores forzados"
        icon={<Glyph name="thermometer" size={16} />}
        aside={forcedZones.length ? `${forcedZones.length}` : undefined}
        testId="ems-ctl-sensors"
      >
        {forcedZones.length === 0 ? (
          <div className={styles.muted}>
            Ninguno. Abre una zona en el plano para forzar lo que lee su sensor (temperatura, HR, presencia).
          </div>
        ) : (
          forcedZones.map((id) => {
            const s = snapshot.zones[id];
            const f = sensorForceOf(s, sensors[id])!;
            const left =
              s?.sensorRemainingMin ??
              (sensors[id] && Number.isFinite(sensors[id].until)
                ? (sensors[id].until - snapshot.time) / 60_000
                : undefined);
            return (
              <div key={id} className={styles.sensorRow}>
                <button type="button" className={styles.link} onClick={() => onSelectZone(id)}>
                  {id} · {ZONE_BY_ID[id]?.name}
                </button>
                <span className={styles.sensorText}>
                  {describeSensorForce(f)}
                  {s?.tempReal !== undefined && Number.isFinite(s.temp)
                    ? ` · lee ${s.temp.toFixed(1)} °C, real ${s.tempReal.toFixed(1)} °C`
                    : ''}
                  {` · ${remainingText(left)}`}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  fill="text"
                  icon="sync"
                  aria-label={`Liberar sensor de ${id}`}
                  disabled={disabled}
                  onClick={() => onCommand({ kind: 'sensor_release', zone: id })}
                />
              </div>
            );
          })
        )}
      </ControlGroup>
      <div className={styles.muted}>
        El controlador local de la unidad tiene prioridad sobre el EMS mientras dura el ajuste.
        {live ? ' Los valores vienen del gemelo (tópico sim/controladores).' : ' Simulación local del panel.'}
      </div>
    </div>
  );
};

interface CardProps extends Props {
  unit: HvacSystem;
  status: UnitStatus;
  open: boolean;
  onToggle: () => void;
}

const UnitCard: React.FC<CardProps> = ({ unit, status: st, open, onToggle, ...p }) => {
  const styles = useStyles2(getStyles);
  const badge = unitBadge(st);
  const local = p.units[unit.id];
  return (
    <div className={cx(styles.card, open && styles.cardOpen)} data-testid={`ems-ctl-unit-${unit.id}`}>
      <button type="button" className={styles.cardHead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.cardTitle}>
          <Glyph name="fan" size={15} />
          <b>{unit.id}</b>
          <span className={styles.kind}>{unit.kind === 'ptac' ? 'PTAC' : 'VRF'}</span>
          {unit.critical && <span className={styles.crit}>crítica</span>}
        </span>
        <StatusBadge status={badge.status} label={badge.text} />
        <Icon name={open ? 'angle-up' : 'angle-down'} />
      </button>
      <div className={styles.metrics}>
        <Metric label="Potencia" value={`${fmt(st.pKw, 1)} kW`} />
        <Metric label="Carga" value={`${fmt(st.loadPct, 0)} %`} bar={st.loadPct} />
        <Metric label="COP" value={fmt(st.cop, 2)} accent={st.copFactor < 1} />
        <Metric label="Modo" value={UNIT_MODE_TEXT[st.mode]} accent={st.mode !== 'auto'} />
      </div>
      <div className={styles.zones}>
        {unit.zones.map((id) => {
          const z = p.snapshot.zones[id];
          return (
            <button
              key={id}
              type="button"
              className={styles.zoneChip}
              onClick={() => p.onSelectZone(id)}
              title={ZONE_BY_ID[id]?.name}
            >
              {id}
              {z && Number.isFinite(z.temp) && <span>{z.temp.toFixed(1)}°</span>}
            </button>
          );
        })}
        {st.forced && (
          <span className={styles.manual}>
            {describeUnitAdjust({
              on: st.on ? undefined : false,
              mode: st.mode === 'apagado' || st.mode === 'auto' ? undefined : st.mode,
              capPct: st.capPct < 100 ? st.capPct : undefined,
              setpoint: st.setpoint,
              copFactor: st.copFactor !== 1 ? st.copFactor : undefined,
            })}{' '}
            · {remainingText(st.remainingMin)}
          </span>
        )}
      </div>
      {open && <UnitEditor key={`${unit.id}-${local?.since ?? 0}`} unit={unit} status={st} {...p} />}
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; bar?: number; accent?: boolean }> = ({
  label,
  value,
  bar,
  accent,
}) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={cx(styles.metricValue, accent && styles.warnText)}>{value}</span>
      {bar !== undefined && (
        <span className={styles.metricBar}>
          <i style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} />
        </span>
      )}
    </div>
  );
};

const UnitEditor: React.FC<Props & { unit: HvacSystem; status: UnitStatus }> = ({
  unit,
  status: st,
  units,
  snapshot,
  now,
  canControl,
  busy,
  onCommand,
}) => {
  const styles = useStyles2(getStyles);
  const local = units[unit.id];
  const sp0 = snapshot.zones[unit.zones[0]]?.setpoint ?? 24;
  const [form, setForm] = useState(() =>
    formFromAdjust(
      local ??
        (st.forced
          ? {
              on: st.on ? undefined : false,
              mode: st.mode === 'apagado' ? undefined : st.mode,
              capPct: st.capPct,
              setpoint: st.setpoint,
              copFactor: st.copFactor,
            }
          : undefined),
      sp0
    )
  );
  const [duration, setDuration] = useState<number | undefined>(60);
  const [confirming, setConfirming] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const adjust = adjustFromForm(form);
  const cmd: Command = { kind: 'unit', unit: unit.id, adjust, durationMin: duration, confirm: unit.critical };
  const error = validateUnit({ ...cmd, confirm: true });
  const disabled = !canControl || busy;
  const askConfirm = needsUnitConfirm(unit, adjust);
  const apply = () => {
    setConfirming(false);
    onCommand(cmd);
  };
  return (
    <div className={styles.editor} data-testid={`ems-ctl-editor-${unit.id}`}>
      <div className={styles.row}>
        <span className={styles.label}>Unidad</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={form.on ? 'on' : 'off'}
          onChange={(v) => set('on', v === 'on')}
          options={[
            { value: 'on', label: 'Encendida' },
            { value: 'off', label: 'Apagada' },
          ]}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>Modo</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || !form.on}
          value={form.mode}
          onChange={(v) => set('mode', v as UnitMode)}
          options={[
            { value: 'auto', label: 'Auto', description: 'Obedece al EMS' },
            { value: 'frio', label: 'Frío local', description: 'Termostato propio: ignora deslastre del EMS' },
            { value: 'ventilacion', label: 'Ventilación', description: 'Sólo ventiladores, sin compresor' },
          ]}
        />
      </div>
      <NumberParam
        label="Capacidad máxima"
        value={form.capPct}
        current={st.capPct}
        unit="%"
        min={L.capPct[0]}
        max={L.capPct[1]}
        step={5}
        disabled={disabled || !form.on || form.mode === 'ventilacion'}
        onChange={(v) => set('capPct', v)}
        note={`Tope de ${((form.capPct / 100) * unit.capacityKw).toFixed(1)} de ${unit.capacityKw.toFixed(1)} kW térmicos, repartido entre sus zonas.`}
        testId={`ems-ctl-cap-${unit.id}`}
      />
      <div className={styles.row}>
        <span className={styles.label}>Setpoint de sus zonas</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled || !form.on}
          value={form.useSetpoint ? 'manual' : 'auto'}
          onChange={(v) => set('useSetpoint', v === 'manual')}
          options={[
            { value: 'auto', label: 'EMS' },
            { value: 'manual', label: 'Fijar' },
          ]}
        />
      </div>
      {form.useSetpoint && form.on && (
        <NumberParam
          label="Setpoint local"
          value={form.setpoint}
          current={st.setpoint ?? sp0}
          unit="°C"
          min={L.unitSetpoint[0]}
          max={L.unitSetpoint[1]}
          step={0.5}
          disabled={disabled}
          onChange={(v) => set('setpoint', v)}
        />
      )}
      <NumberParam
        label="Factor de COP"
        value={form.copFactor}
        current={st.copFactor}
        unit="×"
        min={L.copFactor[0]}
        max={L.copFactor[1]}
        step={0.05}
        disabled={disabled || !form.on}
        onChange={(v) => set('copFactor', Math.round(v * 100) / 100)}
        note={
          form.copFactor < 1
            ? `Degradación: el mismo frío cuesta ${Math.round((1 / form.copFactor - 1) * 100)} % más de potencia.`
            : 'Simula suciedad del condensador, falta de refrigerante o una unidad nueva (> 1).'
        }
      />
      <div className={styles.row}>
        <span className={styles.label}>Duración</span>
        <RadioButtonGroup
          size="sm"
          disabled={disabled}
          value={duration ?? 0}
          onChange={(v) => setDuration(v === 0 ? undefined : v)}
          options={CONTROLLER_DURATIONS.map((d) => ({ value: d ?? 0, label: durText(d) }))}
        />
      </div>
      {confirming ? (
        <ConfirmInline
          title={
            unit.critical
              ? `${unit.id} climatiza el cuarto de servidores (zona crítica). ¿Aplicar el ajuste?`
              : `¿Aplicar a ${unit.id}: ${describeUnitAdjust(adjust)}?`
          }
          detail={`Zonas afectadas: ${unit.zones.join(', ')}. ${
            adjust.on === false || adjust.capPct === 0
              ? 'Se quedan sin enfriamiento y se calentarán.'
              : 'El EMS no podrá corregirlo hasta que venza o se libere.'
          } Duración: ${durText(duration).toLowerCase()}.`}
          confirmLabel="Aplicar ajuste"
          destructive={unit.critical || adjust.on === false}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={apply}
          testId={`ems-ctl-confirm-${unit.id}`}
        />
      ) : (
        <div className={styles.actions}>
          <Button
            size="sm"
            icon="check"
            disabled={disabled || !!error}
            tooltip={error}
            onClick={() => (askConfirm ? setConfirming(true) : apply())}
            data-testid={`ems-ctl-apply-${unit.id}`}
          >
            Aplicar
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="sync"
            disabled={disabled || !st.forced}
            onClick={() => onCommand({ kind: 'unit_release', unit: unit.id })}
          >
            Automático
          </Button>
          <Button
            size="sm"
            variant="destructive"
            fill="outline"
            icon="fire"
            disabled={disabled || st.fault}
            tooltip="Falla del compresor por 30 min (evento falla_vrf)"
            onClick={() => onCommand({ kind: 'event', event: newEvent('falla_vrf', now, 30, { unit: unit.id }) })}
          >
            Falla
          </Button>
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  summary: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    font-size: ${theme.typography.bodySmall.fontSize};
    font-variant-numeric: tabular-nums;
    & > button {
      margin-left: auto;
    }
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  cardOpen: css`
    border-color: ${theme.colors.primary.border};
  `,
  cardHead: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: 0;
    border: none;
    background: none;
    color: ${theme.colors.text.primary};
    cursor: pointer;
    text-align: left;
  `,
  cardTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    flex: 1;
    min-width: 0;
  `,
  kind: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  crit: css`
    padding: 0 6px;
    border-radius: 8px;
    font-size: 10px;
    line-height: 16px;
    color: ${theme.colors.error.text};
    border: 1px solid ${theme.colors.error.border};
  `,
  metrics: css`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: ${theme.spacing(0.75)};
  `,
  metric: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
  `,
  metricLabel: css`
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: ${theme.colors.text.secondary};
  `,
  metricValue: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  metricBar: css`
    position: relative;
    height: 3px;
    margin-top: 2px;
    border-radius: 2px;
    background: ${theme.colors.border.weak};
    i {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 2px;
      background: ${theme.colors.primary.main};
    }
  `,
  zones: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  `,
  zoneChip: css`
    display: inline-flex;
    gap: 4px;
    padding: 0 6px;
    border-radius: 10px;
    border: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.primary};
    color: ${theme.colors.text.primary};
    font-size: 11px;
    line-height: 18px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    span {
      color: ${theme.colors.text.secondary};
    }
    &:hover {
      border-color: ${theme.colors.border.strong};
    }
  `,
  manual: css`
    flex-basis: 100%;
    padding: ${theme.spacing(0.25, 0.75)};
    border-radius: ${theme.shape.radius.default};
    border: 1px solid ${theme.colors.warning.border};
    background: ${colorManipulator.alpha(theme.colors.warning.main, theme.isDark ? 0.1 : 0.06)};
    color: ${theme.colors.warning.text};
    font-size: 11px;
  `,
  editor: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding-top: ${theme.spacing(1)};
    border-top: 1px solid ${theme.colors.border.weak};
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
  sensorRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  sensorText: css`
    flex: 1;
    min-width: 0;
    color: ${theme.colors.warning.text};
  `,
  link: css`
    padding: 0;
    border: none;
    background: none;
    color: ${theme.colors.text.link};
    cursor: pointer;
    white-space: nowrap;
    font-size: inherit;
  `,
  warnText: css`
    color: ${theme.colors.warning.text};
  `,
  muted: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
