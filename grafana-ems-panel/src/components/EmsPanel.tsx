import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GrafanaTheme2, PanelProps } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, IconButton, Tab, TabsBar, useStyles2, useTheme2 } from '@grafana/ui';
import { config } from '@grafana/runtime';
import { EmsOptions } from 'types';
import { BUILDING, FLOORS, LIMIT_KW, VRF_UNITS, VrfUnit, ZONES, ZONE_BY_ID, Zone } from 'building/model';
import { Azimuth, IsoConfig } from 'building/iso';
import { SimOptions, instant, simulate, simulateHistory } from 'building/simulator';
import {
  EmsParams,
  History,
  OccupancyOverrides,
  Overrides,
  Snapshot,
  Status,
  snapshotFromFrames,
  zoneStatuses,
} from 'building/telemetry';
import {
  Command,
  CommandResult,
  LogEntry,
  SendFeedback,
  applyLocal,
  applyOccupancy,
  describe,
  feedbackFor,
  prune,
  pruneOccupancy,
  sendToNodeRed,
  validateCommand,
} from 'building/control';
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
import { TimeBar } from './TimeBar';
import { SimulatePanel } from './SimulatePanel';
import { EmergencyBanner, emergencyMessage } from './EmergencyBanner';
import { HelpOverlay } from './HelpOverlay';
import { VrfTooltip } from './VrfTooltip';
import { OverviewPanel } from './OverviewPanel';
import { SceneCompass } from './SceneCompass';
import { FloorKey, FloorSelector } from './FloorSelector';
import { autoFloor, floorSummary, roofSummary } from 'building/layout';
import { demandLevel } from 'building/demand';
import {
  ClockState,
  goLive,
  initialClock,
  localParts,
  setSpeed,
  setTime,
  simNow,
  tickMs,
  togglePlay,
} from 'building/clock';
import { SimEvent } from 'building/events';
import { useStatusColors } from './useStatusColors';
import { useElementSize } from './useElementSize';

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

const HIST_SPAN = 2 * 3_600_000;
const HIST_STEP = 2 * 60_000;

/** Reloj de la simulación controlado por el operador (barra de tiempo). */
function useSimClock(demo: boolean, initialSpeed: number) {
  const [clock, setClock] = useState<ClockState>(() => initialClock(Date.now(), initialSpeed));
  const [real, setReal] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setReal(Date.now()), demo ? tickMs(clock) : 1000);
    return () => clearInterval(timer);
  }, [demo, clock]);
  const now = simNow(clock, Math.max(real, clock.anchorReal));
  return {
    clock,
    now,
    real,
    stamp: () => simNow(clock, Date.now()),
    setTime: (t: number) => setClock((c) => setTime(c, t, Date.now())),
    setSpeed: (v: number) => setClock((c) => setSpeed(c, v, Date.now())),
    togglePlay: () => setClock((c) => togglePlay(c, Date.now())),
    goLive: () => setClock(goLive(Date.now())),
  };
}

