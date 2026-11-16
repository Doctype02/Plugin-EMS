import React, { useEffect, useRef, useState } from 'react';
import { useElementSize } from './useElementSize';
import { Glyph } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, PTAC_BY_ZONE, VRF_UNITS, VrfUnit, ZONES, Zone } from 'building/model';
import { IsoConfig, Prism, Pt, path, placement, prism, rotate, toScreen } from 'building/iso';
import { localParts } from 'building/clock';
import { EVENTS, EventKind } from 'building/events';
import { Snapshot, Status } from 'building/telemetry';
import { MAX_POWER_DENSITY, ViewMode, mixHex, zoneFill, zoneLabel } from 'building/views';
import {
  Box,
  Insets,
  LevelSummary,
  declutter,
  fitView,
  floorSummary,
  roofSummary,
  shortZoneName,
} from 'building/layout';
import { Rooftop } from './Rooftop';
import { SLAB, ScenePalette, ZoneInterior, tagAnchor, tagSize } from './ZoneInterior';

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
  if (dark) {
    return night >= 1
      ? { top: '#10141c', bottom: '#171b24', night }
      : dusk
        ? { top: '#191a22', bottom: '#201d22', night }
        : { top: '#161a20', bottom: '#1c2027', night };
  }
  return night >= 1
    ? { top: '#e3e7ef', bottom: '#eef0f5', night }
    : dusk
      ? { top: '#eef0f5', bottom: '#f7f2ec', night }
      : { top: '#f3f5f8', bottom: '#fafbfc', night };
}

