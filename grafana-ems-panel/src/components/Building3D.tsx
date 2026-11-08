import React, { useEffect, useState } from 'react';
import { Glyph } from './Glyph';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, VRF_UNITS, VRF_UNITS_STACKED, VrfUnit, ZONES, Zone } from 'building/model';
import {
  IsoConfig,
  Prism,
  Pt,
  bounds,
  path,
  placement,
  planeMatrix,
  pointDepth,
  prism,
  rotate,
  toScreen,
} from 'building/iso';
import { localParts } from 'building/clock';
import { EVENTS, EventKind } from 'building/events';
import { Snapshot, Status } from 'building/telemetry';
import { MAX_POWER_DENSITY, ViewMode, zoneFill, zoneLabel } from 'building/views';
import { Rooftop } from './Rooftop';
import { SLAB, ScenePalette, ZoneInterior } from './ZoneInterior';

interface Props {
  idPrefix: string;
  snapshot: Snapshot;
  statuses: Record<string, Status>;
  statusColors: Record<Status, string>;
  viewMode: ViewMode;
  iso: IsoConfig;
  /** Pisos visibles (en vista "un piso" sólo uno). */
  floors: number[];
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
}

/** Colores del cielo según la hora (noche → amanecer → día → atardecer). */
export function skyColors(hour: number, dark: boolean): { top: string; bottom: string; night: number } {
  const night = hour < 5.5 || hour > 19 ? 1 : hour < 7 ? (7 - hour) / 1.5 : hour > 17.5 ? (hour - 17.5) / 1.5 : 0;
  const dusk = (hour > 5.5 && hour < 7.5) || (hour > 17 && hour < 19);
  // fondo sobrio: sólo un matiz que sugiere la hora (día neutro, atardecer cálido, noche azulada)
  if (dark) {
    return night >= 1
      ? { top: '#0f131c', bottom: '#151922', night }
      : dusk
        ? { top: '#191a22', bottom: '#201d22', night }
        : { top: '#161a20', bottom: '#1b1f25', night };
  }
  return night >= 1
    ? { top: '#dde2ec', bottom: '#e9ecf2', night }
    : dusk
      ? { top: '#eceef4', bottom: '#f6f0ea', night }
      : { top: '#f1f4f7', bottom: '#f8f9fb', night };
}

const TREES: Array<[number, number, number]> = [
  [-2.8, -2.8, 1.1],
  [23, -2.6, 1.2],
  [23.2, 11, 1.0],
  [-2.6, 22.4, 1.2],
  [22.8, 22.8, 1.1],
];

const shade = (color: string, amount: number) => colorManipulator.darken(color, amount);
const ROOF_DECK = 0.25;

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

