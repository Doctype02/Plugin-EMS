import React, { useEffect, useRef, useState } from 'react';
import { useElementSize } from './useElementSize';
import { Glyph } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, PTAC_BY_ZONE, VRF_UNITS, VrfUnit, ZONES, Zone } from 'building/model';
import { IsoConfig, Prism, Pt, path, placement, planeMatrix, prism, rotate, toScreen } from 'building/iso';
import { localParts } from 'building/clock';
import { EVENTS, EventKind } from 'building/events';
import { Snapshot, Status } from 'building/telemetry';
import { MAX_POWER_DENSITY, ViewMode, zoneFill, zoneLabel } from 'building/views';
import {
  Box,
  Insets,
  LabelBox,
  LevelSummary,
  declutter,
  fitView,
  floorSummary,
  placeLabels,
  roofSummary,
  shortZoneName,
} from 'building/layout';
import { blend, faceColor, floorFinish, lit, materials, zoneMark } from 'building/materials';
import { Rooftop } from './Rooftop';
import { SLAB, ZoneInterior, tagAnchor } from './ZoneInterior';
import { SceneDefs, ZoneChip, chipSize, faceQuad, onFace, segments } from './IsoPrimitives';
import { mo, useMotion } from './motion';

interface Props {
  idPrefix: string;
  snapshot: Snapshot;
  statuses: Record<string, Status>;
  statusColors: Record<Status, string>;
  viewMode: ViewMode;
  iso: IsoConfig;
  /** Plantas visibles: una sola = vista de planta; todas = vista de conjunto del edificio. */
  floors: number[];
  /** Vista de la azotea (unidades VRF y campos FV a tamaño completo). */
  roofOnly?: boolean;
  selectedId?: string;
  hoveredId?: string;
  unacknowledged: Set<string>;
  /** Zonas en control manual (override del operador). */
  manual: Set<string>;
  animate: boolean;
  onHover: (zone: Zone, e: React.MouseEvent) => void;
  onLeave: () => void;
  onSelect: (zone: Zone) => void;
  hoveredUnit?: string;
  onHoverUnit?: (unit: VrfUnit, e: React.MouseEvent) => void;
  onLeaveUnit?: () => void;
  /** Variante con fotovoltaica: dibuja los campos FV en la azotea. */
  pv?: boolean;
  /** Márgenes (px) que ocupan los controles flotantes sobre la escena. */
  insets?: Insets;
  /** Clic en el rótulo de una planta en la vista de conjunto. */
  onSelectFloor?: (key: number | 'roof') => void;
}

/** Colores del cielo según la hora (noche → amanecer → día → atardecer). */
export function skyColors(hour: number, dark: boolean): { top: string; bottom: string; night: number } {
  const night = hour < 5.5 || hour > 19 ? 1 : hour < 7 ? (7 - hour) / 1.5 : hour > 17.5 ? (hour - 17.5) / 1.5 : 0;
  const dusk = (hour > 5.5 && hour < 7.5) || (hour > 17 && hour < 19);
  // fondo sobrio: sólo un matiz que sugiere la hora (día neutro, atardecer cálido, noche azulada)
  const m = materials(dark);
  if (dark) {
    return night >= 1
      ? { top: '#0f1218', bottom: '#161a21', night }
      : dusk
        ? { top: '#16171d', bottom: '#1d1b1f', night }
        : { top: m.skyTop, bottom: m.skyBottom, night };
  }
  return night >= 1
    ? { top: '#e4e8ef', bottom: '#eff1f5', night }
    : dusk
      ? { top: '#eef0f4', bottom: '#f7f3ee', night }
      : { top: m.skyTop, bottom: m.skyBottom, night };
}

const ROOF_DECK = 0.25;
/** Separación entre plantas (m) en la vista de conjunto con las plantas separadas. */
export const FLOOR_GAP = 1.1;
/** Altura de las unidades y rótulos sobre la azotea (m) para el encuadre. */
const ROOF_TOP = 1.7;
/** Altura del anclaje de los rótulos de zona sobre la losa (m), igual que tagAnchor. */
const TAG_Z = 3.6;
const PLAZA = 1.6;
const DEFAULT_INSETS: Insets = { top: 8, right: 8, bottom: 8, left: 8 };

