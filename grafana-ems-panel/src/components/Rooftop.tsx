import React from 'react';
import { BUILDING, HvacSystem, PV, Rect, VrfUnit, ZONE_BY_ID } from 'building/model';
import { IsoConfig, Pt, path, planeMatrix, prism, toScreen } from 'building/iso';
import { Snapshot } from 'building/telemetry';
import { placeLabels } from 'building/layout';
import { Materials, blend, faceColor, lit } from 'building/materials';
import { boxPaths, faceQuad, lerp, onFace, segments } from './IsoPrimitives';

interface Props {
  idPrefix: string;
  units: VrfUnit[];
  z: number;
  dy: number;
  height: number;
  iso: IsoConfig;
  snapshot: Snapshot;
  animate: boolean;
  M: Materials;
  labelColor: string;
  labelColor2: string;
  surface: string;
  border: string;
  accent: string;
  /** Vista exterior: rótulo corto para no encimar etiquetas. */
  compact?: boolean;
  hoveredUnit?: string;
  onHoverUnit?: (unit: VrfUnit, e: React.MouseEvent) => void;
  onLeaveUnit?: () => void;
  /** Dibuja los campos fotovoltaicos (variante con FV). */
  pv?: boolean;
  /** Rótulos de unidades y campos FV (por defecto, salvo en la vista compacta). */
  showLabels?: boolean;
  /** Unidades del SVG por px de pantalla: los rótulos se dibujan en px. */
  labelScale?: number;
}

export type UnitMode = 'enfriando' | 'dr' | 'espera' | 'falla' | 'sin_energia' | 'apagada';

export interface UnitState {
  mode: UnitMode;
  kw: number;
  /** Carga térmica respecto a la capacidad nominal (0–1). */
  load: number;
  on: number;
}

/** Estado agregado de una unidad exterior (VRF o PTAC) a partir de las zonas que atiende. */
export function unitState(u: HvacSystem, snapshot: Snapshot): UnitState {
  const served = u.zones.map((id) => snapshot.zones[id]).filter(Boolean);
  const kw = served.reduce((a, s) => a + (s.hvacOn ? s.pHvac : 0), 0);
  // calor retirado ≈ potencia del compresor × COP del sistema
  const thermal = u.zones.reduce((a, id) => {
    const s = snapshot.zones[id];
    return a + (s?.hvacOn ? Math.max(0, s.pHvac - (ZONE_BY_ID[id]?.fanKw ?? 0)) * (ZONE_BY_ID[id]?.cop ?? 2) : 0);
  }, 0);
  const on = served.filter((s) => s.hvacOn).length;
  const failed = served.length > 0 && served.every((s) => s.events?.includes('falla_vrf'));
  const mode: UnitMode =
    snapshot.meter?.gridOk === false
      ? 'sin_energia'
      : failed || snapshot.units?.[u.id]?.fault
        ? 'falla'
        : snapshot.units?.[u.id]?.on === false
          ? 'apagada'
          : served.some((s) => s.drForced)
            ? 'dr'
            : on
              ? 'enfriando'
              : 'espera';
  return { mode, kw, load: Math.min(1, thermal / u.capacityKw), on };
}

export const UNIT_MODE_LABEL: Record<UnitMode, string> = {
  enfriando: 'Enfriando',
  dr: 'Compresor limitado (DR)',
  espera: 'En espera',
  falla: 'FALLA',
  sin_energia: 'Sin energía',
  apagada: 'Apagada (manual)',
};

const LED: Record<UnitMode, string> = {
  enfriando: '#3d9df3',
  dr: '#ff9830',
  espera: '#8e8e8e',
  falla: '#f2495c',
  sin_energia: '#3a3a3a',
  apagada: '#5c5c66',
};

const HATCH: Rect = { x: 16.5, y: 15.5, w: 1.6, d: 1.6 };
const PV_ROW = 1.0; // profundidad de una fila de módulos (m)

