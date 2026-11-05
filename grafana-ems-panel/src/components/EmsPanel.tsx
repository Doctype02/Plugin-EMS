import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GrafanaTheme2, PanelProps } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, IconButton, RadioButtonGroup, Tab, TabsBar, useStyles2, useTheme2 } from '@grafana/ui';
import { config } from '@grafana/runtime';
import { EmsOptions } from 'types';
import { BUILDING, FLOORS, ZONES, ZONE_BY_ID, Zone } from 'building/model';
import { Azimuth, IsoConfig } from 'building/iso';
import { SimOptions, simulate, simulateHistory } from 'building/simulator';
import { EmsParams, History, Overrides, Snapshot, Status, snapshotFromFrames, zoneStatuses } from 'building/telemetry';
import { Command, LogEntry, applyLocal, describe, prune, sendToNodeRed, validate } from 'building/control';
import { MAX_POWER_DENSITY, ViewMode, legendFor } from 'building/views';
import { AlarmList, alarmKey } from './AlarmList';
import { Building3D } from './Building3D';
import { BuildingControl } from './BuildingControl';
import { ZoneControl } from './ZoneControl';
import { Header, Kpi } from './Header';
import { Legend } from './Legend';
import { MeterCard } from './MeterCard';
import { ZoneDetail } from './ZoneDetail';
import { ZoneTooltip } from './ZoneTooltip';
import { useStatusColors } from './useStatusColors';

interface Props extends PanelProps<EmsOptions> {}

const SIDEBAR_MIN_PANEL_WIDTH = 900;
const DAY = 86_400_000;
const PANAMA_OFFSET = -5 * 3_600_000;

/** En demo el día simulado avanza `speed` veces más rápido que el real (1 = hora real de Panamá). */
export function demoTime(now: number, speed: number): number {
  if (speed <= 1) {
    return now;
  }
  const dayStart = Math.floor((now + PANAMA_OFFSET) / DAY) * DAY - PANAMA_OFFSET;
  return dayStart + (((now - dayStart) * speed) % DAY);
}

function useSnapshot(props: Props, sim: SimOptions): { snapshot: Snapshot; history: History; now: number } {
  const { options, data } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!options.demoMode) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), Math.max(1, options.refreshSeconds) * 1000);
    return () => clearInterval(timer);
  }, [options.demoMode, options.refreshSeconds]);

  const simT = demoTime(now, options.demoSpeed);
  const demo = useMemo(
    () =>
      options.demoMode
        ? { snapshot: simulate(simT, sim), history: simulateHistory(simT, 2 * 3_600_000, 37, sim) }
        : undefined,
    [options.demoMode, simT, sim]
  );
  const real = useMemo(
    () => (options.demoMode ? undefined : snapshotFromFrames(data.series)),
    [options.demoMode, data.series]
  );
  const result = demo ?? real!;
  return { ...result, now: options.demoMode ? simT : result.snapshot.time || now };
}

/** Sólo Editor/Admin de la organización (o administrador de Grafana) pueden enviar comandos. */
export function controlPermission(allow: boolean): { canControl: boolean; reason?: string } {
  if (!allow) {
    return { canControl: false, reason: 'El control está deshabilitado en las opciones del panel' };
  }
  const user = config?.bootData?.user;
  // sin información de rol (fuera de Grafana: pruebas, vista previa) no se bloquea
  if (!user || !user.orgRole) {
    return { canControl: true };
  }
  if (user.isGrafanaAdmin || user.orgRole === 'Admin' || user.orgRole === 'Editor') {
    return { canControl: true };
  }
  return { canControl: false, reason: 'Se requiere rol Editor o Admin para controlar el edificio' };
}

function useFullscreen(ref: React.RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement === ref.current && ref.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      ref.current?.requestFullscreen().catch(() => undefined);
    }
  }, [ref]);
  return { active, toggle };
}