/** Respeta la preferencia del sistema de reducir el movimiento. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) {
      return;
    }
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Caja proyectada (unidades) del rectángulo del edificio, ampliado `grow` m, entre las alturas dadas. */
function projectedBox(cfg: IsoConfig, zs: number[], grow = 0): Box {
  const pts: Pt[] = [];
  for (const z of zs) {
    for (const [x, y] of [
      [-grow, -grow],
      [BUILDING.width + grow, -grow],
      [BUILDING.width + grow, BUILDING.depth + grow],
      [-grow, BUILDING.depth + grow],
    ]) {
      pts.push(toScreen(x, y, z, cfg));
    }
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

const fmtTemp = (t?: number) => (t === undefined ? '—' : `${t.toFixed(1)} °C`);
const fmtKw = (kw: number) => `${kw < 10 ? kw.toFixed(1) : kw.toFixed(0)} kW`;

export const Building3D: React.FC<Props> = ({
  idPrefix,
  snapshot,
  statuses,
  statusColors,
  viewMode,
  iso,
  floors,
  roofOnly = false,
  selectedId,
  hoveredId,
  unacknowledged,
  manual,
  animate: animateOption,
  onHover,
  onLeave,
  onSelect,
  hoveredUnit,
  onHoverUnit,
  onLeaveUnit,
  pv = false,
  insets = DEFAULT_INSETS,
  onSelectFloor,
}) => {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(svgRef);
  const animate = animateOption && !reduced;
  // movimiento a la tasa de la pantalla (rAF compartido); se detiene fuera de pantalla y en pestañas ocultas
  useMotion(svgRef, animate);
  const dark = theme.isDark;

  const mode: 'building' | 'floor' | 'roof' = roofOnly ? 'roof' : floors.length === 1 ? 'floor' : 'building';
  const separated = iso.layout === 'exploded';
  const interior = mode === 'floor' && separated;
  // la vista de conjunto es siempre el volumen apilado (PB abajo, azotea arriba); "explotada" = plantas separadas
  const cfg: IsoConfig = mode === 'building' ? { ...iso, layout: 'stacked', stackGap: separated ? FLOOR_GAP : 0 } : iso;
  const WALL = interior ? BUILDING.floorHeight * 0.8 : BUILDING.floorHeight - SLAB;
  const visible = mode === 'roof' ? [] : FLOORS.filter((f) => floors.includes(f.level));
  const topLevel = FLOORS[FLOORS.length - 1].level;
  const roofZ = mode === 'roof' ? 0 : placement(topLevel, cfg).z + BUILDING.floorHeight + (cfg.stackGap ?? 0);

  // --- encuadre: la geometría de la vista ocupa el área libre (px) sin recortarse
  const compactLabels = size.w < 760 || size.h < 420;
  const sideLabelW = compactLabels ? 150 : 178;
  const geom =
    mode === 'building'
      ? projectedBox(cfg, [0, roofZ + ROOF_DECK + ROOF_TOP], 0)
      : mode === 'roof'
        ? projectedBox(cfg, [0, ROOF_DECK + ROOF_TOP])
        : projectedBox(cfg, [0, interior ? TAG_Z : BUILDING.floorHeight]);
  const pad: Insets =
    mode === 'building'
      ? {
          top: insets.top + 10,
          right: insets.right + 12,
          bottom: insets.bottom + 34,
          left: insets.left + sideLabelW + 22,
        }
      : mode === 'roof'
        ? { top: insets.top + 30, right: insets.right + 16, bottom: insets.bottom + 12, left: insets.left + 16 }
        : {
            top: insets.top + (interior && size.h >= 260 ? 22 : 4),
            right: insets.right + 16,
            bottom: insets.bottom + 4,
            left: insets.left + 16,
          };
  const fit = fitView(geom, size, pad, mode === 'building' ? 3.2 : 4.2);
  const box = fit.viewBox;
  const u = 1 / fit.k; // unidades por px de pantalla

  const ctx = { dark, statusColors, status: statuses, maxPowerDensity: MAX_POWER_DENSITY };
  const ink = theme.colors.text.primary;
  const ink2 = theme.colors.text.secondary;
  const surface = theme.colors.background.primary;
  const M = materials(dark);
  const FULL = { x: 0, y: 0, w: BUILDING.width, d: BUILDING.depth };
  const chipColors = {
    surface,
    border: theme.colors.border.medium,
    ink,
    ink2,
    accent: theme.colors.primary.main,
  };

  const hour = localParts(snapshot.time || 0).hour;
  const sky = skyColors(hour, dark);
  const night = sky.night >= 0.6;
  const outage = snapshot.meter?.gridOk === false;

  const levels = visible.map((floor) => {
    const z0 = mode === 'building' ? placement(floor.level, cfg).z : 0;
    const dy = 0;
    // en la vista de conjunto la losa sobresale un poco: marca el canto de cada planta
    const slab = prism(FULL, z0, SLAB, cfg, mode === 'building' ? -0.25 : -0.15, dy);
    const zones = ZONES.filter((z) => z.floor === floor.level)
      .map((zone) => ({
        zone,
        p: prism(zone.rect, z0 + SLAB, WALL, cfg, 0.12, dy),
        parts: zone.rects.map((r) => prism(r, z0 + SLAB, WALL, cfg, 0.12, dy)).sort((a, b) => b.depth - a.depth),
      }))
      .sort((a, b) => b.p.depth - a.p.depth);
    const extras = floor.extras.map((e) => ({
      label: e.label,
      p: prism(e.rect, z0 + SLAB, interior ? 2.9 : WALL, cfg, 0.05, dy),
    }));
    return { floor, slab, zones, extras, z0, dy };
  });

  const roof = (() => {
    if (mode === 'floor') {
      return undefined;
    }
    return { z: roofZ, slab: prism(FULL, roofZ, ROOF_DECK, cfg, mode === 'building' ? -0.25 : 0, 0) };
  })();

  // montante eléctrica (vista de conjunto): sube por la esquina más cercana al observador, con flujo ∝ potencia
  const riser = (() => {
    if (mode !== 'building') {
      return undefined;
    }
    const corners = [
      { x: 0, y: 0 },
      { x: BUILDING.width, y: 0 },
      { x: BUILDING.width, y: BUILDING.depth },
      { x: 0, y: BUILDING.depth },
    ];
    const near = corners.reduce((a, c) => {
      const ra = rotate(a.x, a.y, cfg.azimuth);
      const rc = rotate(c.x, c.y, cfg.azimuth);
      return rc.x - rc.y > ra.x - ra.y ? c : a;
    });
    // un poco por fuera de la esquina para que no la tape la fachada
    const nx = near.x === 0 ? -0.6 : near.x + 0.6;
    const ny = near.y === 0 ? -0.6 : near.y + 0.6;
    const pts: Pt[] = [toScreen(nx, ny, -0.2, cfg)];
    for (const l of levels) {
      pts.push(toScreen(nx, ny, l.z0 + SLAB / 2, cfg));
    }
    const kw = snapshot.meter?.pTotal ?? 0;
    return {
      d: `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`,
      base: pts[0],
      kw,
      speed: Math.min(3, Math.max(0.35, 60 / Math.max(kw, 1))),
    };
  })();

  /** Equipo PTAC en la fachada (vista exterior): caja con rejilla en el tercio izquierdo del muro. */
  const ptacOn = (q: Pt[], on: boolean) => {
    const body = faceQuad(q, 0.1, 0.26, 0.08, 0.3);
    return (
      <g pointerEvents="none">
        <path d={path(body)} fill={M.casing} stroke={lit(M.casing, 0.7)} strokeWidth={0.5} />
        <circle cx={onFace(q, 0.235, 0.12).x} cy={onFace(q, 0.235, 0.12).y} r={0.9} fill={on ? '#3d9df3' : '#8e8e8e'} />
      </g>
    );
  };

  /**
   * Vista exterior: volumen con fachada neutra, banda de vidrio con montantes y, al pie de cada zona, una
   * franja con el color de la capa (estado o dato). La cubierta de la planta lleva el tinte translúcido.
   */
  const exteriorZone = (zone: Zone, p: Prism, parts: Prism[]) => {
    const s = snapshot.zones[zone.id];
    const status = statuses[zone.id] ?? 'offline';
    const fill = zoneFill(viewMode, zone, s, ctx);
    const layer = viewMode === 'status' ? statusColors[status] : fill;
    const mk = zoneMark(viewMode === 'status' ? 'status' : 'data', status, layer);
    const focus = selectedId === zone.id || hoveredId === zone.id ? theme.colors.primary.main : undefined;
    const lightsOn = (s?.lights ?? 0) > 0.05;
    const ptac = PTAC_BY_ZONE[zone.id];
    const bandOpacity = status === 'offline' ? 0 : viewMode === 'status' ? (status === 'ok' ? 0.55 : 1) : 0.95;
    const sides = parts.flatMap((part, k) => part.sides.map((side, i) => ({ side, key: `${k}-${i}` })));
    const hatchId =
      mk.hatch === 'offline'
        ? 'offline'
        : mk.hatch === 'alert'
          ? status === 'critical'
            ? 'critical'
            : 'warning'
          : undefined;
    return (
      <>
        {sides.map(({ side, key }) => {
          const q = side.points;
          const wall = faceColor(M.facade, side.facing);
          const lenPx = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
          const n = Math.max(1, Math.round(lenPx / (cfg.scale * 1.5)));
          const glazed = zone.windows?.includes(side.edge);
          const mull: Array<[Pt, Pt]> = [];
          for (let i = 1; i < n; i++) {
            mull.push([onFace(q, i / n, 0.34), onFace(q, i / n, 0.88)]);
          }
          return (
            <g key={key}>
              <path
                d={path(q)}
                fill={wall}
                stroke={focus ?? lit(M.facade, 0.72)}
                strokeWidth={focus ? 2 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
              {mk.tint && mk.tintOpacity > 0 && (
                <path d={path(q)} fill={mk.tint} fillOpacity={mk.tintOpacity * 0.35} pointerEvents="none" />
              )}
              {glazed && (
                <>
                  <path
                    d={path(faceQuad(q, 0, 1, 0.34, 0.88))}
                    fill={`url(#${idPrefix}-${lightsOn && night ? 'glassLit' : 'glass'})`}
                    opacity={side.facing === 'front' ? 1 : 0.88}
                    pointerEvents="none"
                  />
                  <path d={segments(mull)} stroke={M.mullion} strokeWidth={0.6} pointerEvents="none" />
                </>
              )}
              {bandOpacity > 0 && (
                <path
                  d={path(faceQuad(q, 0, 1, 0.04, glazed ? 0.22 : 0.2))}
                  fill={side.facing === 'front' ? layer : lit(blend(layer, '#808080', 0.9), 0.82)}
                  opacity={bandOpacity}
                  pointerEvents="none"
                />
              )}
              {ptac && ptac.facade === side.edge && ptacOn(q, !!s?.hvacOn)}
            </g>
          );
        })}
        {parts.map((part, k) => (
          <path
            key={`top${k}`}
            d={path(part.top)}
            fill={M.slab}
            stroke={parts.length > 1 ? M.slab : (focus ?? mk.outline ?? lit(M.slab, 0.8))}
            strokeWidth={focus ? (selectedId === zone.id ? 3 : 2) : parts.length > 1 ? 0.5 : mk.outlineWidth}
            strokeDasharray={focus && selectedId !== zone.id ? '5 3' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {mk.tint &&
          parts.map((part, k) => (
            <path key={`tn${k}`} d={path(part.top)} fill={mk.tint} fillOpacity={mk.tintOpacity} pointerEvents="none" />
          ))}
        {hatchId &&
          parts.map((part, k) => (
            <path key={`h${k}`} d={path(part.top)} fill={`url(#${idPrefix}-hatchs-${hatchId})`} pointerEvents="none" />
          ))}
        {focus &&
          parts.map((part, k) => (
            <path
              key={`f${k}`}
              d={path(part.top)}
              fill={focus}
              fillOpacity={selectedId === zone.id ? 0.22 : 0.12}
              pointerEvents="none"
            />
          ))}
      </>
    );
  };

  // --- rótulos laterales de la vista de conjunto (una tarjeta por planta y otra para la azotea)
  const summaries: Array<LevelSummary & { pv?: number }> =
    mode === 'building'
      ? [...FLOORS.map((f) => floorSummary(f.level, snapshot, statuses)), roofSummary(snapshot, statuses)]
      : [];
  const sideLabels = (() => {
    if (mode !== 'building') {
      return [];
    }
    // esquina con menor x en pantalla: la arista vertical izquierda del volumen
    const corner = [
      { x: 0, y: 0 },
      { x: BUILDING.width, y: 0 },
      { x: BUILDING.width, y: BUILDING.depth },
      { x: 0, y: BUILDING.depth },
    ].reduce((a, c) => (toScreen(c.x, c.y, 0, cfg).x < toScreen(a.x, a.y, 0, cfg).x ? c : a));
    const bandPx = (BUILDING.floorHeight + (cfg.stackGap ?? 0)) * cfg.scale * fit.k;
    const tall = bandPx >= 40 && !compactLabels;
    const h = tall ? 40 : bandPx < 26 ? 20 : 24;
    const items = summaries.map((sm) => {
      const z = sm.key === 'roof' ? roofZ + 0.9 : placement(sm.key, cfg).z + BUILDING.floorHeight / 2;
      const a = toScreen(corner.x, corner.y, z, cfg);
      return { sm, a, id: String(sm.key) };
    });
    const offsets = declutter(
      items.map((it) => ({ id: it.id, x: it.a.x, y: it.a.y, w: sideLabelW * u, h: h * u })),
      3 * u
    );
    return items.map((it) => ({ ...it, h, tall, off: offsets[it.id] ?? 0 }));
  })();

  const zoneEventKinds = (zone: Zone) =>
    (snapshot.zones[zone.id]?.events ?? []).filter((k) => k !== 'ola_calor' && k !== 'corte_energia') as EventKind[];
  const floorEvent = (level: number): EventKind | undefined =>
    ZONES.filter((z) => z.floor === level).flatMap(zoneEventKinds)[0];

  const sideLabel = ({
    sm,
    a,
    h,
    tall,
    off,
  }: {
    sm: LevelSummary & { pv?: number };
    a: Pt;
    h: number;
    tall: boolean;
    off: number;
  }) => {
    const W = sideLabelW;
    const lead = 18;
    const color = statusColors[sm.status];
    const alarms = sm.crit + sm.warn;
    const badge = sm.crit ? statusColors.critical : statusColors.warning;
    const ev = sm.key === 'roof' ? undefined : floorEvent(sm.key);
    const detail =
      sm.key === 'roof'
        ? tall
          ? `VRF ${fmtKw(sm.kw)}${sm.pv !== undefined && pv ? ` · FV ${fmtKw(sm.pv)}` : ''}`
          : sm.pv !== undefined && pv
            ? `FV ${fmtKw(sm.pv)}`
            : `VRF ${fmtKw(sm.kw)}`
        : `${fmtTemp(sm.temp)} · ${fmtKw(sm.kw)}`;
    const x0 = -lead - W;
    const offPx = off / u;
    return (
      <g
        key={`lbl-${sm.key}`}
        transform={`translate(${a.x.toFixed(1)},${a.y.toFixed(1)}) scale(${u})`}
        className={styles.sideLabel}
        data-testid={`ems-level-label-${sm.short}`}
        onClick={() => onSelectFloor?.(sm.key)}
        role="button"
        aria-label={`Ver ${sm.name}`}
      >
        <path
          d={`M0,0 L${-lead / 2},${offPx} L${-lead},${offPx}`}
          fill="none"
          stroke={ink2}
          strokeWidth={1}
          opacity={0.7}
        />
        <circle r={2.5} fill={ink2} />
        <g transform={`translate(0,${offPx.toFixed(1)})`}>
          <rect
            x={x0}
            y={-h / 2}
            width={W}
            height={h}
            rx={5}
            fill={surface}
            stroke={sm.status === 'critical' || sm.status === 'warning' ? color : theme.colors.border.medium}
            strokeWidth={sm.status === 'critical' || sm.status === 'warning' ? 1.5 : 1}
          />
          <rect x={x0} y={-h / 2} width={5} height={h} rx={2} fill={color} />
          {tall ? (
            <>
              <text x={x0 + 13} y={-3} className={styles.levelShort} fill={ink}>
                {sm.key === 'roof' ? 'Azotea' : sm.short}
              </text>
              {sm.key !== 'roof' && (
                <text x={x0 + 44} y={-3} className={styles.levelName} fill={ink2}>
                  {sm.name}
                </text>
              )}
              <text x={x0 + 13} y={14} className={styles.levelDetail} fill={ink}>
                {detail}
              </text>
            </>
          ) : (
            <text
              x={x0 + 12}
              y={4.5}
              className={styles.levelDetail}
              fill={ink}
              style={h < 24 ? { fontSize: 11.5 } : undefined}
            >
              <tspan fontWeight={700}>{sm.key === 'roof' ? 'AZ' : sm.short}</tspan>
              {`  ${detail}`}
            </text>
          )}
          {ev && (
            <Glyph
              name={EVENTS[ev].glyph}
              x={-lead - (alarms ? 42 : 22)}
              y={-8}
              size={16}
              color={EVENTS[ev].level === 'crit' ? statusColors.critical : statusColors.warning}
            />
          )}
          {alarms > 0 && (
            <g transform={`translate(${-lead - 13},0)`}>
              <circle r={8.5} fill={badge} />
              <text y={4} textAnchor="middle" className={styles.badge} fill="#fff">
                {alarms}
              </text>
            </g>
          )}
        </g>
      </g>
    );
  };

  const eventMarker = (zone: Zone, top: Pt) => {
    const s = snapshot.zones[zone.id];
    // sobre el piso de la zona: el rótulo flota encima del muro y no queda tapado
    const c = { x: top.x, y: top.y + WALL * cfg.scale };
    const kinds = zoneEventKinds(zone);
    if (!kinds.length && !s.fire) {
      return null;
    }
    const color = EVENTS[kinds[0] ?? 'incendio'].level === 'crit' ? '#f2495c' : '#ff9830';
    return (
      <g key={`ev-${zone.id}`} pointerEvents="none" data-testid={`ems-event-marker-${zone.id}`}>
        {s.fire && (
          <>
            <ellipse
              key={animate ? 'fire-a' : 'fire'}
              cx={c.x}
              cy={c.y}
              rx={cfg.scale * 3.2}
              ry={cfg.scale * 1.8}
              fill={`url(#${idPrefix}-fire)`}
              {...(animate ? mo({ attr: 'opacity', values: [0.75, 1, 0.6, 0.9, 0.75], dur: 0.8 }) : {})}
            />
            {[0, 1, 2].map((i) => (
              <circle
                key={`${i}${animate ? 'a' : ''}`}
                cx={c.x + (i - 1) * 8}
                cy={c.y - 10}
                r={6}
                fill={dark ? '#777' : '#555'}
                opacity={0}
                {...(animate
                  ? mo(
                      { attr: 'translate', values: ['0,4', '0,-60'], dur: 2.4, offset: -i * 0.8 },
                      { attr: 'r', values: [5, 16], dur: 2.4, offset: -i * 0.8 },
                      { attr: 'opacity', values: [0.55, 0], dur: 2.4, offset: -i * 0.8 }
                    )
                  : {})}
              />
            ))}
          </>
        )}
        <g transform={`translate(${c.x.toFixed(1)},${c.y.toFixed(1)}) scale(${u})`}>
          <circle
            key={animate ? 'ring-a' : 'ring'}
            r={13}
            fill={surface}
            stroke={color}
            strokeWidth={2}
            {...(animate ? mo({ attr: 'r', values: [13, 14.5, 13], dur: 1.2 }) : {})}
          />
          <Glyph name={EVENTS[kinds[0] ?? 'incendio'].glyph} x={-8} y={-8} size={16} color={color} />
        </g>
      </g>
    );
  };

  const shadowFor = (z0: number) => (
    <path
      d={path(prism(FULL, z0 - 0.3, 0.05, cfg).top)}
      fill="#000"
      opacity={M.shadowOpacity}
      filter={`url(#${idPrefix}-soft)`}
      transform={`translate(${cfg.scale * 0.9},${cfg.scale * 1.3})`}
      pointerEvents="none"
    />
  );

  /** Losa con canto visible: caras con la luz de la escena y filo claro en las aristas superiores. */
  const slabEl = (slab: Prism, top: string, key: string) => (
    <g key={key} pointerEvents="none">
      {slab.sides.map((sd, i) => (
        <path key={i} d={path(sd.points)} fill={faceColor(M.slabEdge, sd.facing)} />
      ))}
      <path d={path(slab.top)} fill={top} />
      <path
        d={`M${slab.top[3].x.toFixed(1)},${slab.top[3].y.toFixed(1)}L${slab.top[0].x.toFixed(1)},${slab.top[0].y.toFixed(1)}L${slab.top[1].x.toFixed(1)},${slab.top[1].y.toFixed(1)}L${slab.top[2].x.toFixed(1)},${slab.top[2].y.toFixed(1)}`}
        fill="none"
        stroke={lit(top, dark ? 1.25 : 1.08)}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );

  /** Núcleo del elevador: caja de hormigón con hueco, puertas de acero hacia el pasillo y rótulo. */
  const coreEl = (p: Prism, rect: { x: number; y: number; w: number; d: number }, z: number, label?: string) => {
    const color = interior ? blend(M.wall, M.slab, 0.45) : M.facade;
    return (
      <>
        {p.sides.map((sd, j) => (
          <g key={j}>
            <path d={path(sd.points)} fill={faceColor(color, sd.facing)} stroke={lit(color, 0.75)} strokeWidth={0.4} />
            {interior && sd.edge === 'n' && (
              <path
                d={path(faceQuad(sd.points, 0.28, 0.72, 0.02, 0.74))}
                fill={faceColor(M.metal, sd.facing)}
                stroke={lit(M.metal, 0.7)}
                strokeWidth={0.4}
              />
            )}
          </g>
        ))}
        <path d={path(p.top)} fill={lit(color, 1.08)} stroke={lit(color, 0.75)} strokeWidth={0.4} />
        {interior && (
          <rect
            x={rect.x + 0.25}
            y={rect.y + 0.25}
            width={rect.w - 0.5}
            height={rect.d - 0.5}
            fill={lit(color, 0.45)}
            transform={planeMatrix(z + 0.001, cfg)}
          />
        )}
        {interior && label && fit.k >= 1.2 && (
          <text
            transform={`translate(${p.center.x.toFixed(1)},${p.center.y.toFixed(1)}) scale(${u})`}
            y={4}
            textAnchor="middle"
            fill={ink2}
            className={styles.extraLabel}
          >
            {label === 'Elevador' ? 'Ascensor' : label}
          </text>
        )}
      </>
    );
  };

  // --- fichas de zona (vista de planta): tamaño fijo en px, prioridad a selección y alarmas, sin solaparse
  const chips = (() => {
    // escala diminuta (panel pequeño): sin fichas, el detalle queda en el paso del mouse
    if (mode !== 'floor' || fit.k < 0.62) {
      return [];
    }
    const small = fit.k < 1.05;
    const rank = (id: string) =>
      id === selectedId ? 0 : statuses[id] === 'critical' ? 1 : statuses[id] === 'warning' ? 2 : 3;
    const items = levels
      .flatMap((l) =>
        l.zones.map(({ zone }) => {
          const a = tagAnchor(zone, l.z0, l.dy, cfg, interior ? 0 : WALL);
          const value = zoneLabel(viewMode, zone, snapshot.zones[zone.id]);
          const name = small ? '' : shortZoneName(zone);
          const sz = chipSize(zone.id, name, value, manual.has(zone.id), small);
          return { zone, a, value, name, sz };
        })
      )
      .sort((p, q) => rank(p.zone.id) - rank(q.zone.id) || p.a.y - q.a.y);
    const lift = 12;
    const boxes: LabelBox[] = items.map((it) => ({
      id: it.zone.id,
      x: it.a.x,
      y: it.a.y - (it.sz.h / 2 + lift) * u,
      w: it.sz.w * u,
      h: it.sz.h * u,
    }));
    const obstacles: LabelBox[] = levels.flatMap(({ zones }) =>
      zones
        .filter(({ zone }) => snapshot.zones[zone.id]?.events?.length)
        .map(({ zone, p }) => ({
          id: `ev-${zone.id}`,
          x: p.center.x,
          y: p.center.y + WALL * cfg.scale,
          w: 30 * u,
          h: 30 * u,
        }))
    );
    const bounds = {
      x: box.x + insets.left * u,
      y: box.y + insets.top * u,
      w: box.w - (insets.left + insets.right) * u,
      h: box.h - (insets.top + insets.bottom) * u,
    };
    const offs = placeLabels(boxes, { gap: 4 * u, bounds, obstacles });
    return items.map((it, k) => ({ ...it, small, box: boxes[k], off: offs[it.zone.id] ?? { dx: 0, dy: 0 } }));
  })();

  return (
    <svg
      ref={svgRef}
      className={styles.svg}
      viewBox={`${box.x.toFixed(2)} ${box.y.toFixed(2)} ${box.w.toFixed(2)} ${box.h.toFixed(2)}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid="ems-building"
      data-view={mode}
      data-animated={animate ? 'si' : 'no'}
      role="img"
      aria-label={
        mode === 'roof'
          ? 'Azotea con las unidades VRF y la fotovoltaica'
          : mode === 'floor'
            ? `${visible[0]?.name ?? ''}: zonas del EMS`
            : `Edificio con las ${FLOORS.length} plantas y las ${ZONES.length} zonas del EMS`
      }
    >
      <SceneDefs
        id={idPrefix}
        M={M}
        statusColors={statusColors}
        ink2={ink2}
        sky={sky}
        night={night}
        blur={cfg.scale * 0.9}
      />

      <rect
        x={box.x - box.w}
        y={box.y - box.h}
        width={box.w * 3}
        height={box.h * 3}
        fill={`url(#${idPrefix}-sky)`}
        pointerEvents="none"
        data-testid="ems-sky"
        data-night={sky.night >= 1 ? 'si' : 'no'}
      />
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${idPrefix}-vignette)`} pointerEvents="none" />

      {mode === 'building' && (
        <>
          {/* terreno: plaza pavimentada alrededor del edificio */}
          <g transform={planeMatrix(-0.05, cfg)} pointerEvents="none">
            <rect
              x={-PLAZA}
              y={-PLAZA}
              width={BUILDING.width + 2 * PLAZA}
              height={BUILDING.depth + 2 * PLAZA}
              fill={M.ground}
              stroke={M.groundEdge}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={-PLAZA}
              y={-PLAZA}
              width={BUILDING.width + 2 * PLAZA}
              height={BUILDING.depth + 2 * PLAZA}
              fill={`url(#${idPrefix}-fl-stone)`}
            />
          </g>
          {shadowFor(0)}
        </>
      )}
      {mode !== 'building' && shadowFor(0)}

      {riser && (
        <g data-testid="ems-riser" pointerEvents="none">
          <path
            d={riser.d}
            fill="none"
            stroke={lit('#b07800', dark ? 1 : 1.1)}
            strokeWidth={4}
            strokeLinejoin="round"
            opacity={0.45}
            vectorEffect="non-scaling-stroke"
          />
          <path
            key={animate ? 'flow-a' : 'flow'}
            d={riser.d}
            fill="none"
            stroke="#fab219"
            strokeWidth={2}
            strokeDasharray="5 7"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            {...(animate ? mo({ attr: 'stroke-dashoffset', values: [24, 0], dur: riser.speed }) : {})}
          />
        </g>
      )}

      {levels.map(({ floor, slab, zones, extras, z0, dy }) => (
        <g key={floor.level} data-testid={`ems-floor-${floor.short}`}>
          {slabEl(slab, M.slab, 'slab')}
          {[
            ...extras.map((e, i) => ({ kind: 'extra' as const, depth: e.p.depth, e, i })),
            ...zones.map((z) => ({ kind: 'zone' as const, depth: z.p.depth, z })),
          ]
            .sort((a, b) => b.depth - a.depth)
            .map((it) => {
              if (it.kind === 'extra') {
                const { p, label } = it.e;
                return (
                  <g key={`x${it.i}`} pointerEvents="none" data-testid={`ems-extra-${floor.short}-${it.i}`}>
                    {coreEl(p, floor.extras[it.i].rect, z0 + SLAB + (interior ? 2.9 : WALL), label)}
                  </g>
                );
              }
              const { zone, p, parts } = it.z;
              const status = statuses[zone.id] ?? 'offline';
              const s = snapshot.zones[zone.id];
              const blinking = status === 'critical' && unacknowledged.has(zone.id);
              const fill = zoneFill(viewMode, zone, s, ctx);
              const layer = viewMode === 'status' ? statusColors[status] : fill;
              return (
                <g
                  key={zone.id}
                  className={cx(styles.zone, blinking && styles.blink)}
                  data-testid={`ems-zone-${zone.id}`}
                  data-status={status}
                  onMouseMove={(e) => onHover(zone, e)}
                  onMouseLeave={onLeave}
                  onClick={() => onSelect(zone)}
                >
                  {interior ? (
                    <ZoneInterior
                      idPrefix={idPrefix}
                      zone={zone}
                      state={s}
                      status={status}
                      mark={zoneMark(viewMode === 'status' ? 'status' : 'data', status, layer)}
                      finish={floorFinish(zone.type, dark)}
                      selected={selectedId === zone.id}
                      hovered={hoveredId === zone.id}
                      z0={z0}
                      dy={dy}
                      iso={cfg}
                      animate={animate}
                      M={M}
                      detail={fit.k >= 1.1 ? 1 : 0.85}
                      simple={fit.k < 1.1}
                      accent={theme.colors.primary.main}
                      night={night}
                    />
                  ) : (
                    exteriorZone(zone, p, parts)
                  )}
                </g>
              );
            })}
        </g>
      ))}

      {riser && (
        <g
          pointerEvents="none"
          transform={`translate(${riser.base.x.toFixed(1)},${riser.base.y.toFixed(1)}) scale(${u})`}
          data-testid="ems-riser-kw"
        >
          <rect x={-38} y={8} width={76} height={22} rx={4} fill={surface} stroke={theme.colors.border.medium} />
          <Glyph name="bolt" x={-31} y={12} size={14} color="#eda100" />
          <text x={8} y={23} textAnchor="middle" className={styles.chipText} fill={ink}>
            {riser.kw.toFixed(0)} kW
          </text>
        </g>
      )}

      {roof && (
        <g data-testid="ems-roof">
          {slabEl(roof.slab, M.membrane, 'roofslab')}
          <Rooftop
            idPrefix={idPrefix}
            units={VRF_UNITS}
            pv={pv}
            z={roof.z + ROOF_DECK}
            dy={0}
            height={mode === 'roof' ? 1.3 : 1}
            iso={cfg}
            snapshot={snapshot}
            animate={animate}
            M={M}
            labelColor={ink}
            labelColor2={ink2}
            surface={surface}
            border={theme.colors.border.medium}
            accent={theme.colors.primary.main}
            compact={mode !== 'roof'}
            showLabels={mode === 'roof'}
            labelScale={u}
            hoveredUnit={hoveredUnit}
            onHoverUnit={onHoverUnit}
            onLeaveUnit={onLeaveUnit}
          />
        </g>
      )}

      {/* marcadores de eventos simulados sobre las zonas (en la vista de conjunto van en el rótulo de la planta) */}
      {mode === 'floor' &&
        levels.flatMap(({ zones }) =>
          zones
            .filter(({ zone }) => snapshot.zones[zone.id]?.events?.length)
            .map(({ zone, p }) => eventMarker(zone, p.center))
        )}

      {/* fichas de zona con línea guía cuando se apartan de su ancla */}
      {chips.map(({ zone, a, value, name, small, box: b, off }) => {
        const status = statuses[zone.id] ?? 'offline';
        const cxp = b.x + off.dx;
        const cyp = b.y + off.dy;
        const moved = Math.abs(off.dx) > 1e-6 || Math.abs(off.dy) > 1e-6;
        // punto de la ficha más cercano al ancla
        const ex = Math.min(Math.max(a.x, cxp - b.w / 2), cxp + b.w / 2);
        const ey = Math.min(Math.max(a.y, cyp - b.h / 2), cyp + b.h / 2);
        return (
          <g
            key={`chip-${zone.id}`}
            className={styles.chip}
            data-testid={`ems-tag-${zone.id}`}
            onMouseMove={(e) => onHover(zone, e)}
            onMouseLeave={onLeave}
            onClick={() => onSelect(zone)}
          >
            <line
              x1={a.x}
              y1={a.y}
              x2={moved ? ex : a.x}
              y2={moved ? ey : cyp + b.h / 2}
              stroke={ink2}
              strokeWidth={1}
              opacity={0.65}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            <circle
              cx={a.x}
              cy={a.y}
              r={2.4 * u}
              fill={surface}
              stroke={ink2}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            <g transform={`translate(${cxp.toFixed(2)},${cyp.toFixed(2)}) scale(${u.toFixed(4)})`}>
              <ZoneChip
                id={zone.id}
                name={name}
                value={value}
                status={status}
                statusColor={statusColors[status]}
                manual={manual.has(zone.id)}
                small={small}
                selected={selectedId === zone.id}
                hovered={hoveredId === zone.id}
                colors={chipColors}
                swatch={viewMode === 'status' ? undefined : zoneFill(viewMode, zone, snapshot.zones[zone.id], ctx)}
              />
            </g>
          </g>
        );
      })}

      {sideLabels.map(sideLabel)}

      {outage && (
        <rect
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          fill="#000"
          opacity={dark ? 0.35 : 0.22}
          pointerEvents="none"
          data-testid="ems-blackout"
        />
      )}
    </svg>
  );
};

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
`;

const getStyles = (theme: GrafanaTheme2) => ({
  svg: css`
    width: 100%;
    height: 100%;
    display: block;
    user-select: none;
  `,
  zone: css`
    cursor: pointer;
  `,
  chip: css`
    cursor: pointer;
  `,
  hoverTop: css`
    filter: brightness(1.12);
  `,
  blink: css`
    animation: ${pulse} 1.2s ease-in-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  zoneId: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightBold};
    paint-order: stroke;
    stroke: ${colorManipulator.alpha(theme.colors.background.primary, 0.75)};
    stroke-width: 3px;
  `,
  zoneValue: css`
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    paint-order: stroke;
    stroke: ${colorManipulator.alpha(theme.colors.background.primary, 0.75)};
    stroke-width: 3px;
  `,
  extraLabel: css`
    paint-order: stroke;
    stroke: ${colorManipulator.alpha(theme.colors.background.primary, 0.8)};
    stroke-width: 3px;
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightMedium};
    letter-spacing: 0.04em;
  `,
  sideLabel: css`
    cursor: pointer;
    &:hover rect:first-of-type {
      stroke: ${theme.colors.primary.border};
    }
  `,
  levelShort: css`
    font-size: 15px;
    font-weight: ${theme.typography.fontWeightBold};
  `,
  levelName: css`
    font-size: 12px;
  `,
  levelDetail: css`
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  `,
  badge: css`
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightBold};
  `,
  chipText: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
});
