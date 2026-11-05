import React, { useEffect, useMemo, useState } from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, ROOF_UNITS, ROOF_UNITS_STACKED, ZONES, Zone } from 'building/model';
import { IsoConfig, Prism, Pt, bounds, path, placement, prism, rotate, toScreen } from 'building/iso';
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
}

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
  const roofSlot = exploded ? visible.length : undefined;
  const slots = exploded ? visible.length + (showAllFloors ? 1 : 0) : showAllFloors ? FLOORS.length : 1;
  const box = useMemo(() => bounds(iso, slots, exploded ? 2.5 : 3.5), [iso, slots, exploded]);
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
    const base = roofSlot !== undefined ? placement(roofSlot, iso) : placement(FLOORS.length - 1, iso);
    const z = roofSlot !== undefined ? base.z : base.z + SLAB + WALL;
    return { z, dy: base.dy, slab: prism(FULL, z, ROOF_DECK, iso, 0, base.dy) };
  })();

  // líneas de proyección entre niveles (vista explotada)
  const connectors: Pt[][] = (() => {
    if (!exploded) {
      return [];
    }
    const slabs = [...levels.map((l) => l.slab), ...(roof ? [roof.slab] : [])];
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
    if (roof) {
      pts.push(toScreen(near.x, near.y, roof.z + ROOF_DECK, iso, roof.dy));
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
          <text x={p.center.x} y={p.center.y - 1} textAnchor="middle" className={styles.zoneId} fill={ink}>
            {zone.id}
            {manual.has(zone.id) ? ' · M' : ''}
          </text>
          <text x={p.center.x} y={p.center.y + 12} textAnchor="middle" className={styles.zoneValue} fill={ink}>
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
        <radialGradient id={`${idPrefix}-glow`}>
          <stop offset="0%" stopColor="#ffe9a8" stopOpacity={0.95} />
          <stop offset="100%" stopColor="#ffe9a8" stopOpacity={0} />
        </radialGradient>
      </defs>

      <path
        d={path(prism({ x: -1.5, y: -1.5, w: BUILDING.width + 3, d: BUILDING.depth + 3 }, -0.05, 0.05, iso).top)}
        fill={dark ? '#1f1f1d' : '#efeee9'}
        stroke={theme.colors.border.weak}
        opacity={exploded ? 0.6 : 1}
      />

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
          >
            {floor.short} · {floor.name}
          </text>
        </g>
      ))}

      {riser && (
        <g pointerEvents="none">
          <g transform={`translate(${(riser.base.x + 8).toFixed(1)},${(riser.base.y - 34).toFixed(1)})`}>
            <rect x={6} y={-10} width={70} height={18} rx={4} fill={theme.colors.background.primary} stroke="#eda100" />
            <text x={41} y={3} textAnchor="middle" fontSize={10} fill={ink}>
              ⚡ {riser.kw.toFixed(0)} kW
            </text>
          </g>
        </g>
      )}

      {roof && (
        <g data-testid="ems-roof" pointerEvents="none">
          {exploded && (
            <>
              {roof.slab.sides.map((sd, i) => (
                <path key={i} d={path(sd.points)} fill={shade(slabColor, i ? 0.25 : 0.12)} />
              ))}
              <path d={path(roof.slab.top)} fill={slabColor} stroke={shade(slabColor, 0.2)} strokeWidth={0.6} />
              <text
                x={roof.slab.sides[0].points[0].x - iso.scale * 1.2}
                y={roof.slab.sides[0].points[0].y}
                textAnchor="end"
                className={styles.floorLabel}
                fill={ink2}
              >
                Azotea · condensadoras
              </text>
            </>
          )}
          <Rooftop
            units={exploded ? ROOF_UNITS : ROOF_UNITS_STACKED}
            z={roof.z + (exploded ? ROOF_DECK : 0)}
            dy={roof.dy}
            height={exploded ? 1.3 : 1}
            iso={iso}
            snapshot={snapshot}
            animate={animate}
            dark={dark}
            labelColor={ink2}
          />
        </g>
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
  floorLabel: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