const fmt = (v: number | undefined, d: number, unit: string) =>
  v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)} ${unit}`;

export function buildKpis(
  snapshot: Snapshot,
  statuses: Record<string, Status>,
  viewMode: ViewMode,
  limitKw: number
): Kpi[] {
  const m = snapshot.meter;
  const zs = ZONES.map((z) => snapshot.zones[z.id]).filter((s) => s && Number.isFinite(s.temp));
  const limit = snapshot.ems?.limitKw || limitKw;
  const demandStatus: Status = !m
    ? 'offline'
    : m.demand15 > limit
      ? 'critical'
      : m.demand15 > limit * 0.95
        ? 'warning'
        : 'ok';
  const occupants = zs.reduce((a, s) => a + s.occupants, 0);
  const capacity = ZONES.reduce((a, z) => a + z.occupants, 0);
  const alarmCount = snapshot.alarms.filter((a) => a.level !== 'info').length;
  const alarmStatus: Status = snapshot.alarms.some((a) => a.level === 'crit')
    ? 'critical'
    : alarmCount
      ? 'warning'
      : 'ok';
  const occupied = ZONES.filter((z) => snapshot.zones[z.id]?.occupied);
  const outOfComfort = occupied.filter((z) => statuses[z.id] === 'warning' || statuses[z.id] === 'critical').length;
  const hvacZones = ZONES.filter((z) => !z.critical);
  const compressors = hvacZones.filter((z) => snapshot.zones[z.id]?.hvacOn).length;
  const forced = hvacZones.filter((z) => snapshot.zones[z.id]?.drForced).length;

  switch (viewMode) {
    case 'temperature':
      return [
        { label: 'T exterior', icon: 'cloud', value: fmt(m?.tExt, 1, '°C'), status: m ? 'ok' : 'offline' },
        {
          label: 'T media ocupadas',
          icon: 'fire',
          value: fmt(
            occupied.length ? occupied.reduce((a, z) => a + snapshot.zones[z.id].temp, 0) / occupied.length : undefined,
            1,
            '°C'
          ),
          status: outOfComfort ? 'warning' : 'ok',
        },
        {
          label: 'Fuera de confort',
          icon: 'exclamation-triangle',
          value: `${outOfComfort} / ${occupied.length}`,
          status: outOfComfort ? 'warning' : 'ok',
        },
        { label: 'HR exterior', icon: 'cloud', value: fmt(m?.rh, 0, '%'), status: m ? 'ok' : 'offline' },
      ];
    case 'occupancy':
      return [
        {
          label: 'Personas',
          icon: 'users-alt',
          value: `${occupants} / ${capacity}`,
          status: zs.length ? 'ok' : 'offline',
        },
        { label: 'Zonas ocupadas', icon: 'building', value: `${occupied.length} / ${ZONES.length}`, status: 'ok' },
        { label: 'Iluminación', icon: 'lightbulb-alt', value: fmt(m?.pLights, 1, 'kW'), status: m ? 'ok' : 'offline' },
        { label: 'Alarmas', icon: 'bell', value: String(alarmCount), status: alarmStatus },
      ];
    case 'power':
      return [
        { label: 'Potencia', icon: 'bolt', value: fmt(m?.pTotal, 1, 'kW'), status: demandStatus },
        {
          label: 'Factor potencia',
          icon: 'percentage',
          value: fmt(m?.pf, 3, ''),
          status: !m ? 'offline' : m.pf < 0.9 ? 'warning' : 'ok',
        },
        { label: 'Corriente 480 V', icon: 'plug', value: fmt(m?.i, 0, 'A'), status: m ? 'ok' : 'offline' },
        { label: 'Energía hoy', icon: 'chart-line', value: fmt(m?.eKwh, 0, 'kWh'), status: m ? 'ok' : 'offline' },
      ];
    case 'lighting':
      return [
        { label: 'P iluminación', icon: 'bolt', value: fmt(m?.pLights, 1, 'kW'), status: m ? 'ok' : 'offline' },
        { label: 'Irradiancia', icon: 'cloud', value: fmt(m?.irr, 0, 'W/m²'), status: m ? 'ok' : 'offline' },
        {
          label: 'Zonas con luz',
          icon: 'lightbulb-alt',
          value: `${zs.filter((s) => s.lights > 0.05).length} / ${ZONES.length}`,
          status: 'ok',
        },
        {
          label: 'Luz sin ocupación',
          icon: 'eye-slash',
          value: String(
            ZONES.filter(
              (z) =>
                !z.critical &&
                snapshot.zones[z.id] &&
                !snapshot.zones[z.id].occupied &&
                snapshot.zones[z.id].lights > 0.05
            ).length
          ),
          status: 'ok',
        },
      ];
    case 'hvac':
      return [
        { label: 'P HVAC', icon: 'bolt', value: fmt(m?.pHvac, 1, 'kW'), status: m ? 'ok' : 'offline' },
        {
          label: 'Compresores ON',
          icon: 'repeat',
          value: `${compressors} / ${hvacZones.length}`,
          status: 'ok',
        },
        { label: 'Bloqueados DR', icon: 'pause', value: String(forced), status: forced ? 'warning' : 'ok' },
        {
          label: 'Demanda',
          icon: 'tachometer-fast',
          value: m ? `${m.demand15.toFixed(0)}/${limit} kW` : '—',
          status: demandStatus,
        },
      ];
    default:
      return [
        { label: 'Potencia', icon: 'bolt', value: fmt(m?.pTotal, 1, 'kW'), status: demandStatus },
        {
          label: 'Demanda',
          icon: 'tachometer-fast',
          value: m ? `${m.demand15.toFixed(0)}/${limit} kW` : '—',
          status: demandStatus,
        },
        {
          label: 'Personas',
          icon: 'users-alt',
          value: `${occupants} / ${capacity}`,
          status: zs.length ? 'ok' : 'offline',
        },
        { label: 'Alarmas', icon: 'bell', value: String(alarmCount), status: alarmStatus },
      ];
  }
}

export const EmsPanel: React.FC<Props> = (props) => {
  const { id, options, width, height } = props;
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const statusColors = useStatusColors();
  const [overrides, setOverrides] = useState<Overrides>({});
  const [params, setParams] = useState<EmsParams>({ limitKw: options.limitKw, spOccupied: 24 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [animate, setAnimate] = useState(options.animations);
  const sim = useMemo<SimOptions>(
    () => ({ limitKw: params.limitKw, spOccupied: params.spOccupied, overrides }),
    [params, overrides]
  );
  const { snapshot, history, now } = useSnapshot(props, sim);
  const activeOverrides = useMemo(() => prune(overrides, now), [overrides, now]);
  const manual = useMemo(() => new Set(Object.keys(activeOverrides)), [activeOverrides]);
  const permission = controlPermission(options.allowControl);
  const user = config?.bootData?.user?.login;

  const [viewMode, setViewMode] = useState<ViewMode>(options.defaultView);
  const [azimuth, setAzimuth] = useState<Azimuth>(options.azimuth);
  const [exploded, setExploded] = useState(options.exploded);
  const [floor, setFloor] = useState<'all' | number>('all');
  const [selectedId, setSelectedId] = useState<string>();
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();
  const [statusFilter, setStatusFilter] = useState<Status>();
  const [sideTab, setSideTab] = useState<'alarms' | 'meter' | 'control'>('alarms');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => new Set());

  const [last, setLast] = useState({ v: options.defaultView, a: options.azimuth, e: options.exploded });
  if (last.v !== options.defaultView || last.a !== options.azimuth || last.e !== options.exploded) {
    setLast({ v: options.defaultView, a: options.azimuth, e: options.exploded });
    setViewMode(options.defaultView);
    setAzimuth(options.azimuth);
    setExploded(options.exploded);
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(containerRef);
  const panelWidth = fullscreen.active ? window.innerWidth : width;
  const panelHeight = fullscreen.active ? window.innerHeight : height;
  const docked = options.showSidebar && panelWidth >= SIDEBAR_MIN_PANEL_WIDTH;

  const statuses = useMemo(() => zoneStatuses(snapshot), [snapshot]);
  const counts = useMemo(() => {
    const c: Record<Status, number> = { ok: 0, warning: 0, critical: 0, offline: 0 };
    ZONES.forEach((z) => c[statuses[z.id]]++);
    return c;
  }, [statuses]);
  const shownStatuses = useMemo(
    () =>
      statusFilter
        ? Object.fromEntries(ZONES.map((z) => [z.id, statuses[z.id] === statusFilter ? statuses[z.id] : 'offline']))
        : statuses,
    [statuses, statusFilter]
  ) as Record<string, Status>;
  const kpis = useMemo(
    () => buildKpis(snapshot, statuses, viewMode, params.limitKw),
    [snapshot, statuses, viewMode, params.limitKw]
  );
  const unacknowledged = useMemo(
    () =>
      new Set(snapshot.alarms.filter((a) => a.level === 'crit' && !acknowledged.has(alarmKey(a))).map((a) => a.zone)),
    [snapshot.alarms, acknowledged]
  );

  const iso: IsoConfig = useMemo(
    () => ({ azimuth, layout: exploded ? 'exploded' : 'stacked', scale: 10 }),
    [azimuth, exploded]
  );
  const floors = floor === 'all' ? FLOORS.map((f) => f.level) : [floor];
  const legend = legendFor(viewMode, {
    dark: theme.isDark,
    statusColors,
    status: statuses,
    maxPowerDensity: MAX_POWER_DENSITY,
  });

  const onHover = useCallback((zone: Zone, e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setHover({ id: zone.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  }, []);
  const selectZone = (zoneId: string) => {
    setSelectedId(zoneId);
    const z = ZONE_BY_ID[zoneId];
    if (z && floor !== 'all' && floor !== z.floor) {
      setFloor(z.floor);
    }
  };

  /** Ejecuta uno o varios comandos del operador (simulador local o Node-RED). */
  const runCommands = async (input: Command | Command[]) => {
    const commands = Array.isArray(input) ? input : [input];
    const stamp = () => (options.demoMode ? demoTime(Date.now(), options.demoSpeed) : Date.now());
    const entries: LogEntry[] = [];
    let next = activeOverrides;
    let nextParams = params;
    setBusy(true);
    for (const c of commands) {
      const problem = c.kind === 'override' ? validate(c.cmd) : undefined;
      if (problem) {
        entries.push({ at: stamp(), ok: false, text: problem });
        continue;
      }
      try {
        if (!options.demoMode) {
          await sendToNodeRed(options.controlUrl, c, user);
        }
        next = applyLocal(next, c, stamp(), user);
        if (c.kind === 'params') {
          nextParams = { ...nextParams, ...c.params };
        }
        entries.push({ at: stamp(), ok: true, text: describe(c) });
      } catch (err) {
        entries.push({
          at: stamp(),
          ok: false,
          text: `${describe(c)} — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    setOverrides(next);
    setParams(nextParams);
    setLog((l) => [...entries.reverse(), ...l].slice(0, 30));
    setBusy(false);
  };

  const selected = selectedId ? ZONE_BY_ID[selectedId] : undefined;
  const hovered = hover ? ZONE_BY_ID[hover.id] : undefined;
  const rotate = (dir: 1 | -1) => setAzimuth((a) => ((a + dir * 90 + 360) % 360) as Azimuth);

  const sidebar = selected ? (
    <ZoneDetail
      key={selected.id}
      zone={selected}
      state={snapshot.zones[selected.id]}
      status={statuses[selected.id]}
      history={history}
      alarms={snapshot.alarms}
      onClose={() => setSelectedId(undefined)}
      control={
        <ZoneControl
          key={`${selected.id}-${activeOverrides[selected.id]?.since ?? 0}`}
          zone={selected}
          state={snapshot.zones[selected.id]}
          override={activeOverrides[selected.id]}
          canControl={permission.canControl}
          reason={permission.reason}
          busy={busy}
          onCommand={runCommands}
        />
      }
    />
  ) : (
    <div className={styles.sideContent}>
      <TabsBar className={styles.sideTabs}>
        <Tab
          label="Alarmas"
          active={sideTab === 'alarms'}
          counter={snapshot.alarms.length || null}
          onChangeTab={() => setSideTab('alarms')}
        />
        <Tab label="Medidor" active={sideTab === 'meter'} onChangeTab={() => setSideTab('meter')} />
        <Tab
          label="Control"
          active={sideTab === 'control'}
          counter={manual.size || null}
          onChangeTab={() => setSideTab('control')}
        />
      </TabsBar>
      {sideTab === 'control' ? (
        <BuildingControl
          params={params}
          overrides={activeOverrides}
          log={log}
          canControl={permission.canControl}
          reason={permission.reason}
          busy={busy}
          live={!options.demoMode}
          onCommand={runCommands}
          onSelectZone={selectZone}
        />
      ) : sideTab === 'alarms' ? (
        <AlarmList
          alarms={snapshot.alarms}
          acknowledged={acknowledged}
          onSelectZone={selectZone}
          onAcknowledge={(k) => setAcknowledged((s) => new Set(s).add(k))}
          onAcknowledgeAll={() => setAcknowledged(new Set(snapshot.alarms.map(alarmKey)))}
        />
      ) : (
        <MeterCard meter={snapshot.meter} ems={snapshot.ems} limitKw={params.limitKw} history={history} />
      )}
    </div>
  );

  const timeLabel = new Date(now).toLocaleTimeString('es-PA', {
    timeZone: 'America/Panama',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dr = snapshot.ems?.drActive;

  return (
    <div
      className={cx(styles.wrapper, fullscreen.active && styles.fullscreen)}
      style={fullscreen.active ? undefined : { width, height }}
      ref={containerRef}
      data-testid="ems-panel"
    >
      {options.showSummary && (
        <Header
          title={BUILDING.name}
          subtitle={`${ZONES.length} zonas · 3 niveles · ${timeLabel}${dr ? ' · DR activo' : ''}${manual.size ? ` · ${manual.size} en manual` : ''}`}
          demoMode={options.demoMode}
          kpis={kpis}
          showKpis={panelWidth >= 560 && panelHeight >= 360}
          compact={panelWidth < 1200}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      )}

      <div className={styles.body}>
        <div className={styles.scene}>
          <Building3D
            idPrefix={`ems-${id}`}
            snapshot={snapshot}
            statuses={shownStatuses}
            statusColors={statusColors}
            viewMode={viewMode}
            iso={iso}
            floors={floors}
            selectedId={selectedId}
            hoveredId={hover?.id}
            unacknowledged={unacknowledged}
            manual={manual}
            animate={animate}
            onHover={onHover}
            onLeave={() => setHover(undefined)}
            onSelect={(z) => setSelectedId((cur) => (cur === z.id ? undefined : z.id))}
          />

          <div className={styles.topLeft}>
            <IconButton
              name={fullscreen.active ? 'compress-arrows' : 'expand-arrows-alt'}
              tooltip={fullscreen.active ? 'Salir de pantalla completa (Esc)' : 'Pantalla completa'}
              onClick={fullscreen.toggle}
            />
            <IconButton
              name="history-alt"
              tooltip="Girar a la izquierda"
              onClick={() => rotate(-1)}
              data-testid="ems-rotate-left"
            />
            <IconButton
              name="sync"
              tooltip="Girar a la derecha"
              onClick={() => rotate(1)}
              data-testid="ems-rotate-right"
            />
            <IconButton
              name={exploded ? 'gf-layout-simple' : 'layer-group'}
              tooltip={exploded ? 'Vista exterior (pisos unidos)' : 'Vista explotada (ver cada piso)'}
              onClick={() => setExploded((e) => !e)}
              data-testid="ems-explode"
            />
            <IconButton
              name={animate ? 'pause' : 'play'}
              tooltip={animate ? 'Pausar animaciones' : 'Reanudar animaciones'}
              onClick={() => setAnimate((a) => !a)}
              data-testid="ems-animate"
            />
            <RadioButtonGroup
              size="sm"
              value={floor}
              onChange={(v) => setFloor(v)}
              options={[
                { value: 'all' as const, label: 'Todos' },
                ...FLOORS.map((f) => ({ value: f.level, label: f.short })),
              ]}
            />
          </div>

          <Legend spec={legend} counts={counts} statusFilter={statusFilter} onStatusFilter={setStatusFilter} />

          {!docked && !selected && (
            <div className={styles.topRight}>
              <Button
                size="sm"
                variant={snapshot.alarms.some((a) => a.level !== 'info') ? 'destructive' : 'secondary'}
                icon="bell"
                onClick={() => setOverlayOpen((o) => !o)}
              >
                Alarmas {snapshot.alarms.length}
              </Button>
            </div>
          )}
          {!docked && (selected || overlayOpen) && (
            <aside className={styles.overlay}>
              {!selected && (
                <div className={styles.overlayClose}>
                  <IconButton name="times" tooltip="Cerrar" onClick={() => setOverlayOpen(false)} />
                </div>
              )}
              {sidebar}
            </aside>
          )}
          {hovered && hover && (
            <ZoneTooltip
              zone={hovered}
              state={snapshot.zones[hovered.id]}
              status={statuses[hovered.id]}
              x={hover.x}
              y={hover.y - (options.showSummary ? 60 : 0)}
              containerWidth={docked ? panelWidth - 310 : panelWidth}
              containerHeight={panelHeight}
            />
          )}
        </div>
        {docked && <aside className={styles.sidebar}>{sidebar}</aside>}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css`
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
  `,
  fullscreen: css`
    width: 100vw;
    height: 100vh;
    padding: ${theme.spacing(2)};
    background: ${theme.colors.background.canvas};
  `,
  body: css`
    display: flex;
    flex: 1;
    min-height: 0;
    gap: ${theme.spacing(1)};
  `,
  scene: css`
    position: relative;
    flex: 1;
    min-width: 0;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    background: ${theme.colors.background.secondary};
  `,
  topLeft: css`
    position: absolute;
    top: ${theme.spacing(1)};
    left: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.5)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    box-shadow: ${theme.shadows.z2};
    z-index: 2;
  `,
  topRight: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
  `,
  sidebar: css`
    width: 300px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  overlay: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    bottom: ${theme.spacing(1)};
    width: min(300px, calc(100% - ${theme.spacing(2)}));
    overflow-y: auto;
    padding: ${theme.spacing(1.5)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    box-shadow: ${theme.shadows.z3};
    z-index: 3;
  `,
  overlayClose: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
  `,
  sideContent: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  sideTabs: css`
    margin: ${theme.spacing(-0.5, -1.5, 0)};
    padding: ${theme.spacing(0, 1.5)};
  `,
});