/** Tramos [x0, x1] de la fila que no chocan con los obstáculos (unidades, escotilla). */
function freeSpans(row: Rect, obstacles: Rect[]): Array<[number, number]> {
  let spans: Array<[number, number]> = [[row.x, row.x + row.w]];
  for (const o of obstacles) {
    if (o.y >= row.y + row.d || o.y + o.d <= row.y) {
      continue;
    }
    spans = spans.flatMap(([a, b]) => {
      if (o.x >= b || o.x + o.w <= a) {
        return [[a, b] as [number, number]];
      }
      const keep: Array<[number, number]> = [];
      if (o.x > a) {
        keep.push([a, o.x]);
      }
      if (o.x + o.w < b) {
        keep.push([o.x + o.w, b]);
      }
      return keep;
    });
  }
  return spans.filter(([a, b]) => b - a >= 0.9);
}

/**
 * Filas de módulos de un campo FV: filas a lo largo de x con paso PV_ROW / fracción activa, de modo que
 * la superficie cubierta es la fracción activa del campo (el resto son pasillos de mantenimiento).
 */
export function pvRows(field: Rect, obstacles: Rect[]): Rect[] {
  const W = BUILDING.width;
  const D = BUILDING.depth;
  const inset = 0.3;
  const x0 = Math.max(field.x + inset, 0.45);
  const x1 = Math.min(field.x + field.w - inset, W - 0.45);
  const y0 = Math.max(field.y + inset, 0.45);
  const y1 = Math.min(field.y + field.d - inset, D - 0.45);
  const pitch = PV_ROW / PV.fractionActive;
  const n = Math.max(1, Math.floor((y1 - y0 + (pitch - PV_ROW)) / pitch));
  const used = n * pitch - (pitch - PV_ROW);
  const start = y0 + Math.max(0, (y1 - y0 - used) / 2);
  const out: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = { x: x0, y: start + i * pitch, w: x1 - x0, d: Math.min(PV_ROW, y1 - y0) };
    for (const [a, b] of freeSpans(row, obstacles)) {
      out.push({ x: a, y: row.y, w: b - a, d: row.d });
    }
  }
  return out;
}