const shade = (color: string, amount: number) => colorManipulator.darken(color, amount);
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
            top: insets.top + (interior ? 22 : 12),
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
  // losas y muros claros sobre el fondo oscuro (y al revés en el tema claro) para que cada planta se recorte
  const slabColor = dark ? '#596069' : '#b9bdc4';
  const slabEdge = dark ? '#8d949e' : '#8a9099';
  const wallBase = dark ? '#646b75' : '#eceae4';
  const glass = dark ? '#6d8fb8' : '#9fc1e6';
  const FULL = { x: 0, y: 0, w: BUILDING.width, d: BUILDING.depth };
  const palette: ScenePalette = {
    dark,
    ink,
    ink2,
    wall: wallBase,
    glass,
    wood: dark ? '#7d6650' : '#c9a57a',
    metal: dark ? '#7a7f88' : '#b8bcc4',
    rack: dark ? '#202226' : '#3a3d44',
    plant: '#3f9b4f',
    shirts: dark ? ['#9db8d9', '#d9b48f', '#c7c6be', '#a8d0b0'] : ['#3b5f8a', '#8a5a3b', '#4b4a46', '#3f7a52'],
    skin: ['#e0b08a', '#c58c62', '#8d5a3b'],
    surface,
  };

  const hour = localParts(snapshot.time || 0).hour;
  const sky = skyColors(hour, dark);
  const outage = snapshot.meter?.gridOk === false;

  const levels = visible.map((floor) => {
    const z0 = mode === 'building' ? placement(floor.level, cfg).z : 0;
    const dy = 0;
    // en la vista de conjunto la losa sobresale un poco: marca el canto de cada planta
    const slab = prism(FULL, z0, SLAB, cfg, mode === 'building' ? -0.25 : 0, dy);
    const zones = ZONES.filter((z) => z.floor === floor.level)
      .map((zone) => ({
        zone,
        p: prism(zone.rect, z0 + SLAB, WALL, cfg, 0.12, dy),
        parts: zone.rects.map((r) => prism(r, z0 + SLAB, WALL, cfg, 0.12, dy)).sort((a, b) => b.depth - a.depth),
      }))
      .sort((a, b) => b.p.depth - a.p.depth);
    const extras = floor.extras.map((e) => ({
      label: e.label,
      p: prism(e.rect, z0 + SLAB, interior ? 0.6 : WALL, cfg, 0.12, dy),
    }));
    return { floor, slab, zones, extras, z0, dy };
  });

  // --- rótulos de zona (vista de planta): tamaño fijo en px y sin encimarse
  const fullTags = fit.k >= 1.25;
  const tagText = (zone: Zone) => {
    const value = zoneLabel(viewMode, zone, snapshot.zones[zone.id]);
    return fullTags
      ? { title: `${zone.id} · ${shortZoneName(zone)}`, value }
      : { title: '', value: `${zone.id} · ${value}` };
  };
  const labelOffsets: Record<string, number> = {};
  if (interior) {
    for (const l of levels) {
      const boxes = l.zones.map(({ zone }) => {
        const a = tagAnchor(zone, l.z0, l.dy, cfg);
        const t = tagText(zone);
        const sz = tagSize(t.title, t.value, manual.has(zone.id));
        return { id: zone.id, x: a.x, y: a.y, w: sz.w * u, h: sz.h * u };
      });
      Object.assign(labelOffsets, declutter(boxes, 4 * u));
    }
  }

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

  const windowsOn = (face: Prism['sides'][number]) => {
    const [b0, b1, t1, t0] = face.points;
    const n = Math.max(2, Math.round(Math.hypot(b1.x - b0.x, b1.y - b0.y) / (cfg.scale * 2.4)));
    const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    return Array.from({ length: n }, (_, i) => {
      const u0 = (i + 0.25) / n;
      const u1 = (i + 0.75) / n;
      return [
        lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.32),
        lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.32),
        lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.8),
        lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.8),
      ];
    });
  };

  const highlightOf = (zone: Zone, status: Status) =>
    selectedId === zone.id
      ? theme.colors.primary.main
      : status === 'critical' || status === 'warning'
        ? statusColors[status]
        : undefined;
  /** Contorno de la zona: en la vista de estado lleva el color del estado (también "normal"). */
  const outlineOf = (zone: Zone, status: Status, fill: string) =>
    highlightOf(zone, status) ??
    (viewMode === 'status' && status !== 'offline'
      ? colorManipulator.alpha(statusColors[status], 0.85)
      : shade(fill, dark ? 0.1 : 0.3));

  /** Equipo PTAC en la fachada (vista exterior): caja con rejilla en el tercio izquierdo del muro. */
  const ptacOn = (face: Prism['sides'][number], on: boolean) => {
    const [b0, b1, t1, t0] = face.points;
    const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const q = (uu: number, v: number) => lerp(lerp(b0, b1, uu), lerp(t0, t1, uu), v);
    const body = [q(0.12, 0.12), q(0.3, 0.12), q(0.3, 0.32), q(0.12, 0.32)];
    const edge = dark ? '#7a7d82' : '#9da1a8';
    return (
      <g pointerEvents="none">
        <path d={path(body)} fill={dark ? '#c9ccd1' : '#f4f5f6'} stroke={edge} strokeWidth={0.5} />
        <circle cx={q(0.27, 0.15).x} cy={q(0.27, 0.15).y} r={0.9} fill={on ? '#3d9df3' : '#8e8e8e'} />
      </g>
    );
  };

  /** Vista exterior: caja sólida; la fachada de cada zona lleva el color de la vista (franjas por planta). */
  const exteriorZone = (zone: Zone, p: Prism, parts: Prism[]) => {
    const s = snapshot.zones[zone.id];
    const status = statuses[zone.id] ?? 'offline';
    const fill = zoneFill(viewMode, zone, s, ctx);
    const highlight = highlightOf(zone, status);
    const lit = (s?.lights ?? 0) > 0.05;
    const ptac = PTAC_BY_ZONE[zone.id];
    const facade = mixHex(fill, wallBase, 0.82);
    const sides = parts.flatMap((part, k) => part.sides.map((side, i) => ({ side, key: `${k}-${i}` })));
    return (
      <>
        {sides.map(({ side, key }) => {
          const wall = side.facing === 'front' ? shade(facade, 0.04) : shade(facade, dark ? 0.2 : 0.14);
          return (
            <g key={key}>
              <path
                d={path(side.points)}
                fill={wall}
                stroke={highlight ?? shade(wall, 0.3)}
                strokeWidth={highlight ? 2 : 0.6}
                vectorEffect="non-scaling-stroke"
              />
              {zone.windows?.includes(side.edge) &&
                windowsOn(side).map((w, j) => (
                  <path
                    key={j}
                    d={path(w)}
                    fill={
                      lit
                        ? colorManipulator.alpha('#ffe08a', side.facing === 'front' ? 0.8 : 0.65)
                        : colorManipulator.alpha(shade(glass, side.facing === 'front' ? 0.25 : 0.4), 0.75)
                    }
                  />
                ))}
              {ptac && ptac.facade === side.edge && ptacOn(side, !!s?.hvacOn)}
            </g>
          );
        })}
        {parts.map((part, k) => (
          <path
            key={`top${k}`}
            d={path(part.top)}
            fill={fill}
            stroke={parts.length > 1 ? fill : outlineOf(zone, status, fill)}
            strokeWidth={highlight ? (selectedId === zone.id ? 3 : 2) : 1}
            vectorEffect="non-scaling-stroke"
            className={hoveredId === zone.id ? styles.hoverTop : undefined}
          />
        ))}
        {status === 'offline' &&
          parts.map((part, k) => (
            <path key={`h${k}`} d={path(part.top)} fill={`url(#${idPrefix}-hatch)`} pointerEvents="none" />
          ))}
        {mode === 'floor' && (
          <g
            pointerEvents="none"
            transform={`translate(${p.center.x.toFixed(1)},${p.center.y.toFixed(1)}) scale(${u})`}
          >
            <text y={-2} textAnchor="middle" className={styles.zoneId} fill={ink}>
              {zone.id}
              {manual.has(zone.id) ? ' · M' : ''}
            </text>
            <text y={13} textAnchor="middle" className={styles.zoneValue} fill={ink}>
              {zoneLabel(viewMode, zone, s)}
            </text>
          </g>
        )}
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
            <ellipse cx={c.x} cy={c.y} rx={cfg.scale * 3.2} ry={cfg.scale * 1.8} fill={`url(#${idPrefix}-fire)`}>
              {animate && (
                <animate attributeName="opacity" values="0.75;1;0.6;0.9;0.75" dur="0.8s" repeatCount="indefinite" />
              )}
            </ellipse>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={c.x + (i - 1) * 8} cy={c.y - 10} r={6} fill={dark ? '#777' : '#555'} opacity={0}>
                {animate && (
                  <>
                    <animate
                      attributeName="cy"
                      values={`${c.y - 6};${c.y - 70}`}
                      dur="2.4s"
                      begin={`${i * 0.8}s`}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="r"
                      values="5;16"
                      dur="2.4s"
                      begin={`${i * 0.8}s`}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.55;0"
                      dur="2.4s"
                      begin={`${i * 0.8}s`}
                      repeatCount="indefinite"
                    />
                  </>
                )}
              </circle>
            ))}
          </>
        )}
        <g transform={`translate(${c.x.toFixed(1)},${c.y.toFixed(1)}) scale(${u})`}>
          <circle r={13} fill={surface} stroke={color} strokeWidth={2}>
            {animate && <animate attributeName="r" values="13;14.5;13" dur="1.2s" repeatCount="indefinite" />}
          </circle>
          <Glyph name={EVENTS[kinds[0] ?? 'incendio'].glyph} x={-8} y={-8} size={16} color={color} />
        </g>
      </g>
    );
  };

  const shadowFor = (z0: number) => (
    <path
      d={path(prism(FULL, z0 - 0.3, 0.05, cfg).top)}
      fill="#000"
      opacity={dark ? 0.45 : 0.14}
      filter={`url(#${idPrefix}-soft)`}
      transform={`translate(${cfg.scale * 0.8},${cfg.scale * 1.2})`}
      pointerEvents="none"
    />
  );

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
      <defs>
        <pattern
          id={`${idPrefix}-hatch`}
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1={0} y1={0} x2={0} y2={6} stroke={ink2} strokeWidth={1} opacity={0.5} />
        </pattern>
        <linearGradient id={`${idPrefix}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={sky.top} />
          <stop offset="100%" stopColor={sky.bottom} />
        </linearGradient>
        <filter id={`${idPrefix}-soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={cfg.scale * 0.9} />
        </filter>
        <radialGradient id={`${idPrefix}-fire`}>
          <stop offset="0%" stopColor="#ffdd55" stopOpacity={0.95} />
          <stop offset="45%" stopColor="#ff7a1a" stopOpacity={0.75} />
          <stop offset="100%" stopColor="#e0301e" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${idPrefix}-glow`}>
          <stop offset="0%" stopColor="#ffe9a8" stopOpacity={0.95} />
          <stop offset="100%" stopColor="#ffe9a8" stopOpacity={0} />
        </radialGradient>
      </defs>

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

      {mode === 'building' && (
        <>
          {/* terreno: plaza pavimentada alrededor del edificio */}
          <path
            d={path(
              prism(
                { x: -PLAZA, y: -PLAZA, w: BUILDING.width + 2 * PLAZA, d: BUILDING.depth + 2 * PLAZA },
                -0.1,
                0.05,
                cfg
              ).top
            )}
            fill={dark ? '#20242b' : '#e4e7eb'}
            stroke={dark ? '#2e333b' : '#d0d4da'}
            pointerEvents="none"
          />
          {shadowFor(0)}
        </>
      )}
      {mode !== 'building' && shadowFor(0)}

      {riser && (
        <g data-testid="ems-riser" pointerEvents="none">
          <path
            d={riser.d}
            fill="none"
            stroke={shade('#eda100', 0.35)}
            strokeWidth={4}
            strokeLinejoin="round"
            opacity={0.5}
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={riser.d}
            fill="none"
            stroke="#fab219"
            strokeWidth={2}
            strokeDasharray="5 7"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          >
            {animate && (
              <animate
                attributeName="stroke-dashoffset"
                from="24"
                to="0"
                dur={`${riser.speed.toFixed(2)}s`}
                repeatCount="indefinite"
              />
            )}
          </path>
        </g>
      )}

      {levels.map(({ floor, slab, zones, extras, z0, dy }) => (
        <g key={floor.level} data-testid={`ems-floor-${floor.short}`}>
          {slab.sides.map((sd, i) => (
            <path
              key={i}
              d={path(sd.points)}
              fill={mode === 'building' ? shade(slabEdge, i ? 0.22 : 0.06) : shade(slabColor, i ? 0.25 : 0.12)}
            />
          ))}
          <path
            d={path(slab.top)}
            fill={slabColor}
            stroke={mode === 'building' ? slabEdge : shade(slabColor, 0.2)}
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
          {extras.map(({ p, label }, i) => (
            <g key={`x${i}`} pointerEvents="none" data-testid={`ems-extra-${floor.short}-${i}`}>
              {p.sides.map((sd, j) => (
                <path key={j} d={path(sd.points)} fill={shade(slabColor, 0.15 + j * 0.1)} />
              ))}
              <path d={path(p.top)} fill={shade(slabColor, 0.05)} stroke={shade(slabColor, 0.3)} strokeWidth={0.5} />
              {interior && label && fit.k >= 1.2 && (
                <text
                  transform={`translate(${p.center.x.toFixed(1)},${p.center.y.toFixed(1)}) scale(${u})`}
                  y={4}
                  textAnchor="middle"
                  fill={ink2}
                  className={styles.extraLabel}
                >
                  {label}
                </text>
              )}
            </g>
          ))}
          {zones.map(({ zone, p, parts }) => {
            const status = statuses[zone.id] ?? 'offline';
            const s = snapshot.zones[zone.id];
            const blinking = status === 'critical' && unacknowledged.has(zone.id);
            const fill = zoneFill(viewMode, zone, s, ctx);
            const t = tagText(zone);
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
                    fill={fill}
                    highlight={highlightOf(zone, status)}
                    outline={outlineOf(zone, status, fill)}
                    selected={selectedId === zone.id}
                    offline={status === 'offline'}
                    z0={z0}
                    dy={dy}
                    iso={cfg}
                    animate={animate}
                    palette={palette}
                    title={t.title}
                    label={t.value}
                    manual={manual.has(zone.id)}
                    statusColor={statusColors[status]}
                    labelScale={u}
                    labelOffset={labelOffsets[zone.id] ?? 0}
                    detail={fit.k >= 1.6 ? 0.8 : 0.5}
                    hovered={hoveredId === zone.id}
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
          <rect x={-38} y={8} width={76} height={20} rx={10} fill={surface} stroke="#eda100" />
          <Glyph name="bolt" x={-32} y={11} size={14} color="#eda100" />
          <text x={8} y={22} textAnchor="middle" className={styles.chipText} fill={ink}>
            {riser.kw.toFixed(0)} kW
          </text>
        </g>
      )}

      {roof && (
        <g data-testid="ems-roof">
          {roof.slab.sides.map((sd, i) => (
            <path
              key={i}
              d={path(sd.points)}
              fill={mode === 'building' ? shade(slabEdge, i ? 0.22 : 0.06) : shade(slabColor, i ? 0.25 : 0.12)}
            />
          ))}
          <path
            d={path(roof.slab.top)}
            fill={dark ? '#4a5058' : '#cfd2d7'}
            stroke={mode === 'building' ? slabEdge : shade(slabColor, 0.2)}
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
          <Rooftop
            units={VRF_UNITS}
            pv={pv}
            z={roof.z + ROOF_DECK}
            dy={0}
            height={mode === 'roof' ? 1.3 : 1}
            iso={cfg}
            snapshot={snapshot}
            animate={animate}
            dark={dark}
            labelColor={ink}
            surface={surface}
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
