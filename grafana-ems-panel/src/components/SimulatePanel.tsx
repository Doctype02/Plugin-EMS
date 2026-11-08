import React, { useMemo, useState } from 'react';
import { Glyph } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, Icon, RadioButtonGroup, Switch, useStyles2, useTheme2 } from '@grafana/ui';
import { VRF_UNITS, ZONE_BY_ID } from 'building/model';
import { Command, durationLabel } from 'building/control';
import { EVENTS, EventKind, SimEvent, describeEvent, isActive, newEvent } from 'building/events';
import { ASSUMPTIONS, Consequence, freeFloatCurve, projectHeatwave, projectZone } from 'building/projection';
import { SimOptions } from 'building/simulator';
import { Snapshot } from 'building/telemetry';
import { ZoneMiniMap } from './ZoneMiniMap';
import { MiniChart } from './MiniChart';

interface Props {
  now: number;
  snapshot: Snapshot;
  sim: SimOptions;
  events: SimEvent[];
  demoIncidents: boolean;
  canControl: boolean;
  reason?: string;
  live: boolean;
  onCommand: (c: Command | Command[]) => void;
  onDemoIncidents: (v: boolean) => void;
}

const KINDS = Object.keys(EVENTS) as EventKind[];
const EVENT_DURATIONS = [5, 15, 30, 60, 120, 360];
const HOURS = [1, 4, 8, 24, 72];
const DAYS = [1, 3, 7];

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('es-PA', {
    timeZone: 'America/Panama',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** Pestaña «Simular»: inyectar fallas/accidentes y preguntar «¿qué pasaría si…?». */
export const SimulatePanel: React.FC<Props> = (props) => {
  const styles = useStyles2(getStyles);
  const [section, setSection] = useState<'events' | 'whatif'>('events');
  return (
    <div className={styles.box} data-testid="ems-simulate">
      <RadioButtonGroup
        fullWidth
        size="sm"
        value={section}
        onChange={setSection}
        options={[
          { value: 'events', label: 'Alarmas y accidentes', icon: 'fire' },
          { value: 'whatif', label: '¿Qué pasaría si…?', icon: 'question-circle' },
        ]}
      />
      {section === 'events' ? <EventsSection {...props} /> : <WhatIfSection {...props} />}
    </div>
  );
};

const EventsSection: React.FC<Props> = ({
  now,
  snapshot,
  events,
  demoIncidents,
  canControl,
  reason,
  live,
  onCommand,
  onDemoIncidents,
}) => {
  const styles = useStyles2(getStyles);
  const [kind, setKind] = useState<EventKind>();
  const [zone, setZone] = useState<string>();
  const [unit, setUnit] = useState<string>(VRF_UNITS[0].id);
  const [minutes, setMinutes] = useState(30);
  const [intensity, setIntensity] = useState<number>();
  const def = kind ? EVENTS[kind] : undefined;
  const active = events.filter((e) => isActive(e, now));
  const pending = events.filter((e) => e.start > now);
  const allowed = (id: string) => !!def && def.target === 'zona' && (def.zones?.(id) ?? true);
  const ready = !!def && (def.target !== 'zona' || (zone && allowed(zone)));

  const pick = (k: EventKind) => {
    setKind(k);
    setMinutes(Math.min(EVENTS[k].defaultMinutes, 360));
    setIntensity(EVENTS[k].intensity?.value);
    if (zone && EVENTS[k].zones && !EVENTS[k].zones!(zone)) {
      setZone(undefined);
    }
  };
  const start = () => {
    if (!def || !kind) {
      return;
    }
    const ev = newEvent(kind, now, minutes, {
      zone: def.target === 'zona' ? zone : undefined,
      unit: def.target === 'unidad' ? unit : undefined,
      intensity: def.intensity ? intensity : undefined,
    });
    onCommand({ kind: 'event', event: ev });
  };

  return (
    <>
      {!canControl && <div className={styles.permission}>{reason}</div>}
      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="fire" /> 1. Elige qué ocurre
        </div>
        <div className={styles.kinds}>
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={cx(styles.kind, kind === k && styles.kindOn, styles[EVENTS[k].level])}
              onClick={() => pick(k)}
              data-testid={`ems-event-${k}`}
            >
              <Glyph name={EVENTS[k].glyph} size={16} className={styles[`ico_${EVENTS[k].level}`]} />
              {EVENTS[k].label}
            </button>
          ))}
        </div>
        {def && <div className={styles.desc}>{def.description}</div>}
      </section>

      {def && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            <Icon name="crosshair" /> 2. Dónde y cuánto
          </div>
          {def.target === 'zona' && (
            <>
              <ZoneMiniMap snapshot={snapshot} selected={zone} disabled={(id) => !allowed(id)} onSelect={setZone} />
              <div className={styles.muted}>
                {zone ? `${zone} · ${ZONE_BY_ID[zone]?.name}` : 'Toca una zona del plano'}
              </div>
            </>
          )}
          {def.target === 'unidad' && (
            <RadioButtonGroup
              size="sm"
              value={unit}
              onChange={setUnit}
              options={VRF_UNITS.map((u) => ({
                value: u.id,
                label: u.id,
                description: `${u.capacityKw.toFixed(1)} kW · ${u.zones.join(', ')}`,
              }))}
            />
          )}
          {def.target === 'edificio' && <div className={styles.muted}>Afecta a todo el edificio.</div>}
          {def.intensity && intensity !== undefined && (
            <div className={styles.param}>
              <div className={styles.paramHead}>
                <span>{def.intensity.label}</span>
                <b>
                  {intensity} {def.intensity.unit}
                </b>
              </div>
              <input
                type="range"
                className={styles.range}
                min={def.intensity.min}
                max={def.intensity.max}
                step={def.intensity.step}
                value={intensity}
                aria-label={def.intensity.label}
                onChange={(e) => setIntensity(Number(e.currentTarget.value))}
              />
            </div>
          )}
          <div className={styles.paramHead}>Duración (tiempo simulado)</div>
          <RadioButtonGroup
            size="sm"
            value={minutes}
            onChange={setMinutes}
            options={EVENT_DURATIONS.map((d) => ({ value: d, label: durationLabel(d) }))}
          />
          <Button
            icon="play"
            variant={def.level === 'crit' ? 'destructive' : 'primary'}
            fullWidth
            disabled={!canControl || !ready}
            onClick={start}
            data-testid="ems-event-start"
          >
            {ready ? `Simular ${def.label.toLowerCase()}` : 'Elige una zona'}
          </Button>
          {live && (
            <div className={styles.muted}>En vivo el evento se envía al gemelo digital (Node-RED → simulador).</div>
          )}
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardTitle}>
          <Icon name="bell" /> Eventos activos ({active.length})
          {active.length > 0 && (
            <Button
              size="sm"
              fill="text"
              variant="secondary"
              disabled={!canControl}
              onClick={() => onCommand({ kind: 'event_stop', id: '*' })}
            >
              Terminar todos
            </Button>
          )}
        </div>
        {active.length + pending.length === 0 && (
          <div className={styles.muted}>Ninguno. El edificio opera con normalidad.</div>
        )}
        {[...active, ...pending].map((e) => {
          const frac = Math.min(1, Math.max(0, (now - e.start) / (e.end - e.start)));
          return (
            <div key={e.id} className={styles.active}>
              <Glyph name={EVENTS[e.kind].glyph} size={16} className={styles[`ico_${EVENTS[e.kind].level}`]} />
              <div className={styles.activeText}>
                <div>{describeEvent(e)}</div>
                <div className={styles.progress}>
                  <div style={{ width: `${frac * 100}%` }} className={styles[`fill_${EVENTS[e.kind].level}`]} />
                </div>
                <div className={styles.muted}>
                  {fmtTime(e.start)} → {fmtTime(e.end)}
                </div>
              </div>
              <Button
                size="sm"
                fill="text"
                variant="secondary"
                icon="times"
                aria-label="Terminar"
                tooltip="Terminar el evento"
                disabled={!canControl}
                onClick={() => onCommand({ kind: 'event_stop', id: e.id })}
              />
            </div>
          );
        })}
        {!live && (
          <div className={styles.switchRow}>
            <Switch value={demoIncidents} onChange={(e) => onDemoIncidents(e.currentTarget.checked)} />
            <span className={styles.muted}>
              Incidentes de demostración diarios (sensor Z02, falla Z06, sobreocupación Z03)
            </span>
          </div>
        )}
      </section>
    </>
  );
};