function useSnapshot(
  props: Props,
  sim: SimOptions,
  simT: number,
  real: number
): { snapshot: Snapshot; history: History; now: number } {
  const { options, data } = props;
  const snapshot = useMemo(() => (options.demoMode ? simulate(simT, sim) : undefined), [options.demoMode, simT, sim]);
  // la tendencia de 2 h sólo cambia cada 2 min simulados
  const histT = Math.floor(simT / HIST_STEP) * HIST_STEP;
  const history = useMemo(
    () => (options.demoMode ? simulateHistory(histT, HIST_SPAN, 37, sim) : undefined),
    [options.demoMode, histT, sim]
  );
  const realNow = real;
  const fromData = useMemo(
    () => (options.demoMode ? undefined : snapshotFromFrames(data.series)),
    [options.demoMode, data.series]
  );
  if (options.demoMode) {
    return { snapshot: snapshot!, history: history!, now: simT };
  }
  return { ...fromData!, now: fromData!.snapshot.time || realNow };
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
  // con FV el limitador actúa sobre la importación neta de la red
  const controlled = m ? (m.pPv !== undefined ? Math.max(m.pGrid ?? m.pTotal - m.pPv, 0) : m.pTotal) : 0;
  const demandStatus: Status = !m ? 'offline' : demandLevel(Math.max(controlled, m.demand15), limit);
  const dr = snapshot.ems?.drActive;
  const powerKpi: Kpi = {
    label: m?.pPv !== undefined ? 'Red' : 'Potencia',
    icon: 'bolt',
    value: fmt(controlled, 1, 'kW'),
    hint: m ? `de ${limit} kW` : undefined,
    ratio: m ? controlled / limit : undefined,
    status: demandStatus,
  };
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
        powerKpi,
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
          label: 'Demanda 15 min',
          icon: 'tachometer-fast',
          value: fmt(m?.demand15, 0, 'kW'),
          hint: m ? `de ${limit} kW` : undefined,
          ratio: m ? m.demand15 / limit : undefined,
          status: demandStatus,
        },
      ];
    default:
      return [
        powerKpi,
        ...(m?.pPv !== undefined
          ? [
              {
                label: 'Fotovoltaica',
                icon: 'circle' as const,
                glyph: 'sun' as const,
                value: fmt(m.pPv, 1, 'kW'),
                status: 'ok' as Status,
              },
            ]
          : []),
        {
          label: 'Respuesta DR',
          icon: 'tachometer-fast',
          value: !snapshot.ems ? '—' : dr ? 'Activa' : 'En espera',
          hint: dr && snapshot.ems?.drStage ? `etapa ${snapshot.ems.drStage}` : undefined,
          status: !snapshot.ems ? 'offline' : dr ? 'warning' : 'ok',
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
  const [occupancy, setOccupancy] = useState<OccupancyOverrides>({});
  const [params, setParams] = useState<EmsParams>({ limitKw: options.limitKw ?? LIMIT_KW, spOccupied: 24 });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<SendFeedback>();
  // el aviso de éxito se oculta solo; los errores quedan hasta el siguiente envío o hasta cerrarlos
  useEffect(() => {
    if (feedback?.phase !== 'ok') {
      return;
    }
    const t = setTimeout(() => setFeedback((f) => (f === feedback ? undefined : f)), 6000);
    return () => clearTimeout(t);
  }, [feedback]);
  const [animate, setAnimate] = useState(options.animations);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [demoIncidents, setDemoIncidents] = useState(true);
  const simClock = useSimClock(options.demoMode, options.demoSpeed);
  const pvMode = options.pvMode ?? 'auto';
  const controller = options.demoController ?? 'reglas_dr';
  const sim = useMemo<SimOptions>(
    () => ({
      limitKw: params.limitKw,
      spOccupied: params.spOccupied,
      overrides,
      events,
      demoIncidents,
      occupancy,
      pv: pvMode !== 'off',
      controller,
    }),
    [params, overrides, events, demoIncidents, occupancy, pvMode, controller]
  );
  const { snapshot, history, now } = useSnapshot(props, sim, simClock.now, simClock.real);
  // variante con FV: en vivo se detecta por la presencia de p_fv_kw en el medidor
  const pvVisible = options.demoMode
    ? pvMode !== 'off'
    : pvMode === 'on' || (pvMode === 'auto' && snapshot.meter?.pPv !== undefined);
  const activeOverrides = useMemo(() => prune(overrides, now), [overrides, now]);
  const activeOccupancy = useMemo(() => pruneOccupancy(occupancy, now), [occupancy, now]);
  const manual = useMemo(
    () => new Set([...Object.keys(activeOverrides), ...Object.keys(activeOccupancy).filter((k) => k !== '*')]),
    [activeOverrides, activeOccupancy]
  );
  const permission = controlPermission(options.allowControl);
  const user = config?.bootData?.user?.login;

  const [viewMode, setViewMode] = useState<ViewMode>(options.defaultView);
  const [azimuth, setAzimuth] = useState<Azimuth>(options.azimuth);
  const [exploded, setExploded] = useState(options.exploded);
  // planta elegida por el operador; sin elegir, la de la opción «Planta inicial» (auto = la de la alarma más grave)
  const [floorChoice, setFloor] = useState<FloorKey>();
  const [selectedId, setSelectedId] = useState<string>();
  const [hover, setHover] = useState<{ id: string; x: number; y: number; w: number; h: number }>();
  const [unitHover, setUnitHover] = useState<{ id: string; x: number; y: number; w: number; h: number }>();
  const [statusFilter, setStatusFilter] = useState<Status>();
  const [sideTab, setSideTab] = useState<'overview' | 'alarms' | 'control' | 'simulate'>('overview');
  const [help, setHelp] = useState(false);
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
  const sceneRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(containerRef);
  const panelWidth = fullscreen.active ? window.innerWidth : width;
  const panelHeight = fullscreen.active ? window.innerHeight : height;
  const docked = options.showSidebar && panelWidth >= SIDEBAR_MIN_PANEL_WIDTH;
  const sidebarWidth = panelWidth >= 1400 ? 380 : 330;
  // ancho del área de la escena (sin el panel lateral) para decidir qué controles caben
  const sceneWidth = panelWidth - (docked ? sidebarWidth + 8 : 0);
  const selectorCompact = sceneWidth < 900 || panelHeight < 420;
  const canvas = useElementSize(sceneRef);
  const canvasWidth = canvas.w || sceneWidth - (selectorCompact ? 64 : 156);
  // escena baja: la leyenda sube a la barra superior y la planta usa toda la altura
  const shortScene = canvas.h > 0 && canvas.h < 400;

  const statuses = useMemo(() => zoneStatuses(snapshot), [snapshot]);
  const defaultFloor = options.defaultFloor ?? 'auto';
  const floor: FloorKey =
    floorChoice ??
    (defaultFloor === 'auto'
      ? autoFloor(statuses, snapshot)
      : defaultFloor === 'all' || defaultFloor === 'roof'
        ? defaultFloor
        : Number(defaultFloor));
  const levelSummaries = useMemo(
    () => [
      roofSummary(snapshot, statuses),
      ...[...FLOORS].reverse().map((f) => floorSummary(f.level, snapshot, statuses)),
    ],
    [snapshot, statuses]
  );
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
  const floors = floor === 'all' || floor === 'roof' ? FLOORS.map((f) => f.level) : [floor];
  const legend = legendFor(viewMode, {
    dark: theme.isDark,
    statusColors,
    status: statuses,
    maxPowerDensity: MAX_POWER_DENSITY,
  });

  const onHover = useCallback((zone: Zone, e: React.MouseEvent) => {
    const rect = sceneRef.current?.getBoundingClientRect();
    if (rect) {
      setHover({ id: zone.id, x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height });
    }
  }, []);
  const onHoverUnit = useCallback((unit: VrfUnit, e: React.MouseEvent) => {
    const rect = sceneRef.current?.getBoundingClientRect();
    if (rect) {
      setUnitHover({ id: unit.id, x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height });
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
  const runCommands = async (input: Command | Command[]): Promise<CommandResult> => {
    const commands = Array.isArray(input) ? input : [input];
    const stamp = () => (options.demoMode ? simClock.stamp() : Date.now());
    const entries: LogEntry[] = [];
    let next = activeOverrides;
    let nextParams = params;
    let nextEvents = events;
    let nextOcc = activeOccupancy;
    setBusy(true);
    setFeedback(undefined);
    for (const c of commands) {
      const problem = validateCommand(c);
      if (problem) {
        entries.push({ at: stamp(), ok: false, text: problem });
        continue;
      }
      try {
        if (!options.demoMode) {
          await sendToNodeRed(options.controlUrl, c, user);
        }
        next = applyLocal(next, c, stamp(), user);
        nextOcc = applyOccupancy(nextOcc, c, stamp(), user);
        if (c.kind === 'params') {
          nextParams = { ...nextParams, ...c.params };
        }
        if (c.kind === 'event') {
          nextEvents = [...nextEvents.filter((e) => e.end > stamp()), c.event];
        }
        if (c.kind === 'event_stop') {
          const t = stamp();
          // se termina en el instante actual (queda en la historia para las tendencias)
          nextEvents = nextEvents
            .map((e) => ((c.id === '*' || e.id === c.id) && e.end > t ? { ...e, end: Math.max(e.start, t) } : e))
            .filter((e) => e.end > e.start);
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
    setEvents(nextEvents);
    setOccupancy(nextOcc);
    setLog((l) => [...entries.reverse(), ...l].slice(0, 30));
    const failed = entries.filter((e) => !e.ok);
    const result: CommandResult = {
      ok: entries.length - failed.length,
      failed: failed.length,
      errors: failed.map((e) => e.text),
    };
    setFeedback({ ...feedbackFor(result, !options.demoMode), at: Date.now() });
    setBusy(false);
    return result;
  };

  // curva de potencia del día (15 min): simulada en demostración, tendencia del medidor en vivo
  const dayStart = localParts(now).dayStart;
  const curveBucket = Math.floor(now / 900_000);
  const { dayCurve, pvCurve } = useMemo(() => {
    if (!options.demoMode) {
      return {
        dayCurve: (history.EDIF?.pTotal ?? []) as Array<[number, number]>,
        pvCurve: history.EDIF?.pPv as Array<[number, number]> | undefined,
      };
    }
    const out: Array<[number, number]> = [];
    const pvOut: Array<[number, number]> = [];
    for (let t = dayStart; t <= dayStart + 86_400_000; t += 900_000) {
      const k = instant(t, sim);
      out.push([t, k.pTotal]);
      pvOut.push([t, k.pPv]);
    }
    return { dayCurve: out, pvCurve: sim.pv ? pvOut : undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.demoMode, dayStart, sim, curveBucket, history]);
  const activeEventCount = events.filter((e) => e.start <= now && e.end > now).length;
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
          key={`${selected.id}-${activeOverrides[selected.id]?.since ?? 0}-${activeOccupancy[selected.id]?.since ?? 0}`}
          zone={selected}
          state={snapshot.zones[selected.id]}
          override={activeOverrides[selected.id]}
          occupancy={activeOccupancy[selected.id]}
          canControl={permission.canControl}
          reason={permission.reason}
          busy={busy}
          feedback={feedback}
          onDismissFeedback={() => setFeedback(undefined)}
          onCommand={runCommands}
        />
      }
    />
  ) : (
    <div className={styles.sideContent}>
      <TabsBar className={styles.sideTabs}>
        <Tab label="Resumen" active={sideTab === 'overview'} onChangeTab={() => setSideTab('overview')} />
        <Tab
          label="Alarmas"
          active={sideTab === 'alarms'}
          counter={snapshot.alarms.length || null}
          onChangeTab={() => setSideTab('alarms')}
        />
        <Tab
          label="Control"
          active={sideTab === 'control'}
          counter={manual.size || null}
          onChangeTab={() => setSideTab('control')}
        />
        <Tab
          label="Simular"
          active={sideTab === 'simulate'}
          counter={activeEventCount || null}
          onChangeTab={() => setSideTab('simulate')}
        />
      </TabsBar>
      {sideTab === 'overview' ? (
        <OverviewPanel
          snapshot={snapshot}
          statuses={statuses}
          statusColors={statusColors}
          limitKw={params.limitKw}
          dayCurve={dayCurve}
          pvCurve={pvVisible ? pvCurve : undefined}
          now={now}
          onSelectZone={selectZone}
          meter={<MeterCard meter={snapshot.meter} ems={snapshot.ems} limitKw={params.limitKw} history={history} />}
        />
      ) : sideTab === 'simulate' ? (
        <SimulatePanel
          now={now}
          snapshot={snapshot}
          sim={sim}
          events={events}
          demoIncidents={demoIncidents}
          canControl={permission.canControl}
          reason={permission.reason}
          live={!options.demoMode}
          onCommand={runCommands}
          onDemoIncidents={setDemoIncidents}
        />
      ) : sideTab === 'control' ? (
        <BuildingControl
          params={params}
          overrides={activeOverrides}
          occupancy={activeOccupancy}
          log={log}
          snapshot={snapshot}
          now={now}
          canControl={permission.canControl}
          reason={permission.reason}
          busy={busy}
          feedback={feedback}
          onDismissFeedback={() => setFeedback(undefined)}
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
          subtitle={`${ZONES.length} zonas · ${FLOORS.length} plantas${pvVisible ? ' · FV' : ''}${options.demoMode && controller === 'baseline' ? ' · línea base E+' : ''}${options.showTimeBar === false ? ` · ${timeLabel}` : ''}${dr ? ' · DR activo' : ''}${manual.size ? ` · ${manual.size} en manual` : ''}`}
          demoMode={options.demoMode}
          kpis={kpis}
          showKpis={panelWidth >= 480 && panelHeight >= 340}
          compact={panelWidth < 1200}
          dense={panelHeight < 640}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      )}

      {options.showTimeBar !== false && (
        <TimeBar
          now={now}
          clock={simClock.clock}
          live={!options.demoMode}
          compact={panelWidth < 1100}
          dense={panelHeight < 640 || panelWidth < 760}
          onTime={simClock.setTime}
          onSpeed={simClock.setSpeed}
          onTogglePlay={simClock.togglePlay}
          onLive={simClock.goLive}
        />
      )}

      <div className={styles.body}>
        <div className={styles.scene}>
          {panelHeight >= 300 && (
            <FloorSelector
              levels={levelSummaries}
              value={floor}
              onChange={(v) => setFloor(v)}
              statusColors={statusColors}
              compact={selectorCompact}
              pv={pvVisible}
            />
          )}
          <div className={styles.canvas} ref={sceneRef}>
            <Building3D
              idPrefix={`ems-${id}`}
              snapshot={snapshot}
              statuses={shownStatuses}
              statusColors={statusColors}
              viewMode={viewMode}
              iso={iso}
              floors={floors}
              roofOnly={floor === 'roof'}
              selectedId={selectedId}
              hoveredId={hover?.id}
              unacknowledged={unacknowledged}
              manual={manual}
              animate={animate}
              onHover={onHover}
              onLeave={() => setHover(undefined)}
              onSelect={(z) => setSelectedId((cur) => (cur === z.id ? undefined : z.id))}
              hoveredUnit={unitHover?.id}
              onHoverUnit={onHoverUnit}
              onLeaveUnit={() => setUnitHover(undefined)}
              pv={pvVisible}
              insets={{
                top: 56,
                right: 8,
                bottom: (emergencyMessage(snapshot, events, now) ? 66 : 0) + (shortScene ? 8 : 46),
                left: 8,
              }}
              onSelectFloor={(k) => setFloor(k)}
            />

            <div className={styles.topLeft} style={{ right: shortScene ? (docked ? 260 : 330) : 200 }}>
              <div className={styles.toolbar}>
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
                  tooltip={
                    floor === 'all'
                      ? exploded
                        ? 'Volumen compacto (plantas unidas)'
                        : 'Separar las plantas'
                      : exploded
                        ? 'Vista exterior de la planta'
                        : 'Vista interior de la planta'
                  }
                  onClick={() => setExploded((e) => !e)}
                  data-testid="ems-explode"
                />
                <IconButton
                  name={animate ? 'pause' : 'play'}
                  tooltip={animate ? 'Pausar animaciones' : 'Reanudar animaciones'}
                  onClick={() => setAnimate((a) => !a)}
                  data-testid="ems-animate"
                />
                <IconButton
                  name="question-circle"
                  tooltip="Cómo usar el panel"
                  onClick={() => setHelp(true)}
                  data-testid="ems-help-button"
                />
              </div>
              <div className={styles.sceneTitle} data-testid="ems-scene-title">
                {(() => {
                  const sm = floor === 'all' ? undefined : levelSummaries.find((l) => l.key === floor);
                  if (!sm) {
                    return (
                      <>
                        <span className={styles.titleMain}>Edificio</span>
                        <span className={styles.titleSub}>
                          {FLOORS.length} plantas + azotea · {fmt(snapshot.meter?.pTotal, 1, 'kW')}
                        </span>
                      </>
                    );
                  }
                  return (
                    <>
                      <span className={styles.titleDot} style={{ background: statusColors[sm.status] }} />
                      <span className={styles.titleMain}>
                        {sm.key === 'roof' ? 'Azotea' : `${sm.short} · ${sm.name}`}
                      </span>
                      {canvasWidth >= 860 && (
                        <span className={styles.titleSub}>
                          {sm.key === 'roof'
                            ? `${VRF_UNITS.length} VRF · ${sm.kw.toFixed(1)} kW${pvVisible && sm.pv !== undefined ? ` · FV ${sm.pv.toFixed(1)} kW` : ''}`
                            : `${sm.zones} zonas · ${sm.temp === undefined ? '—' : `${sm.temp.toFixed(1)} °C`} · ${sm.kw.toFixed(1)} kW`}
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            <EmergencyBanner
              snapshot={snapshot}
              events={events}
              now={now}
              canStop={permission.canControl}
              onShow={() => {
                setSelectedId(undefined);
                setSideTab(snapshot.alarms.length ? 'alarms' : 'simulate');
                setOverlayOpen(true);
              }}
              onStop={() => runCommands({ kind: 'event_stop', id: '*' })}
            />
            {help && <HelpOverlay onClose={() => setHelp(false)} />}
            {!shortScene && (
              <Legend
                spec={legend}
                counts={counts}
                statusFilter={statusFilter}
                onStatusFilter={setStatusFilter}
                compact={canvasWidth < 760}
              />
            )}

            <div className={styles.topRight}>
              {shortScene && (
                <Legend
                  spec={legend}
                  counts={counts}
                  statusFilter={statusFilter}
                  onStatusFilter={setStatusFilter}
                  compact
                  inline
                />
              )}
              {!docked && !selected && (
                <Button
                  size="sm"
                  variant={snapshot.alarms.some((a) => a.level !== 'info') ? 'destructive' : 'secondary'}
                  icon="bell"
                  onClick={() => setOverlayOpen((o) => !o)}
                >
                  Alarmas {snapshot.alarms.length}
                </Button>
              )}
              {canvasWidth >= 720 && !shortScene && (
                <SceneCompass
                  azimuth={azimuth}
                  time={now}
                  irradiance={snapshot.meter?.irr}
                  tExt={snapshot.meter?.tExt}
                />
              )}
            </div>
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
            {unitHover && (
              <VrfTooltip
                unit={VRF_UNITS.find((u) => u.id === unitHover.id)!}
                snapshot={snapshot}
                x={unitHover.x}
                y={unitHover.y}
                containerWidth={unitHover.w}
                containerHeight={unitHover.h}
              />
            )}
            {hovered && hover && (
              <ZoneTooltip
                zone={hovered}
                state={snapshot.zones[hovered.id]}
                status={statuses[hovered.id]}
                x={hover.x}
                y={hover.y}
                containerWidth={hover.w}
                containerHeight={hover.h}
              />
            )}
          </div>
        </div>
        {docked && (
          <aside className={styles.sidebar} style={{ width: sidebarWidth }}>
            {sidebar}
          </aside>
        )}
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
    display: flex;
    flex: 1;
    min-width: 0;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    overflow: hidden;
    background: ${theme.colors.background.secondary};
  `,
  canvas: css`
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  `,
  topLeft: css`
    position: absolute;
    top: ${theme.spacing(1)};
    left: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    pointer-events: none;
    z-index: 2;
    & > * {
      pointer-events: auto;
    }
  `,
  toolbar: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    height: 40px;
    padding: ${theme.spacing(0, 0.75)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.weak};
    box-shadow: ${theme.shadows.z1};
    flex-shrink: 0;
  `,
  sceneTitle: css`
    display: flex;
    align-items: baseline;
    gap: ${theme.spacing(1)};
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none !important;
  `,
  titleDot: css`
    align-self: center;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  titleMain: css`
    font-size: ${theme.typography.h3.fontSize};
    font-weight: ${theme.typography.fontWeightBold};
    color: ${theme.colors.text.primary};
    line-height: 1.1;
  `,
  titleSub: css`
    font-size: ${theme.typography.body.fontSize};
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  topRight: css`
    position: absolute;
    top: ${theme.spacing(1)};
    right: ${theme.spacing(1)};
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    z-index: 2;
  `,
  sidebar: css`
    width: 380px;
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
    width: min(380px, calc(100% - ${theme.spacing(2)}));
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