/** Azotea: parapeto con remate, membrana con juntas, campos FV con celdas y condensadoras VRF. */
export const Rooftop: React.FC<Props> = ({
  idPrefix,
  units,
  z,
  dy,
  height,
  iso,
  snapshot,
  animate,
  M,
  labelColor,
  labelColor2,
  surface,
  border,
  accent,
  compact,
  hoveredUnit,
  onHoverUnit,
  onLeaveUnit,
  pv = false,
  showLabels,
  labelScale = 1,
}) => {
  const labels = showLabels ?? !compact;
  const ls = labelScale;
  const W = BUILDING.width;
  const D = BUILDING.depth;
  const t = 0.25;
  const parapetH = 0.55;
  const segments4 = [
    { x: 0, y: 0, w: W, d: t },
    { x: 0, y: D - t, w: W, d: t },
    { x: 0, y: t, w: t, d: D - 2 * t },
    { x: W - t, y: t, w: t, d: D - 2 * t },
  ].map((r) => ({ kind: 'parapet' as const, p: prism(r, z, parapetH, iso, 0, dy) }));
  // escotilla de acceso
  const hatch = { kind: 'hatch' as const, p: prism(HATCH, z, 0.5, iso, 0, dy) };
  // --- fotovoltaica: color y brillo según la generación
  const pPv = snapshot.meter?.pPv ?? 0;
  const gen = Math.min(1, Math.max(0, pPv / Math.max(PV.peakKw, 1)));
  const obstacles: Rect[] = [
    ...units.map((u) => ({ x: u.rect.x - 0.5, y: u.rect.y - 1.2, w: u.rect.w + 1.0, d: u.rect.d + 1.6 })),
    { x: HATCH.x - 0.4, y: HATCH.y - 0.4, w: HATCH.w + 0.8, d: HATCH.d + 0.8 },
  ];
  const pvRects = pv ? PV.fields.map((f) => ({ f, rows: pvRows(f.rect, obstacles) })) : [];
  const cellBase = blend(M.dark ? '#1d2b45' : '#243a63', '#2f6fd0', 1 - gen * 0.45);
  const frame = M.dark ? '#8b9099' : '#b9bec5';
  const PV_Z = z + 0.22;
  const PV_H = 0.08;
  const items = [
    ...segments4,
    hatch,
    ...units.map((u) => ({ kind: 'unit' as const, u, p: prism(u.rect, z + 0.18, height, iso, 0, dy) })),
  ].sort((a, b) => b.p.depth - a.p.depth);

  // --- rótulos (px): kW de cada VRF y generación de cada campo FV, sin encimarse
  type RoofLabel = {
    id: string;
    x: number;
    y: number;
    wPx: number;
    name: string;
    value: string;
    dot: string;
    pvField?: string;
  };
  const placed: RoofLabel[] = [];
  if (labels) {
    for (const u of units) {
      const st = unitState(u, snapshot);
      const pt = toScreen(u.rect.x + u.rect.w / 2, u.rect.y + u.rect.d / 2, z + 0.18 + height + 0.9, iso, dy);
      const value =
        st.mode === 'falla'
          ? 'FALLA'
          : st.mode === 'sin_energia'
            ? 'sin energía'
            : st.mode === 'apagada'
              ? 'apagada'
              : `${st.kw.toFixed(1)} kW`;
      placed.push({
        id: u.id,
        x: pt.x,
        y: pt.y,
        wPx: u.id.length * 6.9 + value.length * 7.1 + 34,
        name: u.id,
        value,
        dot: LED[st.mode],
      });
    }
    if (pv) {
      const totalArea = PV.fields.reduce((a, f) => a + f.areaM2, 0) || 1;
      for (const f of PV.fields) {
        const kw = (pPv * f.areaM2) / totalArea;
        const pt = toScreen(f.rect.x + f.rect.w / 2, f.rect.y + f.rect.d / 2, z + 0.5, iso, dy);
        const value = `${kw.toFixed(1)} kW`;
        placed.push({
          id: f.id,
          x: pt.x,
          y: pt.y,
          wPx: f.id.length * 6.9 + value.length * 7.1 + 34,
          name: f.id,
          value,
          dot: gen > 0.02 ? '#f2cc0c' : '#8e8e8e',
          pvField: f.id,
        });
      }
    }
  }
  const offsets = placeLabels(
    placed.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.wPx * ls, h: 22 * ls })),
    { gap: 4 * ls }
  );

  return (
    <>
      <defs>
        {/* módulo FV: celdas de 0.5 × 0.5 m con bus bars, en metros del plano */}
        <pattern id={`${idPrefix}-pvcell`} width={0.5} height={0.5} patternUnits="userSpaceOnUse">
          <rect width={0.5} height={0.5} fill={cellBase} />
          <path d="M0,0H0.5M0,0V0.5" stroke={M.dark ? '#7f93b3' : '#a8bad6'} strokeWidth={0.02} opacity={0.55} />
          <path
            d="M0.166,0V0.5M0.333,0V0.5"
            stroke={M.dark ? '#7f93b3' : '#a8bad6'}
            strokeWidth={0.006}
            opacity={0.4}
          />
        </pattern>
        <linearGradient id={`${idPrefix}-pvsheen`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0} />
          <stop offset="48%" stopColor="#ffffff" stopOpacity={0.05 + 0.18 * gen} />
          <stop offset="60%" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
        <linearGradient id={`${idPrefix}-membrane`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={lit(M.membrane, 1.04)} />
          <stop offset="100%" stopColor={lit(M.membrane, 0.94)} />
        </linearGradient>
      </defs>
      {/* membrana de la azotea con juntas */}
      <g transform={planeMatrix(z + 0.004, iso, dy)} pointerEvents="none">
        <rect x={t} y={t} width={W - 2 * t} height={D - 2 * t} fill={`url(#${idPrefix}-membrane)`} />
        <path
          d={Array.from({ length: 9 }, (_, i) => `M${(i + 1) * 2},${t}V${D - t}`).join('')}
          stroke={lit(M.membrane, 0.82)}
          strokeWidth={0.04}
        />
        {/* sombra ambiental al pie del parapeto */}
        <rect x={t} y={t} width={W - 2 * t} height={0.6} fill={`url(#${idPrefix}-ao-s)`} />
        <rect x={t} y={D - t - 0.6} width={W - 2 * t} height={0.6} fill={`url(#${idPrefix}-ao-n)`} />
        <rect x={t} y={t} width={0.6} height={D - 2 * t} fill={`url(#${idPrefix}-ao-w)`} />
        <rect x={W - t - 0.6} y={t} width={0.6} height={D - 2 * t} fill={`url(#${idPrefix}-ao-e)`} />
      </g>
      {pvRects.map(({ f, rows }) => (
        <g
          key={f.id}
          pointerEvents="none"
          data-testid={`ems-pv-${f.id}`}
          data-gen={gen.toFixed(2)}
          opacity={compact ? 0.75 : 1}
        >
          {rows.map((r, i) => {
            const p = prism(r, PV_Z, PV_H, iso, 0, dy);
            return (
              <g key={i}>
                {p.sides.map((sd, j) => (
                  <path key={j} d={path(sd.points)} fill={faceColor(frame, sd.facing)} />
                ))}
              </g>
            );
          })}
          <g transform={planeMatrix(PV_Z + PV_H, iso, dy)}>
            {rows.map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.d}
                fill={`url(#${idPrefix}-pvcell)`}
                stroke={frame}
                strokeWidth={0.04}
              />
            ))}
            {gen > 0.02 &&
              rows.map((r, i) => (
                <rect key={`s${i}`} x={r.x} y={r.y} width={r.w} height={r.d} fill={`url(#${idPrefix}-pvsheen)`}>
                  {animate && (
                    <animate
                      attributeName="opacity"
                      values="0.6;1;0.6"
                      dur="4s"
                      begin={`${((i * 0.37) % 4).toFixed(2)}s`}
                      repeatCount="indefinite"
                    />
                  )}
                </rect>
              ))}
          </g>
        </g>
      ))}
      {items.map((it, k) => {
        if (it.kind === 'parapet' || it.kind === 'hatch') {
          const c = it.kind === 'hatch' ? blend(M.metal, M.parapet, 0.5) : M.parapet;
          return (
            <g key={`p${k}`} pointerEvents="none">
              {boxPaths(it.p, c, 'pp', { top: lit(c, 1.08) })}
            </g>
          );
        }
        const { u, p } = it;
        const st = unitState(u, snapshot);
        const led = LED[st.mode];
        const spinning = animate && (st.mode === 'enfriando' || st.mode === 'dr');
        const nFans = u.capacityKw > 10 ? 2 : 1;
        const long = u.rect.w >= u.rect.d;
        const rad = Math.min(long ? u.rect.w / (2 * nFans) : u.rect.w, long ? u.rect.d : u.rect.d / (2 * nFans)) * 0.42;
        const fans = Array.from({ length: nFans }, (_, i) => {
          const f = (i + 0.5) / nFans;
          return long
            ? { cx: u.rect.x + u.rect.w * f, cy: u.rect.y + u.rect.d / 2 }
            : { cx: u.rect.x + u.rect.w / 2, cy: u.rect.y + u.rect.d * f };
        });
        const speed = Math.max(0.3, 1.2 - st.load);
        const hovered = hoveredUnit === u.id;
        // bancada de perfiles metálicos bajo la unidad
        const rails = [0.15, 0.85].map((f) =>
          prism(
            long
              ? { x: u.rect.x - 0.1, y: u.rect.y + u.rect.d * f - 0.06, w: u.rect.w + 0.2, d: 0.12 }
              : { x: u.rect.x + u.rect.w * f - 0.06, y: u.rect.y - 0.1, w: 0.12, d: u.rect.d + 0.2 },
            z,
            0.18,
            iso,
            0,
            dy
          )
        );
        // tuberías de refrigerante hacia el ducto vertical (esquina suroeste de la unidad)
        const pipeA = toScreen(u.rect.x + 0.3, u.rect.y - 0.05, z + 0.45, iso, dy);
        const pipeB = toScreen(u.rect.x + 0.3, u.rect.y - 1.0, z + 0.45, iso, dy);
        const pipeC = toScreen(u.rect.x + 0.3, u.rect.y - 1.0, z, iso, dy);
        const pipeD = (o: number) =>
          `M${pipeA.x + o},${pipeA.y + o * 0.5}L${pipeB.x + o},${pipeB.y + o * 0.5}L${pipeC.x + o},${pipeC.y + o * 0.5}`;
        return (
          <g
            key={u.id}
            data-testid={`ems-roof-${u.id}`}
            data-on={st.on ? 'si' : 'no'}
            data-mode={st.mode}
            style={{ cursor: 'help' }}
            pointerEvents="all"
            onMouseMove={(e) => onHoverUnit?.(u, e)}
            onMouseLeave={onLeaveUnit}
          >
            <g transform={planeMatrix(z + 0.003, iso, dy)}>
              <rect
                x={u.rect.x - 0.35}
                y={u.rect.y - 0.35}
                width={u.rect.w + 0.7}
                height={u.rect.d + 0.7}
                fill={`url(#${idPrefix}-contact)`}
              />
            </g>
            <path
              d={pipeD(2.2)}
              fill="none"
              stroke={M.dark ? '#2a2d33' : '#5a5f66'}
              strokeWidth={2.4}
              strokeLinejoin="round"
            />
            <path d={pipeD(0)} fill="none" stroke="#b87333" strokeWidth={2} strokeLinejoin="round" />
            {rails.map((r, i) => (
              <g key={`r${i}`}>{boxPaths(r, M.metal, `r${i}`, { edge: false })}</g>
            ))}
            {p.sides.map((sd, i) => {
              const q = sd.points;
              const n = Math.max(4, Math.round(height * 7));
              const louvers: Array<[Pt, Pt]> = [];
              for (let j = 0; j < n; j++) {
                const v = 0.12 + (0.7 * j) / (n - 1);
                louvers.push([onFace(q, 0.06, v), onFace(q, 0.94, v)]);
              }
              return (
                <g key={i}>
                  <path
                    d={path(q)}
                    fill={faceColor(M.casing, sd.facing)}
                    stroke={lit(M.casing, 0.62)}
                    strokeWidth={0.5}
                  />
                  {/* serpentín con rejilla de lamas */}
                  <path d={path(faceQuad(q, 0.05, 0.95, 0.08, 0.86))} fill={faceColor(lit(M.casing, 0.8), sd.facing)} />
                  <path d={segments(louvers)} stroke={lit(faceColor(M.casing, sd.facing), 0.72)} strokeWidth={0.6} />
                  {/* franja LED de estado */}
                  {i === 0 && (
                    <path
                      d={path([
                        lerp(q[0], q[3], 0.9),
                        lerp(q[1], q[2], 0.9),
                        lerp(q[1], q[2], 0.96),
                        lerp(q[0], q[3], 0.96),
                      ])}
                      fill={led}
                      opacity={st.mode === 'sin_energia' ? 0.3 : 0.95}
                    >
                      {animate && st.mode === 'falla' && (
                        <animate attributeName="opacity" values="1;0.2;1" dur="0.9s" repeatCount="indefinite" />
                      )}
                    </path>
                  )}
                </g>
              );
            })}
            <path
              d={path(p.top)}
              fill={lit(M.casing, 1.04)}
              stroke={hovered ? accent : lit(M.casing, 0.62)}
              strokeWidth={hovered ? 2 : 0.6}
            />
            <g transform={planeMatrix(z + 0.18 + height + 0.01, iso, dy)}>
              {fans.map(({ cx, cy }, i) => (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={rad * 1.12} fill={lit(M.casing, 0.55)} />
                  <circle cx={cx} cy={cy} r={rad * 1.02} fill={M.dark ? '#1b1e22' : '#353941'} />
                  <g>
                    {[0, 72, 144, 216, 288].map((a) => (
                      <path
                        key={a}
                        d={`M${cx} ${cy} q ${rad * 0.5} ${-rad * 0.28} ${rad * 0.92} 0 q ${-rad * 0.38} ${rad * 0.3} ${-rad * 0.92} 0Z`}
                        transform={`rotate(${a} ${cx} ${cy})`}
                        fill={M.dark ? '#8d939c' : '#9aa0a8'}
                      />
                    ))}
                    {spinning && (
                      <animateTransform
                        attributeName="transform"
                        type="rotate"
                        from={`0 ${cx} ${cy}`}
                        to={`360 ${cx} ${cy}`}
                        dur={`${speed.toFixed(2)}s`}
                        repeatCount="indefinite"
                      />
                    )}
                  </g>
                  {/* rejilla protectora */}
                  <path
                    d={`M${cx - rad},${cy}H${cx + rad}M${cx},${cy - rad}V${cy + rad}`}
                    stroke={lit(M.casing, 0.85)}
                    strokeWidth={0.04}
                  />
                  <circle cx={cx} cy={cy} r={rad * 0.7} fill="none" stroke={lit(M.casing, 0.85)} strokeWidth={0.04} />
                  <circle cx={cx} cy={cy} r={rad * 0.35} fill="none" stroke={lit(M.casing, 0.85)} strokeWidth={0.04} />
                  <circle cx={cx} cy={cy} r={rad * 0.14} fill={lit(M.casing, 0.7)} />
                  {st.mode === 'falla' && (
                    <path
                      d={`M${cx - rad * 0.6} ${cy - rad * 0.6}L${cx + rad * 0.6} ${cy + rad * 0.6}M${cx + rad * 0.6} ${cy - rad * 0.6}L${cx - rad * 0.6} ${cy + rad * 0.6}`}
                      stroke="#f2495c"
                      strokeWidth={rad * 0.18}
                      strokeLinecap="round"
                    />
                  )}
                </g>
              ))}
            </g>
          </g>
        );
      })}
      {pv &&
        labels &&
        pvRects.map(({ f }) => {
          const r = { x: f.rect.x + 0.15, y: f.rect.y + 0.15, w: f.rect.w - 0.3, d: f.rect.d - 0.3 };
          const pts = [
            toScreen(r.x, r.y, z + 0.4, iso, dy),
            toScreen(r.x + r.w, r.y, z + 0.4, iso, dy),
            toScreen(r.x + r.w, r.y + r.d, z + 0.4, iso, dy),
            toScreen(r.x, r.y + r.d, z + 0.4, iso, dy),
          ];
          return (
            <path
              key={`fo-${f.id}`}
              d={path(pts)}
              fill="none"
              stroke="#e0b400"
              strokeOpacity={0.55}
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          );
        })}
      {labels && (
        <g pointerEvents="none" data-testid="ems-roof-labels">
          {placed.map((l) => {
            const off = offsets[l.id] ?? { dx: 0, dy: 0 };
            const moved = off.dx !== 0 || off.dy !== 0;
            return (
              <g key={l.id} data-testid={l.pvField ? `ems-pv-label-${l.pvField}` : undefined}>
                {moved && (
                  <line
                    x1={l.x}
                    y1={l.y}
                    x2={l.x + off.dx}
                    y2={l.y + off.dy}
                    stroke={labelColor2}
                    strokeWidth={1}
                    opacity={0.6}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <g
                  transform={`translate(${(l.x + off.dx).toFixed(1)},${(l.y + off.dy).toFixed(1)}) scale(${ls.toFixed(4)})`}
                >
                  <rect
                    x={-l.wPx / 2}
                    y={-11}
                    width={l.wPx}
                    height={22}
                    rx={4}
                    fill={surface}
                    fillOpacity={0.96}
                    stroke={border}
                  />
                  <circle cx={-l.wPx / 2 + 11} cy={0} r={4} fill={l.dot} />
                  <text
                    x={-l.wPx / 2 + 20}
                    y={4.2}
                    fontSize={11.5}
                    fill={labelColor}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    <tspan fontWeight={600}>{l.name}</tspan>
                    <tspan dx={6}>{l.value}</tspan>
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      )}
    </>
  );
};