type WhatIf = 'hold' | 'loss' | 'heat';

const WhatIfSection: React.FC<Props> = ({ now, snapshot, sim, canControl, onCommand }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [mode, setMode] = useState<WhatIf>('hold');
  const [zone, setZone] = useState('Z04');
  const [temp, setTemp] = useState(28);
  const [hours, setHours] = useState(8);
  const [days, setDays] = useState(3);
  const [delta, setDelta] = useState(4);
  const [horizon, setHorizon] = useState(4);

  const hold = useMemo(() => (mode === 'hold' ? projectZone(zone, temp, hours) : undefined), [mode, zone, temp, hours]);
  // la curva de pérdida y la ola de calor dependen del instante: se recalculan por bloques de 15 min
  const bucket = Math.floor(now / 900_000) * 900_000;
  const loss = useMemo(
    () => (mode === 'loss' ? freeFloatCurve(zone, bucket, horizon, sim) : undefined),
    [mode, zone, horizon, bucket, sim]
  );
  const heat = useMemo(
    () => (mode === 'heat' ? projectHeatwave(bucket, days * 24, delta, sim) : undefined),
    [mode, days, delta, bucket, sim]
  );

  return (
    <>
      <RadioButtonGroup
        size="sm"
        fullWidth
        value={mode}
        onChange={setMode}
        options={[
          { value: 'hold', label: 'Temperatura sostenida', description: 'Una zona a X °C durante H horas' },
          { value: 'loss', label: 'Sin enfriamiento', description: '¿Cuánto tarda en calentarse si falla el VRF?' },
          { value: 'heat', label: 'Ola de calor', description: 'El exterior más caliente durante días' },
        ]}
      />

      {mode !== 'heat' && (
        <section className={styles.card}>
          <ZoneMiniMap snapshot={snapshot} selected={zone} onSelect={setZone} />
          <div className={styles.muted}>
            {zone} · {ZONE_BY_ID[zone]?.name} — toca otra zona del plano para cambiarla
          </div>
          {mode === 'hold' && (
            <div className={styles.param}>
              <div className={styles.paramHead}>
                <span>Temperatura de la zona</span>
                <b className={styles.big}>{temp.toFixed(1)} °C</b>
              </div>
              <input
                type="range"
                className={styles.range}
                min={18}
                max={36}
                step={0.5}
                value={temp}
                aria-label="Temperatura de la zona"
                onChange={(e) => setTemp(Number(e.currentTarget.value))}
              />
            </div>
          )}
          <div className={styles.paramHead}>{mode === 'hold' ? 'Durante' : 'Horizonte'}</div>
          <RadioButtonGroup
            size="sm"
            value={mode === 'hold' ? hours : horizon}
            onChange={mode === 'hold' ? setHours : setHorizon}
            options={(mode === 'hold' ? HOURS : [1, 2, 4, 8]).map((h) => ({
              value: h,
              label: h < 24 ? `${h} h` : `${h / 24} d`,
            }))}
          />
        </section>
      )}

      {hold && (
        <section className={styles.card}>
          <div className={styles.stats}>
            {hold.it ? (
              <>
                <Stat
                  label="Fallas de equipos"
                  value={`×${hold.it.xFactor.toFixed(2)}`}
                  tone={hold.it.cls === 'recomendado' ? 'ok' : 'warn'}
                />
                <Stat
                  label="Vida de baterías"
                  value={`${(hold.it.batteryLife * 100).toFixed(0)} %`}
                  tone={hold.it.batteryLife < 0.7 ? 'warn' : 'ok'}
                />
              </>
            ) : (
              <>
                <Stat
                  label="Insatisfechos (PPD)"
                  value={`${hold.ppd.toFixed(0)} %`}
                  tone={hold.ppd > 20 ? 'crit' : hold.ppd > 10 ? 'warn' : 'ok'}
                />
                <Stat
                  label="Rendimiento"
                  value={`−${hold.productivityLoss.toFixed(0)} %`}
                  tone={hold.productivityLoss >= 6 ? 'crit' : hold.productivityLoss > 0 ? 'warn' : 'ok'}
                />
              </>
            )}
            <Stat
              label={hold.energyKwh >= 0 ? 'Energía extra' : 'Energía ahorrada'}
              value={`${Math.abs(hold.energyKwh).toFixed(1)} kWh`}
              tone={hold.energyKwh > 2 ? 'warn' : 'ok'}
            />
            <Stat
              label="Costo neto"
              value={`${(hold.energyUsd + hold.productivityUsd).toFixed(0)} USD`}
              tone={hold.energyUsd + hold.productivityUsd > 20 ? 'warn' : 'ok'}
            />
          </div>
          <Consequences items={hold.consequences} />
          <div className={styles.foot}>
            PMV/PPD ISO 7730 (1.1 met, 0.5 clo, HR {ASSUMPTIONS.rh} %), Seppänen 2006, ASHRAE TC 9.9, IEEE 1188 ·{' '}
            {ASSUMPTIONS.wageUsdH} USD/h · {ASSUMPTIONS.priceUsdKwh} USD/kWh
          </div>
        </section>
      )}

      {loss && (
        <section className={styles.card}>
          <div className={styles.cardTitle}>
            <Icon name="arrow-up" /> {ZONE_BY_ID[zone].name}: sin enfriamiento desde {fmtTime(bucket)}
          </div>
          <MiniChart
            series={[{ name: 'Temperatura', color: theme.visualization.getColorByName('orange'), points: loss.series }]}
            rules={loss.thresholds.map((t, i) => ({
              y: t.temp,
              label: `${t.temp} °C`,
              color: theme.visualization.getColorByName(['yellow', 'orange', 'red'][i]),
            }))}
            xLabel={(h) => (h < 1 ? `${Math.round(h * 60)}′` : `${h.toFixed(1)} h`)}
            yUnit="°C"
          />
          {loss.thresholds.map((t) => (
            <div key={t.temp} className={styles.threshold}>
              <b>{t.temp} °C</b>
              <span>{t.label}</span>
              <span className={styles.when}>
                {t.minutes === undefined ? 'no se alcanza' : t.minutes < 1 ? 'ya' : `en ${fmtMin(t.minutes)}`}
              </span>
            </div>
          ))}
          <div className={styles.muted}>
            Modelo RC de la zona (τ = constante de tiempo del gemelo calibrado) con las ganancias de este instante.
            Final: {loss.final.toFixed(1)} °C.
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon="play"
            disabled={!canControl}
            onClick={() => onCommand({ kind: 'event', event: newEvent('falla_terminal', now, horizon * 60, { zone }) })}
          >
            Simularlo en el edificio
          </Button>
        </section>
      )}

      {mode === 'heat' && (
        <section className={styles.card}>
          <div className={styles.param}>
            <div className={styles.paramHead}>
              <span>Exterior más caliente</span>
              <b className={styles.big}>+{delta} °C</b>
            </div>
            <input
              type="range"
              className={styles.range}
              min={1}
              max={8}
              step={0.5}
              value={delta}
              aria-label="Aumento de temperatura exterior"
              onChange={(e) => setDelta(Number(e.currentTarget.value))}
            />
          </div>
          <RadioButtonGroup
            size="sm"
            value={days}
            onChange={setDays}
            options={DAYS.map((d) => ({ value: d, label: `${d} día${d > 1 ? 's' : ''}` }))}
          />
        </section>
      )}
      {heat && (
        <section className={styles.card}>
          <div className={styles.stats}>
            <Stat label="Energía extra" value={`+${(heat.energyHot - heat.energyBase).toFixed(0)} kWh`} tone="warn" />
            <Stat label="Costo extra" value={`${heat.costUsd.toFixed(0)} USD`} tone="warn" />
            <Stat
              label="Pico"
              value={`${heat.peakHot.toFixed(1)} kW`}
              tone={heat.peakHot > sim.limitKw ? 'crit' : 'ok'}
            />
            <Stat
              label="Horas > límite"
              value={`${heat.hoursOverLimit.toFixed(0)} h`}
              tone={heat.hoursOverLimit > 0 ? 'crit' : 'ok'}
            />
          </div>
          <MiniChart
            series={[
              {
                name: 'Normal',
                color: theme.colors.text.secondary,
                points: heat.series.map((s) => [s.t, s.base]),
                dashed: true,
              },
              {
                name: `+${delta} °C`,
                color: theme.visualization.getColorByName('red'),
                points: heat.series.map((s) => [s.t, s.hot]),
              },
            ]}
            rules={[{ y: sim.limitKw, label: `límite ${sim.limitKw} kW`, color: theme.colors.warning.text }]}
            xLabel={(t) => `${Math.round((t - bucket) / 3_600_000)} h`}
            yUnit="kW"
          />
          <Consequences
            items={[
              {
                level: heat.hoursOverLimit > 0 ? 'warn' : 'ok',
                title:
                  heat.hoursOverLimit > 0
                    ? 'El limitador de demanda trabajará más'
                    : 'La demanda se mantiene bajo el límite',
                detail:
                  heat.hoursOverLimit > 0
                    ? `${heat.hoursOverLimit.toFixed(0)} h por encima de ${sim.limitKw} kW sin limitador: rotación de compresores y posible pérdida de confort en zonas soleadas.`
                    : 'El EMS absorbe la carga extra con los equipos actuales.',
              },
              {
                level: 'info',
                title: `+${(((heat.energyHot - heat.energyBase) / Math.max(heat.energyBase, 1)) * 100).toFixed(0)} % de consumo`,
                detail: 'Pre-enfriar temprano (fuera de punta) y subir el setpoint 1 °C compensan parte del aumento.',
              },
            ]}
          />
          <Button
            size="sm"
            variant="secondary"
            icon="play"
            disabled={!canControl}
            onClick={() =>
              onCommand({ kind: 'event', event: newEvent('ola_calor', now, days * 24 * 60, { intensity: delta }) })
            }
          >
            Aplicarla al edificio
          </Button>
        </section>
      )}
    </>
  );
};