export const Building3D: React.FC<Props> = ({
  idPrefix,
  snapshot,
  statuses,
  statusColors,
  viewMode,
  iso,
  floors,
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
}) => {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const reduced = useReducedMotion();
  const animate = animateOption && !reduced;
  const dark = theme.isDark;
  const showAllFloors = floors.length === FLOORS.length;
  const exploded = iso.layout === 'exploded';
  const WALL = exploded ? BUILDING.floorHeight * 0.8 : BUILDING.floorHeight - SLAB;
  const visible = FLOORS.filter((f) => floors.includes(f.level));
  const slotOf = (level: number) =>
    exploded ? visible.findIndex((f) => f.level === level) : showAllFloors ? level : 0;
  // en la vista explotada la azotea va en un recuadro en la esquina libre (no ocupa otro escalón)
  const slots = exploded ? visible.length : showAllFloors ? FLOORS.length : 1;
  const box = bounds(iso, slots, exploded ? 2.5 : 3.5);
  const ctx = { dark, statusColors, status: statuses, maxPowerDensity: MAX_POWER_DENSITY };
  const ink = theme.colors.text.primary;
  const ink2 = theme.colors.text.secondary;
  const slabColor = dark ? '#3a3a37' : '#cfcdc6';
  const wallBase = dark ? '#2c2c2a' : '#e9e7e1';
  const glass = dark ? '#5d7fa6' : '#9fc1e6';
  const FULL = { x: 0, y: 0, w: BUILDING.width, d: BUILDING.depth };
  const palette: ScenePalette = {
    dark,
    ink,
    ink2,
    wall: wallBase,
    glass,
    wood: dark ? '#8a6a4a' : '#c9a57a',
    metal: dark ? '#6f737b' : '#b8bcc4',
    rack: dark ? '#202226' : '#3a3d44',
    plant: '#3f9b4f',
    shirts: dark ? ['#9db8d9', '#d9b48f', '#c7c6be', '#a8d0b0'] : ['#3b5f8a', '#8a5a3b', '#4b4a46', '#3f7a52'],
    skin: ['#e0b08a', '#c58c62', '#8d5a3b'],
    surface: theme.colors.background.primary,
  };

  const hour = localParts(snapshot.time || 0).hour;
  // la vista exterior encuadra más de cerca: letras más pequeñas
  const fs = exploded ? 1 : 0.55;
  const sky = skyColors(hour, dark);
  const outage = snapshot.meter?.gridOk === false;
  const center = pointDepth(BUILDING.width / 2, BUILDING.depth / 2, iso);
  const tree = ([x, y, r]: [number, number, number], k: number) => {
    const base = toScreen(x, y, 0, iso);
    const top = toScreen(x, y, r * 2.4, iso);
    const R = r * iso.scale * 0.85;
    const leaf = dark ? '#3e5a48' : '#7fa48a';
    const leafHi = dark ? '#4d6e58' : '#9cbfa5';
    return (
      <g key={`t${k}`} pointerEvents="none">
        <ellipse
          cx={base.x + R * 0.4}
          cy={base.y + R * 0.15}
          rx={R * 1.1}
          ry={R * 0.5}
          fill="#000"
          opacity={dark ? 0.3 : 0.1}
        />
        <line
          x1={base.x}
          y1={base.y}
          x2={top.x}
          y2={top.y + R * 0.6}
          stroke={dark ? '#5b5348' : '#8c7f6e'}
          strokeWidth={1.6}
        />
        <ellipse cx={top.x} cy={top.y} rx={R} ry={R * 0.92} fill={leaf} />
        <ellipse cx={top.x - R * 0.28} cy={top.y - R * 0.25} rx={R * 0.62} ry={R * 0.55} fill={leafHi} opacity={0.85} />
      </g>
    );
  };
  // sin árboles en el margen izquierdo, donde van los rótulos de piso
  const leftEdge = Math.min(
    ...[0, BUILDING.width].flatMap((x) => [0, BUILDING.depth].map((y) => toScreen(x, y, 0, iso).x))
  );
  const visibleTrees = TREES.filter(([x, y]) => toScreen(x, y, 0, iso).x > leftEdge + iso.scale * 2);
  const treesBack = visibleTrees.filter(([x, y]) => pointDepth(x, y, iso) >= center);
  const treesFront = visibleTrees.filter(([x, y]) => pointDepth(x, y, iso) < center);

  const levels = visible.map((floor) => {
    const { z: z0, dy } = placement(slotOf(floor.level), iso);
    const slab = prism(FULL, z0, SLAB, iso, 0, dy);
    const zones = ZONES.filter((z) => z.floor === floor.level)
      .map((zone) => ({ zone, p: prism(zone.rect, z0 + SLAB, WALL, iso, 0.12, dy) }))
      .sort((a, b) => b.p.depth - a.p.depth);
    const extras = floor.extras.map((e) => prism(e.rect, z0 + SLAB, exploded ? 0.02 : WALL * 0.35, iso, 0.12, dy));
    return { floor, slab, zones, extras, z0, dy };
  });

  const roof = (() => {
    if (!showAllFloors) {
      return undefined;
    }
    if (exploded) {
      // geometría en el origen y luego escalada/trasladada a la esquina superior izquierda libre
      const slab = prism(FULL, 0, ROOF_DECK, iso, 0, 0);
      const pts = [...slab.top, ...slab.sides.flatMap((sd) => sd.points)];
      const rx0 = Math.min(...pts.map((q) => q.x));
      const rx1 = Math.max(...pts.map((q) => q.x));
      const ry0 = Math.min(...pts.map((q) => q.y)) - iso.scale * 3.2; // unidades y rótulos
      const ry1 = Math.max(...pts.map((q) => q.y));
      const pa = levels[levels.length - 1];
      const pb = levels[0];
      const paLeft = Math.min(...pa.slab.top.map((q) => q.x));
      const pbTop = Math.min(...pb.slab.top.map((q) => q.y)) - iso.scale * (WALL + 1.5);
      const pad = iso.scale * 1.2;
      const availW = paLeft - box.x - pad;
      const availH = pbTop - box.y - pad * 2.5;
      const k = Math.max(0.35, Math.min(0.8, availW / (rx1 - rx0), availH / (ry1 - ry0)));
      const tx = box.x + pad - rx0 * k;
      const ty = box.y + pad * 2.2 - ry0 * k;
      return { z: 0, dy: 0, slab, transform: `translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${k.toFixed(3)})`, k };
    }
    const base = placement(FLOORS.length - 1, iso);
    const z = base.z + SLAB + WALL;
    return { z, dy: base.dy, slab: prism(FULL, z, ROOF_DECK, iso, 0, base.dy), transform: undefined, k: 1 };
  })();

  // líneas de proyección entre niveles (vista explotada)
  const connectors: Pt[][] = (() => {
    if (!exploded) {
      return [];
    }
    const slabs = levels.map((l) => l.slab);
    const out: Pt[][] = [];
    for (let i = 0; i + 1 < slabs.length; i++) {
      out.push([slabs[i].top[3], slabs[i + 1].sides[0].points[0]]);
    }
    return out;
  })();

  // montante eléctrica: sube por la esquina más cercana al observador, con flujo ∝ potencia
  const riser = (() => {
    if (!exploded || !showAllFloors) {
      return undefined;
    }
    const corners = [
      { x: 0, y: 0 },
      { x: BUILDING.width, y: 0 },
      { x: BUILDING.width, y: BUILDING.depth },
      { x: 0, y: BUILDING.depth },
    ];
    const near = corners.reduce((a, c) => {
      const ra = rotate(a.x, a.y, iso.azimuth);
      const rc = rotate(c.x, c.y, iso.azimuth);
      return rc.x - rc.y > ra.x - ra.y ? c : a;
    });
    const pts: Pt[] = [toScreen(near.x, near.y, -0.2, iso, 0)];
    for (const l of levels) {
      pts.push(toScreen(near.x, near.y, l.z0, iso, l.dy), toScreen(near.x, near.y, l.z0 + SLAB, iso, l.dy));
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
    const n = Math.max(2, Math.round(Math.hypot(b1.x - b0.x, b1.y - b0.y) / (iso.scale * 2.4)));
    const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    return Array.from({ length: n }, (_, i) => {
      const u0 = (i + 0.18) / n;
      const u1 = (i + 0.82) / n;
      return [
        lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.3),
        lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.3),
        lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.85),
        lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.85),
      ];
    });
  };

  const highlightOf = (zone: Zone, status: Status) =>
    selectedId === zone.id
      ? theme.colors.primary.main
      : status === 'critical' || status === 'warning'
        ? statusColors[status]
        : undefined;

  /** Vista exterior: caja sólida con fachada y ventanas. */
  const exteriorZone = (zone: Zone, p: Prism) => {
    const s = snapshot.zones[zone.id];
    const status = statuses[zone.id] ?? 'offline';
    const fill = zoneFill(viewMode, zone, s, ctx);
    const highlight = highlightOf(zone, status);
    const lit = (s?.lights ?? 0) > 0.05;
    return (
      <>
        {p.sides.map((side, i) => {
          const wall = side.facing === 'front' ? shade(wallBase, 0.12) : shade(wallBase, 0.24);
          return (
            <g key={i}>
              <path d={path(side.points)} fill={wall} stroke={shade(wall, 0.25)} strokeWidth={0.6} />
              {zone.windows?.includes(side.edge) &&
                windowsOn(side).map((w, j) => (
                  <path
                    key={j}
                    d={path(w)}
                    fill={
                      lit
                        ? colorManipulator.alpha('#ffd95a', side.facing === 'front' ? 0.85 : 0.7)
                        : shade(glass, side.facing === 'front' ? 0 : 0.15)
                    }
                  />
                ))}
            </g>
          );
        })}
        <path
          d={path(p.top)}
          fill={fill}
          stroke={highlight ?? shade(fill, 0.35)}
          strokeWidth={highlight ? (selectedId === zone.id ? 3 : 2) : 0.8}
          className={hoveredId === zone.id ? styles.hoverTop : undefined}
        />
        {status === 'offline' && <path d={path(p.top)} fill={`url(#${idPrefix}-hatch)`} pointerEvents="none" />}
        <g pointerEvents="none">
          <text
            x={p.center.x}
            y={p.center.y - 1}
            textAnchor="middle"
            className={styles.zoneId}
            fill={ink}
            style={{ fontSize: 11 * fs, strokeWidth: 3 * fs }}
          >
            {zone.id}
            {manual.has(zone.id) ? ' · M' : ''}
          </text>
          <text
            x={p.center.x}
            y={p.center.y + 12 * fs}
            textAnchor="middle"
            className={styles.zoneValue}
            fill={ink}
            style={{ fontSize: 11 * fs, strokeWidth: 3 * fs }}
          >
            {zoneLabel(viewMode, zone, s)}
          </text>
        </g>
      </>
    );
  };

  return (
    <svg
      className={styles.svg}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid="ems-building"
      data-animated={animate ? 'si' : 'no'}
      role="img"
      aria-label="Edificio en 3D con las 10 zonas del EMS"
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
          <feGaussianBlur stdDeviation={iso.scale * 0.9} />
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
      {/* terreno: plaza pavimentada con juntas, jardineras y acceso */}
      <path
        d={path(prism({ x: -4.5, y: -4.5, w: BUILDING.width + 9, d: BUILDING.depth + 9 }, -0.1, 0.05, iso).top)}
        fill={dark ? '#1c1f24' : '#e6e8eb'}
        stroke={dark ? '#2a2e35' : '#d3d7dc'}
        opacity={exploded ? 0.7 : 1}
        pointerEvents="none"
      />
      <g transform={planeMatrix(-0.04, iso)} pointerEvents="none" opacity={exploded ? 0.35 : 0.6}>
        {Array.from({ length: 15 }, (_, i) => -4.5 + i * 2).map((v) => (
          <g key={v}>
            <line
              x1={v}
              y1={-4.5}
              x2={v}
              y2={BUILDING.depth + 4.5}
              stroke={dark ? '#2a2e35' : '#d3d7dc'}
              strokeWidth={0.04}
            />
            <line
              x1={-4.5}
              y1={v}
              x2={BUILDING.width + 4.5}
              y2={v}
              stroke={dark ? '#2a2e35' : '#d3d7dc'}
              strokeWidth={0.04}
            />
          </g>
        ))}
      </g>
      <path
        d={path(prism({ x: 13, y: -4.5, w: 4, d: 4.5 }, -0.04, 0.05, iso).top)}
        fill={dark ? '#2a2e35' : '#d6dade'}
        opacity={exploded ? 0.7 : 1}
        pointerEvents="none"
      />
      {levels.map((l) => (
        <path
          key={`sh${l.floor.level}`}
          d={path(prism(FULL, l.z0 - 0.3, 0.05, iso, 0, l.dy).top)}
          fill="#000"
          opacity={dark ? 0.45 : 0.16}
          filter={`url(#${idPrefix}-soft)`}
          transform={`translate(${iso.scale * 0.9},${iso.scale * 1.4})`}
          pointerEvents="none"
        />
      ))}
      {treesBack.map(tree)}

      {connectors.map(([a, b], i) => (
        <line
          key={i}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={ink2}
          strokeDasharray="3 4"
          strokeWidth={0.8}
          opacity={0.5}
        />
      ))}

      {riser && (
        <g data-testid="ems-riser" pointerEvents="none">
          <path
            d={riser.d}
            fill="none"
            stroke={shade('#eda100', 0.35)}
            strokeWidth={4}
            strokeLinejoin="round"
            opacity={0.5}
          />
          <path d={riser.d} fill="none" stroke="#fab219" strokeWidth={2} strokeDasharray="5 7" strokeLinejoin="round">
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
            <path key={i} d={path(sd.points)} fill={shade(slabColor, i ? 0.25 : 0.12)} />
          ))}
          <path d={path(slab.top)} fill={slabColor} stroke={shade(slabColor, 0.2)} strokeWidth={0.6} />
          {extras.map((p, i) => (
            <g key={`x${i}`} pointerEvents="none">
              {p.sides.map((sd, j) => (
                <path key={j} d={path(sd.points)} fill={shade(slabColor, 0.15 + j * 0.1)} />
              ))}
              <path d={path(p.top)} fill={shade(slabColor, 0.05)} />
            </g>
          ))}
          {zones.map(({ zone, p }) => {
            const status = statuses[zone.id] ?? 'offline';
            const s = snapshot.zones[zone.id];
            const blinking = status === 'critical' && unacknowledged.has(zone.id);
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
                {exploded ? (
                  <ZoneInterior
                    idPrefix={idPrefix}
                    zone={zone}
                    state={s}
                    fill={zoneFill(viewMode, zone, s, ctx)}
                    highlight={highlightOf(zone, status)}
                    selected={selectedId === zone.id}
                    offline={status === 'offline'}
                    z0={z0}
                    dy={dy}
                    iso={iso}
                    animate={animate}
                    palette={palette}
                    label={zoneLabel(viewMode, zone, s)}
                    manual={manual.has(zone.id)}
                    statusColor={statusColors[status]}
                  />
                ) : (
                  exteriorZone(zone, p)
                )}
              </g>
            );
          })}
          <text
            x={slab.sides[0].points[0].x - iso.scale * 1.2}
            y={slab.sides[0].points[0].y}
            textAnchor="end"
            className={styles.floorLabel}
            fill={ink2}
            style={{ fontSize: 12 * fs }}
          >
            {floor.short} · {floor.name}
          </text>
        </g>
      ))}

      {riser && (
        <g pointerEvents="none">
          <g transform={`translate(${(riser.base.x + 8).toFixed(1)},${(riser.base.y - 34).toFixed(1)})`}>
            <rect x={6} y={-10} width={70} height={18} rx={4} fill={theme.colors.background.primary} stroke="#eda100" />
            <Glyph name="bolt" x={10} y={-8} size={14} color="#eda100" />
            <text x={41} y={3} textAnchor="middle" fontSize={10} fill={ink}>
              {riser.kw.toFixed(0)} kW
            </text>
          </g>
        </g>
      )}

      {roof && (
        <g data-testid="ems-roof" transform={roof.transform}>
          {exploded && (
            <>
              <path
                d={path(
                  prism({ x: -0.6, y: -0.6, w: BUILDING.width + 1.2, d: BUILDING.depth + 1.2 }, -0.4, 0.05, iso).top
                )}
                fill="#000"
                opacity={dark ? 0.35 : 0.12}
                filter={`url(#${idPrefix}-soft)`}
                transform={`translate(${iso.scale * 0.8},${iso.scale * 1.2})`}
              />
              {roof.slab.sides.map((sd, i) => (
                <path key={i} d={path(sd.points)} fill={shade(slabColor, i ? 0.25 : 0.12)} />
              ))}
              <path d={path(roof.slab.top)} fill={slabColor} stroke={shade(slabColor, 0.2)} strokeWidth={0.6} />
              <text
                x={Math.min(...roof.slab.top.map((q) => q.x))}
                y={Math.max(...roof.slab.sides.flatMap((sd) => sd.points).map((q) => q.y)) + 16 / roof.k}
                textAnchor="start"
                className={styles.insetLabel}
                fill={ink2}
                style={{ fontSize: 11 / roof.k }}
              >
                AZOTEA · UNIDADES VRF
              </text>
            </>
          )}
          <Rooftop
            units={exploded ? VRF_UNITS : VRF_UNITS_STACKED}
            z={roof.z + (exploded ? ROOF_DECK : 0)}
            dy={roof.dy}
            height={exploded ? 1.3 : 1}
            iso={iso}
            snapshot={snapshot}
            animate={animate}
            dark={dark}
            labelColor={ink}
            surface={theme.colors.background.primary}
            compact={!exploded}
            hoveredUnit={hoveredUnit}
            onHoverUnit={onHoverUnit}
            onLeaveUnit={onLeaveUnit}
          />
        </g>
      )}
      {treesFront.map(tree)}

      {/* marcadores de eventos simulados sobre las zonas */}
      {levels.flatMap(({ zones }) =>
        zones
          .filter(({ zone }) => snapshot.zones[zone.id]?.events?.length)
          .map(({ zone, p }) => {
            const s = snapshot.zones[zone.id];
            const kinds = (s.events ?? []).filter((k) => k !== 'ola_calor' && k !== 'corte_energia') as EventKind[];
            if (!kinds.length && !s.fire) {
              return null;
            }
            const c = p.center;
            return (
              <g key={`ev-${zone.id}`} pointerEvents="none" data-testid={`ems-event-marker-${zone.id}`}>
                {s.fire && (
                  <>
                    <ellipse
                      cx={c.x}
                      cy={c.y}
                      rx={iso.scale * 3.2}
                      ry={iso.scale * 1.8}
                      fill={`url(#${idPrefix}-fire)`}
                    >
                      {animate && (
                        <animate
                          attributeName="opacity"
                          values="0.75;1;0.6;0.9;0.75"
                          dur="0.8s"
                          repeatCount="indefinite"
                        />
                      )}
                    </ellipse>
                    {[0, 1, 2].map((i) => (
                      <circle
                        key={i}
                        cx={c.x + (i - 1) * 8}
                        cy={c.y - 10}
                        r={6}
                        fill={dark ? '#777' : '#555'}
                        opacity={0}
                      >
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
                <g transform={`translate(${c.x.toFixed(1)},${(c.y - 34).toFixed(1)})`}>
                  <line
                    x1={0}
                    y1={10}
                    x2={0}
                    y2={22}
                    stroke={EVENTS[kinds[0] ?? 'incendio'].level === 'crit' ? '#f2495c' : '#ff9830'}
                    strokeWidth={1.5}
                  />
                  <circle
                    r={11}
                    fill={theme.colors.background.primary}
                    stroke={EVENTS[kinds[0] ?? 'incendio'].level === 'crit' ? '#f2495c' : '#ff9830'}
                    strokeWidth={2}
                  >
                    {animate && <animate attributeName="r" values="11;12.5;11" dur="1.2s" repeatCount="indefinite" />}
                  </circle>
                  <Glyph
                    name={EVENTS[kinds[0] ?? 'incendio'].glyph}
                    x={-7}
                    y={-7}
                    size={14}
                    color={EVENTS[kinds[0] ?? 'incendio'].level === 'crit' ? '#f2495c' : '#ff9830'}
                  />
                </g>
              </g>
            );
          })
      )}

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
    filter: brightness(1.08);
  `,
  blink: css`
    animation: ${pulse} 1.2s ease-in-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  zoneId: css`
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightBold};
    paint-order: stroke;
    stroke: ${colorManipulator.alpha(theme.colors.background.primary, 0.7)};
    stroke-width: 3px;
  `,
  zoneValue: css`
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    paint-order: stroke;
    stroke: ${colorManipulator.alpha(theme.colors.background.primary, 0.7)};
    stroke-width: 3px;
  `,
  insetLabel: css`
    font-weight: ${theme.typography.fontWeightMedium};
    letter-spacing: 0.08em;
  `,
  floorLabel: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
