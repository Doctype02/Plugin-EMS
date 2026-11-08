import React, { useState } from 'react';
import { Glyph, GlyphName } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, Icon, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { ZONES, ZONE_BY_ID, thermal } from 'building/model';
import { Command, LogEntry, durationLabel } from 'building/control';
import { EmsParams, OccupancyOverrides, Overrides, Snapshot } from 'building/telemetry';
import { ZoneMiniMap } from './ZoneMiniMap';

interface Props {
  params: EmsParams;
  overrides: Overrides;
  /** Personas forzadas por el operador (por zona y '*' para el edificio). */
  occupancy: OccupancyOverrides;
  log: LogEntry[];
  snapshot: Snapshot;
  now: number;
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
const DEFAULTS: EmsParams = { limitKw: 30, spOccupied: 24 };
/** kW eléctricos por °C de setpoint en las zonas con ocupación (G/COP del modelo RC). */
const KW_PER_DEG = OFFICES.reduce((a, z) => {
  const th = thermal(z);
  return a + (th.ua + th.gInf + th.uaGround) / z.cop;
}, 0);
const QUICK_DURATIONS = [5, 15, 30, 60];
const OCC_PRESETS = [
  { label: 'Vacío', pct: 0 },
  { label: 'Media', pct: 50 },
  { label: 'Normal', pct: 100 },
  { label: 'Evento', pct: 130 },
];

type QuickKind = 'precool' | 'eco' | 'shed' | 'night';
const QUICK: Array<{ kind: QuickKind; glyph: GlyphName; title: string; detail: string; effect: string }> = [
  {
    kind: 'precool',
    glyph: 'snow',
    title: 'Pre-enfriar',
    detail: 'HVAC encendido a 23 °C en todas las zonas',
    effect: 'Llega fresco a la ocupación · más consumo ahora',
  },
  {
    kind: 'eco',
    glyph: 'leaf',
    title: 'Modo eco',
    detail: 'Setpoint 25 °C y luces al 70 %',
    effect: `≈ −${(KW_PER_DEG * 1).toFixed(1)} kW de HVAC · confort aceptable`,
  },
  {
    kind: 'shed',
    glyph: 'bolt',
    title: 'Deslastre',
    detail: 'Luces 60 %, enchufes 85 %, setpoint 25 °C',
    effect: 'Recorta el pico de demanda de inmediato',
  },
  {
    kind: 'night',
    glyph: 'moon',
    title: 'Cierre',
    detail: 'HVAC y luces apagados, standby cortado',
    effect: 'Consumo mínimo · sólo cargas críticas',
  },
];

/** Control del edificio: mapa de zonas, parámetros del EMS, acciones rápidas, manuales y registro. */
export const BuildingControl: React.FC<Props> = ({
  params,
  overrides,
  occupancy,
  log,
  snapshot,
  now,
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
  const [duration, setDuration] = useState(15);
  const building = occupancy['*'];
  const [pct, setPct] = useState(building?.pct ?? 100);
  const [occDuration, setOccDuration] = useState(60);
  const zoneOcc = Object.entries(occupancy).filter(([k]) => k !== '*');
  const people = ZONES.reduce((a, z) => a + (snapshot.zones[z.id]?.occupants ?? 0), 0);
  const capacity = ZONES.reduce((a, z) => a + z.occupants, 0);
  const disabled = !canControl || busy;
  const active = Object.entries(overrides);
  const nManual = new Set([...active.map(([k]) => k), ...Object.keys(occupancy).filter((k) => k !== '*')]).size;
  const changed = limit !== params.limitKw || sp !== params.spOccupied;
  const m = snapshot.meter;
  const dr = snapshot.ems?.drActive;
  const manual = new Set([...Object.keys(overrides), ...Object.keys(occupancy).filter((k) => k !== '*')]);

  const quick = (kind: QuickKind) => {
    const cmds: Command[] = OFFICES.map((z) => ({
      kind: 'override',
      cmd:
        kind === 'precool'
          ? { zone: z.id, hvac: 'on', setpoint: 23, durationMin: duration }
          : kind === 'eco'
            ? { zone: z.id, setpoint: 25, lights: 0.7, durationMin: duration }
            : kind === 'shed'
              ? { zone: z.id, lights: 0.6, plugs: 0.85, setpoint: 25, durationMin: duration }
              : { zone: z.id, hvac: 'off', lights: 0, plugs: 0.1, durationMin: duration },
    }));
    onCommand(cmds);
  };

  const spDelta = sp - params.spOccupied;
  return (
    <div className={styles.box} data-testid="ems-building-control">
      <div className={styles.status}>
        <div className={styles.statusMain}>
          <span className={cx(styles.dot, nManual ? styles.dotWarn : styles.dotOk)} />
          {nManual ? `EMS con ${nManual} zona${nManual > 1 ? 's' : ''} en manual` : 'EMS en automático'}
        </div>
        <div className={styles.pills}>
          <span className={cx(styles.pill, dr && styles.pillWarn)}>DR {dr ? 'activo' : 'en espera'}</span>
          <span className={styles.pill}>{m ? `${m.demand15.toFixed(0)} / ${params.limitKw} kW` : '—'}</span>
          <span className={styles.pill}>{live ? 'Node-RED' : 'Simulador'}</span>
        </div>
      </div>
      {!canControl && <div className={styles.warn}>{reason ?? 'Sin permiso para controlar el edificio'}</div>}

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="building" /> Zonas
          <span className={styles.hint}>toca una zona para controlarla</span>
        </div>
        <ZoneMiniMap snapshot={snapshot} manual={manual} onSelect={onSelectZone} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="sliders-v-alt" /> Parámetros del EMS
          {(limit !== DEFAULTS.limitKw || sp !== DEFAULTS.spOccupied) && (
            <Button
              size="sm"
              fill="text"
              variant="secondary"
              onClick={() => {
                setLimit(DEFAULTS.limitKw);
                setSp(DEFAULTS.spOccupied);
              }}
            >
              Valores de diseño
            </Button>
          )}
        </div>
        <Param
          label="Límite de demanda"
          value={limit}
          unit="kW"
          min={20}
          max={50}
          step={1}
          onChange={setLimit}
          note={
            m
              ? `Demanda actual ${m.demand15.toFixed(1)} kW · el limitador rota compresores desde ${(limit - 3).toFixed(0)} kW`
              : `El limitador rota compresores desde ${(limit - 3).toFixed(0)} kW`
          }
        />
        <Param
          label="Setpoint con ocupación"
          value={sp}
          unit="°C"
          min={22}
          max={26}
          step={0.5}
          onChange={setSp}
          note={
            spDelta === 0
              ? `Cada °C más ≈ −${KW_PER_DEG.toFixed(1)} kW de HVAC con el edificio ocupado`
              : `${spDelta > 0 ? 'Ahorro' : 'Aumento'} ≈ ${Math.abs(spDelta * KW_PER_DEG).toFixed(1)} kW de HVAC · ${sp > 25 ? 'confort en el límite' : sp < 23 ? 'sobreenfriamiento' : 'confort ISO 7730 cat. B'}`
          }
        />
        <Button
          size="sm"
          icon="check"
          fullWidth
          disabled={disabled || !changed}
          onClick={() => onCommand({ kind: 'params', params: { limitKw: limit, spOccupied: sp } })}
          data-testid="ems-params-apply"
        >
          {changed ? 'Aplicar parámetros' : 'Sin cambios'}
        </Button>
      </section>

      <section className={styles.card} data-testid="ems-building-occupancy">
        <div className={styles.cardTitle}>
          <Glyph name="users" size={16} /> Personas en el edificio
          <span className={styles.paramValue}>
            {people} <small>/ {capacity}</small>
          </span>
        </div>
        <div className={styles.presets}>
          {OCC_PRESETS.map((p) => (
            <button
              key={p.pct}
              type="button"
              className={cx(styles.preset, pct === p.pct && styles.presetOn)}
              onClick={() => setPct(p.pct)}
              disabled={disabled}
            >
              <b>{p.label}</b>
              <span>{p.pct} %</span>
            </button>
          ))}
        </div>
        <Param
          label="Ocupación respecto al horario normal"
          value={pct}
          unit="%"
          min={0}
          max={200}
          step={10}
          onChange={setPct}
          note={
            pct === 0
              ? 'Edificio vacío: luces apagadas, HVAC en vacancia y standby cortado'
              : `≈ ${Math.round((capacity * pct) / 100)} personas en jornada · ≈ ${((capacity * pct * 0.075) / 100).toFixed(1)} kW de calor de personas${pct > 100 ? ' · sobre el aforo de diseño' : ''}`
          }
        />
        <div className={styles.durationRow}>
          <span className={styles.muted}>Durante</span>
          <RadioButtonGroup
            size="sm"
            value={occDuration}
            onChange={setOccDuration}
            options={[30, 60, 240, 480].map((d) => ({ value: d, label: durationLabel(d) }))}
          />
        </div>
        <div className={styles.durationRow}>
          <Button
            size="sm"
            icon="check"
            disabled={disabled}
            onClick={() => onCommand({ kind: 'occupancy', zone: '*', pct, durationMin: occDuration })}
            data-testid="ems-occupancy-apply"
          >
            Aplicar ocupación
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || !building}
            onClick={() => {
              setPct(100);
              onCommand({ kind: 'occupancy_release', zone: '*' });
            }}
          >
            Según horario
          </Button>
        </div>
        {building && (
          <div className={styles.warn}>
            Edificio al {building.pct} % hasta {fmtTime(building.until)}
          </div>
        )}
        <div className={styles.muted}>Para fijar las personas de una zona, tócala en el plano y usa «Personas».</div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="bolt" /> Acciones rápidas
          <span className={styles.hint}>a todas las zonas no críticas</span>
        </div>
        <div className={styles.durationRow}>
          <span className={styles.muted}>Durante</span>
          <RadioButtonGroup
            size="sm"
            value={duration}
            onChange={setDuration}
            options={QUICK_DURATIONS.map((d) => ({ value: d, label: durationLabel(d) }))}
          />
        </div>
        <div className={styles.tiles}>
          {QUICK.map((q) => (
            <button
              key={q.kind}
              type="button"
              className={styles.tile}
              disabled={disabled}
              onClick={() => quick(q.kind)}
              data-testid={`ems-quick-${q.kind}`}
            >
              <span className={styles.tileGlyph}>
                <Glyph name={q.glyph} size={18} />
              </span>
              <span className={styles.tileTitle}>{q.title}</span>
              <span className={styles.tileDetail}>{q.detail}</span>
              <span className={styles.tileEffect}>{q.effect}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="user" /> En manual ({nManual})
          {nManual > 0 && (
            <Button
              size="sm"
              variant="secondary"
              fill="text"
              disabled={disabled}
              onClick={() =>
                onCommand([
                  { kind: 'release', zone: '*' },
                  ...zoneOcc.map(([id]): Command => ({ kind: 'occupancy_release', zone: id })),
                ])
              }
              data-testid="ems-release-all"
            >
              Todo a automático
            </Button>
          )}
        </div>
        {nManual === 0 && <div className={styles.muted}>Todas las zonas siguen las reglas del EMS.</div>}
        {zoneOcc.map(([id, o]) => (
          <div key={`occ-${id}`} className={styles.item}>
            <button type="button" className={styles.link} onClick={() => onSelectZone(id)}>
              {id} · {o.people} personas
            </button>
            <div className={styles.progress} title={`hasta ${fmtTime(o.until)}`}>
              <div
                style={{
                  width: `${Math.min(1, Math.max(0, (o.until - now) / Math.max(o.until - o.since, 1))) * 100}%`,
                }}
              />
            </div>
            <span className={styles.muted}>{Math.max(0, Math.ceil((o.until - now) / 60_000))} min</span>
            <Button
              size="sm"
              variant="secondary"
              fill="text"
              icon="times"
              disabled={disabled}
              tooltip="Personas según horario"
              aria-label={`Personas de ${id} según horario`}
              onClick={() => onCommand({ kind: 'occupancy_release', zone: id })}
            />
          </div>
        ))}
        {active.map(([id, ov]) => {
          const frac = Math.min(1, Math.max(0, (ov.until - now) / Math.max(ov.until - ov.since, 1)));
          return (
            <div key={id} className={styles.item}>
              <button type="button" className={styles.link} onClick={() => onSelectZone(id)}>
                {id} · {ZONE_BY_ID[id]?.name}
              </button>
              <div className={styles.progress} title={`hasta ${fmtTime(ov.until)}`}>
                <div style={{ width: `${frac * 100}%` }} />
              </div>
              <span className={styles.muted}>{Math.max(0, Math.ceil((ov.until - now) / 60_000))} min</span>
              <Button
                size="sm"
                variant="secondary"
                fill="text"
                icon="times"
                disabled={disabled}
                tooltip="Volver a automático"
                aria-label={`Liberar ${id}`}
                onClick={() => onCommand({ kind: 'release', zone: id })}
              />
            </div>
          );
        })}
      </section>

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="list-ul" /> Registro
        </div>
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
      </section>
    </div>
  );
};

const Param: React.FC<{
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  note: string;
  onChange: (v: number) => void;
}> = ({ label, value, unit, min, max, step, note, onChange }) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.param}>
      <div className={styles.paramHead}>
        <span>{label}</span>
        <span className={styles.paramValue}>
          {value % 1 ? value.toFixed(1) : value} <small>{unit}</small>
        </span>
      </div>
      <div className={styles.stepper}>
        <Button
          size="sm"
          variant="secondary"
          icon="minus"
          aria-label={`Bajar ${label}`}
          onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}
        />
        <input
          type="range"
          className={styles.range}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          aria-label={`Subir ${label}`}
          onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))}
        />
      </div>
      <div className={styles.note}>{note}</div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  status: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(1)};
    border-radius: ${theme.shape.radius.default};
    background: ${colorManipulator.alpha(theme.colors.primary.main, 0.08)};
    border: 1px solid ${colorManipulator.alpha(theme.colors.primary.main, 0.3)};
  `,
  statusMain: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  pills: css`
    display: flex;
    flex-wrap: wrap;
    gap: ${theme.spacing(0.5)};
  `,
  pill: css`
    padding: 0 ${theme.spacing(0.75)};
    border-radius: ${theme.shape.radius.pill};
    border: 1px solid ${theme.colors.border.medium};
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  pillWarn: css`
    border-color: ${theme.colors.warning.border};
    color: ${theme.colors.warning.text};
  `,
  dot: css`
    width: 9px;
    height: 9px;
    border-radius: 50%;
  `,
  dotOk: css`
    background: ${theme.colors.success.main};
  `,
  dotWarn: css`
    background: ${theme.colors.warning.main};
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
  cardTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    font-weight: ${theme.typography.fontWeightMedium};
    & > :last-child:not(:first-child):not(svg) {
      margin-left: auto;
    }
  `,
  hint: css`
    margin-left: auto;
    font-weight: ${theme.typography.fontWeightRegular};
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  presets: css`
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: ${theme.spacing(0.5)};
  `,
  preset: css`
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: ${theme.spacing(0.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    color: ${theme.colors.text.primary};
    font-size: 12px;
    cursor: pointer;
    span {
      font-size: 11px;
      color: ${theme.colors.text.secondary};
    }
    &:hover:not(:disabled) {
      border-color: ${theme.colors.border.strong};
    }
  `,
  presetOn: css`
    border-color: ${theme.colors.primary.main};
    box-shadow: inset 0 0 0 1px ${theme.colors.primary.main};
  `,
  durationRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  param: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
  `,
  paramHead: css`
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  paramValue: css`
    font-size: ${theme.typography.h4.fontSize};
    color: ${theme.colors.text.primary};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
    small {
      font-size: ${theme.typography.bodySmall.fontSize};
      color: ${theme.colors.text.secondary};
    }
  `,
  stepper: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  range: css`
    flex: 1;
    accent-color: ${theme.colors.primary.main};
  `,
  note: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  tiles: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(0.75)};
  `,
  tile: css`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: ${theme.spacing(0.75, 1)};
    text-align: left;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    color: ${theme.colors.text.primary};
    cursor: pointer;
    transition:
      border-color 0.15s,
      transform 0.15s;
    &:hover:not(:disabled) {
      border-color: ${theme.colors.primary.border};
      transform: translateY(-1px);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `,
  tileGlyph: css`
    font-size: 18px;
    line-height: 1;
  `,
  tileTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  tileDetail: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
  tileEffect: css`
    font-size: 11px;
    color: ${theme.colors.primary.text};
  `,
  item: css`
    display: grid;
    grid-template-columns: 1fr 60px auto auto;
    align-items: center;
    gap: ${theme.spacing(0.75)};
  `,
  link: css`
    background: none;
    border: none;
    padding: 0;
    color: ${theme.colors.text.link};
    text-align: left;
    cursor: pointer;
    font-size: ${theme.typography.bodySmall.fontSize};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  progress: css`
    height: 4px;
    border-radius: 2px;
    background: ${theme.colors.border.weak};
    div {
      height: 100%;
      border-radius: 2px;
      background: ${theme.colors.warning.main};
    }
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