const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);

const Stat: React.FC<{ label: string; value: string; tone: 'ok' | 'warn' | 'crit' }> = ({ label, value, tone }) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={cx(styles.stat, styles[`tone_${tone}`])}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
};

const ICON: Record<Consequence['level'], string> = { ok: '✓', info: 'ℹ', warn: '!', crit: '‼' };

const Consequences: React.FC<{ items: Consequence[] }> = ({ items }) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.cons}>
      {items.map((c) => (
        <div key={c.title} className={cx(styles.con, styles[`con_${c.level}`])}>
          <span className={styles.conIcon}>{ICON[c.level]}</span>
          <div>
            <div className={styles.conTitle}>{c.title}</div>
            <div className={styles.conDetail}>{c.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const tone = (c: string) => css`
    border-color: ${colorManipulator.alpha(c, 0.5)};
    background: ${colorManipulator.alpha(c, 0.08)};
  `;
  return {
    box: css`
      display: flex;
      flex-direction: column;
      gap: ${theme.spacing(1)};
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
      & > button {
        margin-left: auto;
      }
    `,
    kinds: css`
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: ${theme.spacing(0.5)};
    `,
    kind: css`
      display: flex;
      align-items: center;
      gap: ${theme.spacing(0.75)};
      padding: ${theme.spacing(0.5, 0.75)};
      border: 1px solid ${theme.colors.border.weak};
      border-left-width: 3px;
      border-radius: ${theme.shape.radius.default};
      background: ${theme.colors.background.primary};
      color: ${theme.colors.text.primary};
      font-size: ${theme.typography.bodySmall.fontSize};
      text-align: left;
      cursor: pointer;
      &:hover {
        border-color: ${theme.colors.border.strong};
      }
    `,
    kindOn: css`
      outline: 2px solid ${theme.colors.primary.main};
      outline-offset: -1px;
    `,
    crit: css`
      border-left-color: ${theme.colors.error.main};
    `,
    warn: css`
      border-left-color: ${theme.colors.warning.main};
    `,
    info: css`
      border-left-color: ${theme.colors.info.main};
    `,
    fill_crit: css`
      background: ${theme.colors.error.main};
    `,
    fill_warn: css`
      background: ${theme.colors.warning.main};
    `,
    fill_info: css`
      background: ${theme.colors.info.main};
    `,
    permission: css`
      color: ${theme.colors.warning.text};
      font-size: ${theme.typography.bodySmall.fontSize};
    `,
    ico_crit: css`
      color: ${theme.colors.error.text};
    `,
    ico_warn: css`
      color: ${theme.colors.warning.text};
    `,
    ico_info: css`
      color: ${theme.colors.info.text};
    `,
    glyph: css`
      font-size: 16px;
      line-height: 1;
    `,
    desc: css`
      font-size: 12px;
      color: ${theme.colors.text.secondary};
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
      b {
        color: ${theme.colors.text.primary};
      }
    `,
    select: css`
      min-width: 0;
      & > * {
        width: 100% !important;
        max-width: 100%;
      }
    `,
    big: css`
      font-size: ${theme.typography.h4.fontSize};
      font-variant-numeric: tabular-nums;
    `,
    range: css`
      width: 100%;
      accent-color: ${theme.colors.primary.main};
    `,
    active: css`
      display: flex;
      align-items: flex-start;
      gap: ${theme.spacing(0.75)};
      font-size: ${theme.typography.bodySmall.fontSize};
    `,
    activeText: css`
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    `,
    progress: css`
      height: 4px;
      border-radius: 2px;
      background: ${theme.colors.border.weak};
      div {
        height: 100%;
        border-radius: 2px;
      }
    `,
    switchRow: css`
      display: flex;
      align-items: center;
      gap: ${theme.spacing(1)};
      margin-top: ${theme.spacing(0.5)};
    `,
    stats: css`
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: ${theme.spacing(0.5)};
    `,
    stat: css`
      padding: ${theme.spacing(0.5, 0.75)};
      border: 1px solid ${theme.colors.border.weak};
      border-radius: ${theme.shape.radius.default};
    `,
    tone_ok: tone(theme.colors.success.main),
    tone_warn: tone(theme.colors.warning.main),
    tone_crit: tone(theme.colors.error.main),
    statLabel: css`
      font-size: 11px;
      color: ${theme.colors.text.secondary};
    `,
    statValue: css`
      font-size: ${theme.typography.h5.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      font-variant-numeric: tabular-nums;
    `,
    cons: css`
      display: flex;
      flex-direction: column;
      gap: ${theme.spacing(0.5)};
    `,
    con: css`
      display: flex;
      gap: ${theme.spacing(0.75)};
      padding: ${theme.spacing(0.5, 0.75)};
      border: 1px solid ${theme.colors.border.weak};
      border-radius: ${theme.shape.radius.default};
    `,
    con_ok: tone(theme.colors.success.main),
    con_info: tone(theme.colors.info.main),
    con_warn: tone(theme.colors.warning.main),
    con_crit: tone(theme.colors.error.main),
    conIcon: css`
      width: 16px;
      text-align: center;
      font-weight: 700;
    `,
    conTitle: css`
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
    `,
    conDetail: css`
      font-size: 11px;
      color: ${theme.colors.text.secondary};
    `,
    threshold: css`
      display: grid;
      grid-template-columns: 44px 1fr auto;
      gap: ${theme.spacing(0.75)};
      font-size: ${theme.typography.bodySmall.fontSize};
    `,
    when: css`
      font-variant-numeric: tabular-nums;
      color: ${theme.colors.warning.text};
    `,
    foot: css`
      font-size: 10px;
      color: ${theme.colors.text.disabled};
    `,
    muted: css`
      font-size: 11px;
      color: ${theme.colors.text.secondary};
    `,
  };
};
