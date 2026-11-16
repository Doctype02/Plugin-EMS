import React, { useState } from 'react';
import { Glyph, GlyphName } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, Icon, RadioButtonGroup, useStyles2 } from '@grafana/ui';
import { LIMIT_KW, LIMIT_RANGE, ZONES, ZONE_BY_ID, thermal } from 'building/model';
import {
  Command,
  CommandResult,
  LogEntry,
  SP_RANGE,
  SendFeedback,
  durationLabel,
  validateParams,
} from 'building/control';
import { ConfirmInline, NumberParam, SendStatus } from './controls';
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
  /** Resultado del último envío (enviando / aplicado / error). */
  feedback?: SendFeedback;
  onDismissFeedback?: () => void;
  live: boolean;
  onCommand: (c: Command | Command[]) => Promise<CommandResult> | void;
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
const DEFAULTS: EmsParams = { limitKw: LIMIT_KW, spOccupied: 24 };

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
  feedback,
  onDismissFeedback,
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
  /** Acción de impacto pendiente de confirmar. */
  const [pending, setPending] = useState<'params' | 'occupancy' | 'release' | QuickKind>();
  const zoneOcc = Object.entries(occupancy).filter(([k]) => k !== '*');
  const people = ZONES.reduce((a, z) => a + (snapshot.zones[z.id]?.occupants ?? 0), 0);
  const capacity = ZONES.reduce((a, z) => a + z.occupants, 0);
  const disabled = !canControl || busy;
  const active = Object.entries(overrides);
  const nManual = new Set([...active.map(([k]) => k), ...Object.keys(occupancy).filter((k) => k !== '*')]).size;
  const changed = limit !== params.limitKw || sp !== params.spOccupied;
  const paramsError = changed ? validateParams({ limitKw: limit, spOccupied: sp }) : undefined;
  const confirm = (c: Command | Command[]) => {
    setPending(undefined);
    onCommand(c);
  };
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
    confirm(cmds);
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
      <SendStatus busy={busy} feedback={feedback} onDismiss={onDismissFeedback} />
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
        <NumberParam
          label="Límite de demanda"
          value={limit}
          current={params.limitKw}
          unit="kW"
          min={LIMIT_RANGE[0]}
          max={LIMIT_RANGE[1]}
          step={1}
          disabled={disabled}
          onChange={setLimit}
          testId="ems-param-limit"
          note={
            m
              ? `Potencia máxima del edificio: ${LIMIT_KW} kW · demanda actual ${m.demand15.toFixed(1)} kW · el limitador rota compresores desde ${(limit - 3).toFixed(0)} kW`
              : `Potencia máxima del edificio: ${LIMIT_KW} kW · el limitador rota compresores desde ${(limit - 3).toFixed(0)} kW`
          }
        />
        <NumberParam
          label="Setpoint con ocupación"
          value={sp}
          current={params.spOccupied}
          unit="°C"
          min={SP_RANGE[0]}
          max={SP_RANGE[1]}
          step={0.5}
          disabled={disabled}
          onChange={setSp}
          testId="ems-param-sp"
          note={
            spDelta === 0 || !Number.isFinite(spDelta)
              ? `Cada °C más ≈ −${KW_PER_DEG.toFixed(1)} kW de HVAC con el edificio ocupado`
              : `${spDelta > 0 ? 'Ahorro' : 'Aumento'} ≈ ${Math.abs(spDelta * KW_PER_DEG).toFixed(1)} kW de HVAC · ${sp > 26 ? 'fuera de confort' : sp > 25 ? 'confort en el límite' : sp < 23 ? 'sobreenfriamiento' : 'confort ISO 7730 cat. B'}`
          }
        />
        {pending === 'params' ? (
          <ConfirmInline
            title="¿Aplicar los nuevos parámetros del EMS?"
            detail={[
              limit !== params.limitKw ? `Límite ${params.limitKw} → ${limit} kW` : undefined,
              sp !== params.spOccupied ? `Setpoint ${params.spOccupied} → ${sp} °C` : undefined,
              live ? 'Se envía a Node-RED y afecta a todo el edificio.' : 'Se aplica al simulador.',
            ]
              .filter(Boolean)
              .join(' · ')}
            confirmLabel="Aplicar"
            busy={busy}
            onCancel={() => setPending(undefined)}
            onConfirm={() => confirm({ kind: 'params', params: { limitKw: limit, spOccupied: sp } })}
            testId="ems-params-confirm"
          />
        ) : (
          <div className={styles.actionsRow}>
            <Button
              size="sm"
              icon={busy ? undefined : 'check'}
              disabled={disabled || !changed || !!paramsError}
              tooltip={paramsError}
              onClick={() => setPending('params')}
              data-testid="ems-params-apply"
            >
              {busy ? 'Enviando…' : changed ? 'Aplicar parámetros' : 'Sin cambios'}
            </Button>
            {changed && (
              <Button
                size="sm"
                variant="secondary"
                fill="outline"
                disabled={busy}
                onClick={() => {
                  setLimit(params.limitKw);
                  setSp(params.spOccupied);
                }}
              >
                Descartar
              </Button>
            )}
          </div>
        )}
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
        <NumberParam
          label="Ocupación respecto al horario"
          disabled={disabled}
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
        {pending === 'occupancy' && (
          <ConfirmInline
            title={`¿Fijar la ocupación del edificio al ${pct} %?`}
            detail={`Durante ${durationLabel(occDuration)} · ≈ ${Math.round((capacity * pct) / 100)} personas en jornada`}
            confirmLabel="Fijar ocupación"
            busy={busy}
            onCancel={() => setPending(undefined)}
            onConfirm={() => confirm({ kind: 'occupancy', zone: '*', pct, durationMin: occDuration })}
            testId="ems-occupancy-confirm"
          />
        )}
        <div className={styles.durationRow}>
          <Button
            size="sm"
            icon="check"
            disabled={disabled || pending === 'occupancy'}
            onClick={() => setPending('occupancy')}
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
              className={cx(styles.tile, pending === q.kind && styles.tileOn)}
              disabled={disabled}
              aria-pressed={pending === q.kind}
              onClick={() => setPending(pending === q.kind ? undefined : q.kind)}
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
        {QUICK.filter((q) => q.kind === pending).map((q) => (
          <ConfirmInline
            key={q.kind}
            title={`¿${q.title} en ${OFFICES.length} zonas durante ${durationLabel(duration)}?`}
            detail={`${q.detail}. Las zonas pasan a control manual (prioridad sobre el EMS y el limitador).`}
            confirmLabel={q.title}
            destructive={q.kind === 'night'}
            busy={busy}
            onCancel={() => setPending(undefined)}
            onConfirm={() => quick(q.kind)}
            testId="ems-quick-confirm"
          />
        ))}
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
              onClick={() => setPending('release')}
              data-testid="ems-release-all"
            >
              Todo a automático
            </Button>
          )}
        </div>
        {pending === 'release' && nManual > 0 && (
          <ConfirmInline
            title={`¿Devolver ${nManual} zona${nManual > 1 ? 's' : ''} al control automático?`}
            detail="Se cancelan los overrides y las personas fijadas; el EMS vuelve a aplicar sus reglas."
            confirmLabel="Todo a automático"
            busy={busy}
            onCancel={() => setPending(undefined)}
            onConfirm={() =>
              confirm([
                { kind: 'release', zone: '*' },
                ...zoneOcc.map(([id]): Command => ({ kind: 'occupancy_release', zone: id })),
              ])
            }
            testId="ems-release-confirm"
          />
        )}
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
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.25)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  cardTitle: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    min-height: 24px;
    font-size: ${theme.typography.h6.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    & > :last-child:not(:first-child):not(svg) {
      margin-left: auto;
    }
  `,
  hint: css`
    margin-left: auto;
    font-weight: ${theme.typography.fontWeightRegular};
    font-size: ${theme.typography.bodySmall.fontSize};
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
  tileOn: css`
    border-color: ${theme.colors.primary.main};
    box-shadow: inset 0 0 0 1px ${theme.colors.primary.main};
  `,
  actionsRow: css`
    display: flex;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
    & > button:first-child {
      flex: 1;
      justify-content: center;
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
    font-size: ${theme.typography.bodySmall.fontSize};
    line-height: 1.3;
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
