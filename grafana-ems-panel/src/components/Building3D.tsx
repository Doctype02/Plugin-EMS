import React, { useMemo } from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { BUILDING, FLOORS, ROOF_UNITS, ROOF_UNITS_STACKED, ZONES, Zone } from 'building/model';
import { IsoConfig, Prism, Pt, bounds, onTop, path, placement, prism } from 'building/iso';
import { Snapshot, Status } from 'building/telemetry';
import { MAX_POWER_DENSITY, ViewMode, zoneFill, zoneLabel } from 'building/views';

const SLAB = 0.3;

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
  onHover: (zone: Zone, e: React.MouseEvent) => void;
  onLeave: () => void;
  onSelect: (zone: Zone) => void;
}

type Item = { kind: 'zone'; zone: Zone; p: Prism } | { kind: 'extra'; label?: string; p: Prism };

const shade = (color: string, amount: number) => colorManipulator.darken(color, amount);

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
  onHover,
  onLeave,
  onSelect,
}) => {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const dark = theme.isDark;
  const showAllFloors = floors.length === FLOORS.length;
  const exploded = iso.layout === 'exploded';
  // apilado, los muros llenan el piso (sin franja vacía); explotado, se recortan para ver el interior
  const WALL = exploded ? BUILDING.floorHeight * 0.78 : BUILDING.floorHeight - SLAB;
  const visible = FLOORS.filter((f) => floors.includes(f.level));
  // "ranura" de cada nivel: en la vista explotada los niveles visibles se escalonan uno tras otro;
  // apilado, cada piso va a su altura real (o en el suelo si se muestra uno solo).
  const slotOf = (level: number) =>
    exploded ? visible.findIndex((f) => f.level === level) : showAllFloors ? level : 0;
  const roofSlot = exploded ? visible.length : undefined;
  const slots = exploded ? visible.length + (showAllFloors ? 1 : 0) : showAllFloors ? FLOORS.length : 1;
  const box = useMemo(() => bounds(iso, slots, exploded ? 2 : 3.5), [iso, slots, exploded]);
  const ctx = { dark, statusColors, status: statuses, maxPowerDensity: MAX_POWER_DENSITY };
  const ink = theme.colors.text.primary;
  const ink2 = theme.colors.text.secondary;
  const slabColor = dark ? '#3a3a37' : '#cfcdc6';
  const wallBase = dark ? '#2c2c2a' : '#e9e7e1';
  const glass = dark ? '#5d7fa6' : '#9fc1e6';
  const FULL = { x: 0, y: 0, w: BUILDING.width, d: BUILDING.depth };

  const levels = visible.map((floor) => {
    const { z: z0, dy } = placement(slotOf(floor.level), iso);
    const slab = prism(FULL, z0, SLAB, iso, 0, dy);
    const items: Item[] = [
      ...ZONES.filter((z) => z.floor === floor.level).map((zone) => ({
        kind: 'zone' as const,
        zone,
        p: prism(zone.rect, z0 + SLAB, WALL, iso, 0.12, dy),
      })),
      ...floor.extras.map((e) => ({
        kind: 'extra' as const,
        label: e.label,
        p: prism(e.rect, z0 + SLAB, WALL * 0.35, iso, 0.12, dy),
      })),
    ].sort((a, b) => b.p.depth - a.p.depth);
    return { floor, slab, items, z0, dy };
  });

  // azotea: nivel propio en la vista explotada, encima del piso 2 en la vista apilada
  const roof = (() => {
    if (!showAllFloors) {
      return undefined;
    }
    const base = roofSlot !== undefined ? placement(roofSlot, iso) : placement(FLOORS.length - 1, iso);
    const z = roofSlot !== undefined ? base.z : base.z + SLAB + WALL;
    return { z, dy: base.dy, slab: prism(FULL, z, SLAB, iso, 0, base.dy) };
  })();

  // líneas de proyección entre niveles consecutivos (vista explotada)
  const connectors: Pt[][] = (() => {
    if (!exploded) {
      return [];
    }
    const slabs = [...levels.map((l) => l.slab), ...(roof ? [roof.slab] : [])];
    const out: Pt[][] = [];
    for (let i = 0; i + 1 < slabs.length; i++) {
      const a = slabs[i].top;
      const b = slabs[i + 1].sides[0].points;
      out.push([a[3], b[0]], [a[2], b[1]]);
    }
    return out;
  })();

  const windowsOn = (face: Prism['sides'][number]) => {
    const [b0, b1, t1, t0] = face.points;
    const n = Math.max(2, Math.round(Math.hypot(b1.x - b0.x, b1.y - b0.y) / (iso.scale * 2.4)));
    const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const out: Pt[][] = [];
    for (let i = 0; i < n; i++) {
      const u0 = (i + 0.18) / n;
      const u1 = (i + 0.82) / n;
      const lo0 = lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.3);
      const lo1 = lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.3);
      const hi1 = lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), 0.85);
      const hi0 = lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), 0.85);
      out.push([lo0, lo1, hi1, hi0]);
    }
    return out;
  };

  const renderZone = (zone: Zone, p: Prism) => {
    const s = snapshot.zones[zone.id];
    const status = statuses[zone.id] ?? 'offline';
    const fill = zoneFill(viewMode, zone, s, ctx);
    const selected = selectedId === zone.id;
    const hovered = hoveredId === zone.id;
    const blinking = status === 'critical' && unacknowledged.has(zone.id);
    const highlight = selected
      ? theme.colors.primary.main
      : status === 'critical' || status === 'warning'
        ? statusColors[status]
        : undefined;
    const label = zoneLabel(viewMode, zone, s);
    const occ = s?.occupants ?? 0;
    // personas sobre la planta (máx. 24 puntos, distribuidos de forma estable)
    const dots = viewMode === 'occupancy' || viewMode === 'status' ? Math.min(occ, 24) : 0;
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
        {p.sides.map((side, i) => {
          const wall = side.facing === 'front' ? shade(wallBase, 0.12) : shade(wallBase, 0.24);
          const hasWindows = zone.windows?.includes(side.edge);
          const lit = (s?.lights ?? 0) > 0.05;
          return (
            <g key={i}>
              <path d={path(side.points)} fill={wall} stroke={shade(wall, 0.25)} strokeWidth={0.6} />
              {hasWindows &&
                windowsOn(side).map((w, j) => (
                  <path
                    key={j}
                    d={path(w)}
                    fill={
                      lit
                        ? colorManipulator.alpha('#ffd95a', side.facing === 'front' ? 0.85 : 0.7)
                        : shade(glass, side.facing === 'front' ? 0 : 0.15)
                    }
                    stroke="none"
                  />
                ))}
            </g>
          );
        })}
        <path
          d={path(p.top)}
          fill={fill}
          stroke={highlight ?? shade(fill, 0.35)}
          strokeWidth={highlight ? (selected ? 3 : 2) : 0.8}
          className={hovered ? styles.hoverTop : undefined}
        />
        {status === 'offline' && <path d={path(p.top)} fill={`url(#${idPrefix}-hatch)`} pointerEvents="none" />}
        {Array.from({ length: dots }, (_, i) => {
          const u = 0.12 + 0.76 * ((i * 0.618 + 0.13) % 1);
          const v = 0.15 + 0.7 * ((i * 0.377 + 0.31) % 1);
          const pt = onTop(p, u, v);
          return <circle key={i} cx={pt.x} cy={pt.y - 2} r={2.2} fill={ink} opacity={0.7} pointerEvents="none" />;
        })}
        {viewMode === 'hvac' && s?.hvacOn && (
          <text x={p.center.x} y={p.center.y - 14} textAnchor="middle" className={styles.glyph} fill={ink}>
            ❄
          </text>
        )}
        <g pointerEvents="none">
          <text x={p.center.x} y={p.center.y - 1} textAnchor="middle" className={styles.zoneId} fill={ink}>
            {zone.id}
          </text>
          <text x={p.center.x} y={p.center.y + 12} textAnchor="middle" className={styles.zoneValue} fill={ink}>
            {label}
          </text>
        </g>
      </g>
    );
  };

  return (
    <svg
      className={styles.svg}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMid meet"
      data-testid="ems-building"
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
      </defs>

      {/* sombra en el terreno */}
      <path
        d={path(prism({ x: -1.5, y: -1.5, w: BUILDING.width + 3, d: BUILDING.depth + 3 }, -0.05, 0.05, iso).top)}
        opacity={exploded ? 0.6 : 1}
        fill={dark ? '#1f1f1d' : '#efeee9'}
        stroke={theme.colors.border.weak}
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
          opacity={0.6}
        />
      ))}

      {levels.map(({ floor, slab, items }) => (
        <g key={floor.level} data-testid={`ems-floor-${floor.short}`}>
          {slab.sides.map((sd, i) => (
            <path key={i} d={path(sd.points)} fill={shade(slabColor, i ? 0.25 : 0.12)} />
          ))}
          <path d={path(slab.top)} fill={slabColor} stroke={shade(slabColor, 0.2)} strokeWidth={0.6} />
          {items.map((it, i) =>
            it.kind === 'zone' ? (
              renderZone(it.zone, it.p)
            ) : (
              <g key={`x${i}`} pointerEvents="none">
                {it.p.sides.map((sd, j) => (
                  <path key={j} d={path(sd.points)} fill={shade(slabColor, 0.15 + j * 0.1)} />
                ))}
                <path d={path(it.p.top)} fill={shade(slabColor, 0.05)} />
              </g>
            )
          )}
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
          {(exploded ? ROOF_UNITS : ROOF_UNITS_STACKED)
            .map((u) => ({ u, p: prism(u.rect, roof.z + (exploded ? SLAB : 0), exploded ? 1.3 : 1, iso, 0, roof.dy) }))
            .sort((a, b) => b.p.depth - a.p.depth)
            .map(({ u, p }) => {
              const s = snapshot.zones[u.zoneId];
              const c = s?.drForced ? '#eb6834' : s?.hvacOn ? '#2a78d6' : dark ? '#55554f' : '#b9b7af';
              return (
                <g key={u.zoneId} data-testid={`ems-roof-${u.zoneId}`} data-on={s?.hvacOn ? 'si' : 'no'}>
                  {p.sides.map((sd, i) => (
                    <path key={i} d={path(sd.points)} fill={shade(c, 0.15 + i * 0.12)} />
                  ))}
                  <path d={path(p.top)} fill={c} stroke={shade(c, 0.3)} strokeWidth={0.5} />
                  <circle
                    cx={p.center.x}
                    cy={p.center.y}
                    r={iso.scale * 0.55}
                    fill="none"
                    stroke={shade(c, 0.45)}
                    strokeWidth={1}
                  />
                  <text
                    x={p.center.x}
                    y={p.center.y - iso.scale * 1.1}
                    textAnchor="middle"
                    className={styles.roofLabel}
                    fill={ink2}
                  >
                    {u.zoneId}
                  </text>
                </g>
              );
            })}
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
  glyph: css`
    font-size: 14px;
  `,
  floorLabel: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  roofLabel: css`
    font-size: 8px;
  `,
});
