import React from 'react';
import { colorManipulator } from '@grafana/data';
import { Zone } from 'building/model';
import { IsoConfig, Pt, path, planeMatrix, pointDepth, prism, rotate, toScreen, wallQuad } from 'building/iso';
import { Furniture, edgesOf, interiorOf } from 'building/interior';
import { hash } from 'building/simulator';
import { ZoneState } from 'building/telemetry';

export const SLAB = 0.3;
const WALL_FULL = 2.9;
const PARAPET = 0.9;
const PARTITION = 1.1;
const CEILING = 2.7;
const MAX_PEOPLE = 14;

export interface ScenePalette {
  dark: boolean;
  ink: string;
  ink2: string;
  wall: string;
  glass: string;
  wood: string;
  metal: string;
  rack: string;
  plant: string;
  shirts: string[];
  skin: string[];
  surface: string;
}

interface Props {
  idPrefix: string;
  zone: Zone;
  state?: ZoneState;
  fill: string;
  highlight?: string;
  selected: boolean;
  offline: boolean;
  z0: number;
  dy: number;
  iso: IsoConfig;
  animate: boolean;
  palette: ScenePalette;
  label: string;
  manual: boolean;
  statusColor: string;
}

const shade = (c: string, a: number) => colorManipulator.darken(c, a);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function windows(q: Pt[], every: number, lo = 0.3, hi = 0.88): Pt[][] {
  const [b0, b1, t1, t0] = q;
  const n = Math.max(1, Math.round(Math.hypot(b1.x - b0.x, b1.y - b0.y) / every));
  return Array.from({ length: n }, (_, i) => {
    const u0 = (i + 0.15) / n;
    const u1 = (i + 0.85) / n;
    return [
      lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), lo),
      lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), lo),
      lerp(lerp(b0, b1, u1), lerp(t0, t1, u1), hi),
      lerp(lerp(b0, b1, u0), lerp(t0, t1, u0), hi),
    ];
  });
}

const FURNITURE_COLOR = (k: Furniture['kind'], p: ScenePalette) =>
  ({
    desk: p.wood,
    table: p.wood,
    tableRound: p.wood,
    counter: p.metal,
    sofa: p.dark ? '#5b6b85' : '#8fa7c9',
    bench: p.metal,
    rack: p.rack,
    cabinet: p.dark ? '#4a4d55' : '#a9adb6',
    plant: p.plant,
  })[k];

/** Zona en corte: piso coloreado por la vista, muros (fondo completo, frente de vidrio), mobiliario,
 * personas (sentadas o caminando), luminarias y difusores con flujo de aire animado. */
