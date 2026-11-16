import React from 'react';
import { colorManipulator } from '@grafana/data';
import { BUILDING, HvacSystem, PV, Rect, VrfUnit, ZONE_BY_ID } from 'building/model';
import { IsoConfig, Pt, path, planeMatrix, prism, toScreen } from 'building/iso';
import { Snapshot } from 'building/telemetry';
import { declutter } from 'building/layout';

interface Props {
  units: VrfUnit[];
  z: number;
  dy: number;
  height: number;
  iso: IsoConfig;
  snapshot: Snapshot;
  animate: boolean;
  dark: boolean;
  labelColor: string;
  surface: string;
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

const shade = (c: string, a: number) => colorManipulator.darken(c, a);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

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

/** Azotea: parapeto, membrana, campos FV y unidades exteriores VRF con ventiladores, rejillas y tuberías. */
export const Rooftop: React.FC<Props> = ({
  units,
  z,
  dy,
  height,
  iso,
  snapshot,
  animate,
  dark,
  labelColor,
  surface,
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
  const casing = dark ? '#c9ccd1' : '#eef0f2';
  const W = BUILDING.width;
  const D = BUILDING.depth;
  const t = 0.25;
  const parapetH = 0.55;
  const parapetColor = dark ? '#5a5a56' : '#d6d3cb';
  const segments = [
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
  const pvFields = pv
    ? PV.fields.map((f) => ({
        f,
        rows: pvRows(f.rect, obstacles).map((r) => prism(r, z + 0.25, 0.1, iso, 0, dy)),
      }))
    : [];
  const mix = (a: [number, number, number], b: [number, number, number], t: number) =>
    `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  const cell = mix(dark ? [24, 32, 52] : [34, 46, 74], [44, 104, 205], gen);
  const frame = dark ? '#8b9099' : '#c3c7cd';
  const items = [
    ...segments,
    hatch,
    ...units.map((u) => ({ kind: 'unit' as const, u, p: prism(u.rect, z + 0.15, height, iso, 0, dy) })),
  ].sort((a, b) => b.p.depth - a.p.depth);

  // --- rótulos (px): kW de cada VRF y generación de cada campo FV, sin encimarse
  type RoofLabel = {
    id: string;
    x: number;
    y: number;
    wPx: number;
    name: string;
    value: string;
    color: string;
    dot: string;
    pvField?: string;
  };
  const placed: RoofLabel[] = [];
  if (labels) {
    for (const u of units) {
      const st = unitState(u, snapshot);
      const pt = toScreen(u.rect.x + u.rect.w / 2, u.rect.y + u.rect.d / 2, z + 0.15 + height + 0.9, iso, dy);
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
        wPx: (u.id.length + value.length + 2) * 7.3 + 26,
        name: u.id,
        value,
        color: LED[st.mode],
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
          wPx: (f.id.length + value.length + 2) * 7.3 + 26,
          name: f.id,
          value,
          color: '#f2cc0c',
          dot: gen > 0.02 ? '#f2cc0c' : '#8e8e8e',
          pvField: f.id,
        });
      }
    }
  }
  const offsets = declutter(
    placed.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.wPx * ls, h: 22 * ls })),
    4 * ls
  );

  return (
    <>
      {/* membrana de la azotea con juntas */}
      <g transform={planeMatrix(z + 0.005, iso, dy)} pointerEvents="none" opacity={0.5}>
        {Array.from({ length: 9 }, (_, i) => (
          <line
            key={`a${i}`}
            x1={(i + 1) * 2}
            y1={0.3}
            x2={(i + 1) * 2}
            y2={D - 0.3}
            stroke={dark ? '#4a4a46' : '#c2bfb6'}
            strokeWidth={0.04}
          />
        ))}
      </g>
      {pvFields.map(({ f, rows }) => (
        <g
          key={f.id}
          pointerEvents="none"
          data-testid={`ems-pv-${f.id}`}
          data-gen={gen.toFixed(2)}
          opacity={compact ? 0.5 : 1}
        >
          {rows.map((r, i) => (
            <g key={i}>
              {r.sides.map((sd, j) => (
                <path key={j} d={path(sd.points)} fill={shade(frame, 0.2 + j * 0.15)} />
              ))}
              <path d={path(r.top)} fill={cell} stroke={frame} strokeWidth={0.5} />
              {gen > 0.05 && (
                <path d={path(r.top)} fill="#ffffff" opacity={animate ? 0 : 0.12 * gen}>
                  {animate && (
                    <animate
                      attributeName="opacity"
                      values={`0;${(0.3 * gen).toFixed(2)};0`}
                      dur="3.2s"
                      begin={`${((i * 0.37) % 3.2).toFixed(2)}s`}
                      repeatCount="indefinite"
                    />
                  )}
                </path>
              )}
            </g>
          ))}
        </g>
      ))}
      {items.map((it, k) => {
        if (it.kind === 'parapet' || it.kind === 'hatch') {
          const c = it.kind === 'hatch' ? (dark ? '#77736a' : '#b5b0a5') : parapetColor;
          return (
            <g key={`p${k}`} pointerEvents="none">
              {it.p.sides.map((sd, i) => (
                <path key={i} d={path(sd.points)} fill={shade(c, 0.12 + i * 0.12)} />
              ))}
              <path d={path(it.p.top)} fill={c} stroke={shade(c, 0.2)} strokeWidth={0.4} />
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
        const pad = prism(
          { x: u.rect.x - 0.2, y: u.rect.y - 0.2, w: u.rect.w + 0.4, d: u.rect.d + 0.4 },
          z,
          0.15,
          iso,
          0,
          dy
        );
        // tuberías de refrigerante hacia el ducto vertical (esquina suroeste de la unidad)
        const pipeA = toScreen(u.rect.x + 0.3, u.rect.y - 0.2, z + 0.4, iso, dy);
        const pipeB = toScreen(u.rect.x + 0.3, u.rect.y - 1.0, z + 0.4, iso, dy);
        const pipeC = toScreen(u.rect.x + 0.3, u.rect.y - 1.0, z, iso, dy);
        const top = p.top;
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
            <path
              d={`M${pipeA.x},${pipeA.y}L${pipeB.x},${pipeB.y}L${pipeC.x},${pipeC.y}`}
              fill="none"
              stroke="#b87333"
              strokeWidth={2.2}
              strokeLinejoin="round"
            />
            <path
              d={`M${pipeA.x + 3},${pipeA.y + 1}L${pipeB.x + 3},${pipeB.y + 1}L${pipeC.x + 3},${pipeC.y + 1}`}
              fill="none"
              stroke={dark ? '#222' : '#555'}
              strokeWidth={2.6}
              strokeLinejoin="round"
              opacity={0.8}
            />
            {pad.sides.map((sd, i) => (
              <path key={`pad${i}`} d={path(sd.points)} fill={shade(parapetColor, 0.25 + i * 0.1)} />
            ))}
            <path d={path(pad.top)} fill={shade(parapetColor, 0.1)} />
            {p.sides.map((sd, i) => {
              const fill = shade(casing, 0.12 + i * 0.12);
              const [b0, b1, t1, t0] = sd.points;
              const n = Math.max(3, Math.round(height * 5));
              return (
                <g key={i}>
                  <path d={path(sd.points)} fill={fill} stroke={shade(casing, 0.45)} strokeWidth={0.5} />
                  {/* rejillas del serpentín */}
                  {Array.from({ length: n }, (_, j) => {
                    const v = 0.15 + (0.75 * j) / (n - 1);
                    const a = lerp(lerp(b0, t0, v), lerp(b1, t1, v), 0.06);
                    const b = lerp(lerp(b0, t0, v), lerp(b1, t1, v), 0.94);
                    return (
                      <line
                        key={j}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={shade(casing, 0.38 + i * 0.05)}
                        strokeWidth={0.7}
                      />
                    );
                  })}
                  {/* franja LED de estado */}
                  {i === 0 && (
                    <path
                      d={path([lerp(b0, t0, 0.88), lerp(b1, t1, 0.88), lerp(b1, t1, 0.95), lerp(b0, t0, 0.95)])}
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
              d={path(top)}
              fill={casing}
              stroke={hovered ? '#3d9df3' : shade(casing, 0.35)}
              strokeWidth={hovered ? 2 : 0.6}
            />
            <g transform={planeMatrix(z + 0.15 + height + 0.01, iso, dy)}>
              {fans.map(({ cx, cy }, i) => (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={rad * 1.12} fill={shade(casing, 0.55)} />
                  <circle cx={cx} cy={cy} r={rad * 1.02} fill={dark ? '#1e2024' : '#3a3d44'} />
                  <g>
                    {[0, 72, 144, 216, 288].map((a) => (
                      <path
                        key={a}
                        d={`M${cx} ${cy} q ${rad * 0.5} ${-rad * 0.28} ${rad * 0.92} 0 q ${-rad * 0.38} ${rad * 0.3} ${-rad * 0.92} 0Z`}
                        transform={`rotate(${a} ${cx} ${cy})`}
                        fill={dark ? '#8d939c' : '#a9aeb6'}
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
                  {[0.35, 0.7].map((k) => (
                    <circle
                      key={k}
                      cx={cx}
                      cy={cy}
                      r={rad * k}
                      fill="none"
                      stroke={shade(casing, 0.2)}
                      strokeWidth={0.05}
                    />
                  ))}
                  <line x1={cx - rad} y1={cy} x2={cx + rad} y2={cy} stroke={shade(casing, 0.2)} strokeWidth={0.05} />
                  <line x1={cx} y1={cy - rad} x2={cx} y2={cy + rad} stroke={shade(casing, 0.2)} strokeWidth={0.05} />
                  <circle cx={cx} cy={cy} r={rad * 0.14} fill={shade(casing, 0.3)} />
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
        pvFields.map(({ f }) => {
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
              stroke={colorManipulator.alpha('#f2cc0c', 0.7)}
              strokeWidth={1.2}
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          );
        })}
      {labels && (
        <g pointerEvents="none" data-testid="ems-roof-labels">
          {placed.map((l) => (
            <g
              key={l.id}
              transform={`translate(${l.x.toFixed(1)},${(l.y + (offsets[l.id] ?? 0)).toFixed(1)}) scale(${ls.toFixed(4)})`}
              data-testid={
                l.pvField ? (l.pvField === 'total' ? 'ems-pv-label' : `ems-pv-label-${l.pvField}`) : undefined
              }
            >
              <rect
                x={-l.wPx / 2}
                y={-11}
                width={l.wPx}
                height={22}
                rx={11}
                fill={surface}
                fillOpacity={0.95}
                stroke={l.color}
                strokeWidth={1.5}
              />
              <circle cx={-l.wPx / 2 + 11} cy={0} r={4} fill={l.dot} />
              <text x={-l.wPx / 2 + 20} y={4.5} fontSize={12.5} fill={labelColor}>
                <tspan fontWeight={700}>{l.name}</tspan>
                <tspan>{`  ${l.value}`}</tspan>
              </text>
            </g>
          ))}
        </g>
      )}
    </>
  );
};