export const ZoneInterior: React.FC<Props> = ({
  idPrefix,
  zone,
  state,
  fill,
  highlight,
  selected,
  offline,
  z0,
  dy,
  iso,
  animate,
  palette: P,
  label,
  manual,
  statusColor,
}) => {
  const s = iso.scale;
  const zf = z0 + SLAB;
  const r = zone.rect;
  const inner = interiorOf(zone);
  const center = rotate(r.x + r.w / 2, r.y + r.d / 2, iso.azimuth);
  const floor = prism(r, z0, SLAB, iso, 0.08, dy);

  // --- muros: los de atrás (respecto al observador) van completos; los de adelante, bajos
  const edges = edgesOf(r).map((e) => {
    const mid = rotate((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2, iso.azimuth);
    const back = mid.y - center.y > 0.01 || mid.x - center.x < -0.01;
    const h = e.exterior ? (back ? WALL_FULL : PARAPET) : PARTITION;
    return {
      ...e,
      back,
      h,
      quad: wallQuad(e.a, e.b, zf, zf + h, iso, dy),
      ghost: wallQuad(e.a, e.b, zf, zf + WALL_FULL, iso, dy),
    };
  });
  const lit = (state?.lights ?? 0) > 0.05;
  const wallFace = (e: (typeof edges)[number]) => {
    const f = e.back ? shade(P.wall, 0.08) : shade(P.wall, 0.18);
    return (
      <g key={e.side}>
        {!e.back && e.exterior && (
          <path
            d={path(e.ghost)}
            fill={colorManipulator.alpha(P.glass, 0.12)}
            stroke={colorManipulator.alpha(P.glass, 0.5)}
            strokeWidth={0.6}
          />
        )}
        <path
          d={path(e.quad)}
          fill={e.exterior ? f : colorManipulator.alpha(f, 0.9)}
          stroke={shade(f, 0.25)}
          strokeWidth={0.6}
        />
        {e.exterior &&
          e.back &&
          zone.windows?.includes(e.side) &&
          windows(e.quad, s * 2.6).map((w, i) => (
            <path
              key={i}
              d={path(w)}
              fill={lit ? colorManipulator.alpha('#ffe08a', 0.75) : colorManipulator.alpha(P.glass, 0.85)}
            />
          ))}
      </g>
    );
  };

  // --- objetos interiores ordenados de atrás hacia adelante
  type Obj = { depth: number; el: React.ReactNode };
  const objs: Obj[] = [];
  inner.furniture.forEach((f, i) => {
    const p = prism(f.rect, zf, f.h, iso, 0, dy);
    const c = FURNITURE_COLOR(f.kind, P);
    const leds: React.ReactNode[] = [];
    if (f.kind === 'rack') {
      const face = p.sides[0].points;
      for (let k = 0; k < 4; k++) {
        const pt = lerp(
          lerp(face[0], face[1], 0.3 + 0.4 * (k % 2)),
          lerp(face[3], face[2], 0.3 + 0.4 * (k % 2)),
          0.25 + 0.18 * k
        );
        const ledColor = offline ? P.ink2 : k === 3 && hash(zone.id, i) > 0.8 ? '#fab219' : '#3ddc84';
        leds.push(
          <circle key={k} cx={pt.x} cy={pt.y} r={0.9} fill={ledColor}>
            {animate && (
              <animate
                attributeName="opacity"
                values="1;0.15;1"
                dur={`${0.6 + 1.6 * hash(zone.id, i, k)}s`}
                repeatCount="indefinite"
              />
            )}
          </circle>
        );
      }
    }
    objs.push({
      depth: p.depth,
      el: (
        <g key={`f${i}`}>
          {p.sides.map((sd, j) => (
            <path key={j} d={path(sd.points)} fill={shade(c, 0.18 + j * 0.12)} />
          ))}
          <path d={path(p.top)} fill={c} stroke={shade(c, 0.3)} strokeWidth={0.4} />
          {leds}
        </g>
      ),
    });
  });

  // personas: sentadas en su puesto; ~30 % caminan hacia el pasillo y vuelven
  const n = Math.min(state?.occupants ?? 0, inner.seats.length, MAX_PEOPLE);
  for (let i = 0; i < n; i++) {
    const seat = inner.seats[(i * 7) % inner.seats.length];
    const walker = hash(zone.id, 'camina', i) < 0.3;
    const base = toScreen(seat.x, seat.y, zf, iso, dy);
    const shirt = P.shirts[i % P.shirts.length];
    const skin = P.skin[i % P.skin.length];
    let motion: React.ReactNode = null;
    if (walker && animate) {
      const tgt = toScreen(
        inner.hub.x + (hash(zone.id, i, 'x') - 0.5) * 2,
        inner.hub.y + (hash(zone.id, i, 'y') - 0.5) * 2,
        zf,
        iso,
        dy
      );
      const dx = (tgt.x - base.x).toFixed(1);
      const dyy = (tgt.y - base.y).toFixed(1);
      const dur = 9 + 7 * hash(zone.id, i, 'dur');
      motion = (
        <animateTransform
          attributeName="transform"
          type="translate"
          additive="sum"
          values={`0,0;${dx},${dyy};${dx},${dyy};0,0;0,0`}
          keyTimes="0;0.3;0.5;0.8;1"
          dur={`${dur.toFixed(1)}s`}
          begin={`-${(dur * hash(zone.id, i, 'b')).toFixed(1)}s`}
          repeatCount="indefinite"
        />
      );
    }
    const h = walker ? 1.25 : 0.85; // de pie o sentado
    objs.push({
      depth: pointDepth(seat.x, seat.y, iso, dy) - 0.01,
      el: (
        <g
          key={`p${i}`}
          transform={`translate(${base.x.toFixed(1)},${base.y.toFixed(1)})`}
          data-testid={walker ? 'ems-walker' : undefined}
        >
          {motion}
          <ellipse cx={0} cy={0} rx={s * 0.22} ry={s * 0.11} fill="#000" opacity={0.18} />
          <rect x={-s * 0.17} y={-h * s} width={s * 0.34} height={h * s * 0.82} rx={s * 0.15} fill={shirt} />
          <circle cx={0} cy={-h * s - s * 0.2} r={s * 0.19} fill={skin} />
        </g>
      ),
    });
  }
  objs.sort((a, b) => b.depth - a.depth);

  // --- luminarias (halo en el piso) y difusores con aire frío
  const glow = lit
    ? inner.lights.map((l, i) => (
        <circle
          key={i}
          cx={l.x}
          cy={l.y}
          r={2.3}
          fill={`url(#${idPrefix}-glow)`}
          opacity={0.25 + 0.65 * (state?.lights ?? 0)}
        />
      ))
    : null;
  const hvacColor = state?.drForced ? '#eb6834' : state?.hvacOn ? '#3987e5' : P.dark ? '#55554f' : '#b9b7af';
  const air: React.ReactNode[] = [];
  if (state?.hvacOn) {
    inner.diffusers.forEach((d, i) => {
      for (let k = 0; k < 3; k++) {
        const ox = (k - 1) * 0.7;
        const top = toScreen(d.x + ox, d.y, zf + CEILING - 0.1, iso, dy);
        const bottom = toScreen(d.x + ox * 1.8, d.y, zf + 0.4, iso, dy);
        const dur = 1.8 + 0.4 * k;
        air.push(
          <circle key={`${i}-${k}`} cx={top.x} cy={top.y} r={1.5} fill="#6da7ec" opacity={animate ? 0 : 0.55}>
            {animate && (
              <>
                <animate
                  attributeName="cx"
                  values={`${top.x.toFixed(1)};${bottom.x.toFixed(1)}`}
                  dur={`${dur}s`}
                  begin={`${(k * 0.6).toFixed(1)}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="cy"
                  values={`${top.y.toFixed(1)};${bottom.y.toFixed(1)}`}
                  dur={`${dur}s`}
                  begin={`${(k * 0.6).toFixed(1)}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0;0.9;0"
                  dur={`${dur}s`}
                  begin={`${(k * 0.6).toFixed(1)}s`}
                  repeatCount="indefinite"
                />
              </>
            )}
          </circle>
        );
      }
    });
  }
  const diffusers = inner.diffusers.map((d, i) => (
    <g key={i} transform={planeMatrix(zf + CEILING, iso, dy)}>
      <rect
        x={d.x - 0.4}
        y={d.y - 0.4}
        width={0.8}
        height={0.8}
        fill={hvacColor}
        stroke={shade(hvacColor, 0.35)}
        strokeWidth={0.06}
      />
      {state?.drForced && (
        <g fill="#fff">
          <rect x={d.x - 0.22} y={d.y - 0.25} width={0.14} height={0.5} />
          <rect x={d.x + 0.08} y={d.y - 0.25} width={0.14} height={0.5} />
        </g>
      )}
    </g>
  ));

  // --- rótulo flotante
  const tagPt = toScreen(r.x + r.w / 2, r.y + r.d / 2, zf + WALL_FULL + 1.1, iso, dy);
  const text = `${zone.id} · ${label}`;
  const tw = text.length * 6.2 + 18 + (manual ? 16 : 0);

  return (
    <>
      <path
        d={path(floor.top)}
        fill={fill}
        stroke={highlight ?? shade(fill, 0.3)}
        strokeWidth={highlight ? (selected ? 3 : 2) : 0.6}
      />
      {offline && <path d={path(floor.top)} fill={`url(#${idPrefix}-hatch)`} pointerEvents="none" />}
      {floor.sides.map((sd, i) => (
        <path key={i} d={path(sd.points)} fill={shade(fill, 0.3 + i * 0.1)} />
      ))}
      {glow && (
        <g transform={planeMatrix(zf + 0.01, iso, dy)} pointerEvents="none">
          {glow}
        </g>
      )}
      {edges.filter((e) => e.back).map(wallFace)}
      <g pointerEvents="none">{objs.map((o) => o.el)}</g>
      <g pointerEvents="none">
        {diffusers}
        {air}
      </g>
      {edges.filter((e) => !e.back).map(wallFace)}
      <g pointerEvents="none" transform={`translate(${tagPt.x.toFixed(1)},${tagPt.y.toFixed(1)})`}>
        <line x1={0} y1={0} x2={0} y2={s * 0.9} stroke={P.ink2} strokeWidth={0.8} opacity={0.6} />
        <rect
          x={-tw / 2}
          y={-11}
          width={tw}
          height={18}
          rx={9}
          fill={P.surface}
          stroke={highlight ?? colorManipulator.alpha(P.ink2, 0.4)}
          strokeWidth={highlight ? 1.5 : 0.8}
        />
        <circle cx={-tw / 2 + 9} cy={-2} r={3.2} fill={statusColor} />
        <text x={-tw / 2 + 16} y={2} fontSize={10.5} fill={P.ink} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {text}
        </text>
        {manual && (
          <g data-testid={`ems-manual-${zone.id}`}>
            <rect x={tw / 2 - 17} y={-8} width={13} height={12} rx={3} fill="#eda100" />
            <text x={tw / 2 - 10.5} y={1.5} fontSize={9} fontWeight={700} textAnchor="middle" fill="#1a1a19">
              M
            </text>
          </g>
        )}
      </g>
    </>
  );
};
