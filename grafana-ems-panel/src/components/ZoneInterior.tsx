import React from 'react';
import { PTAC_BY_ZONE, Rect, ZONES, Zone } from 'building/model';
import { IsoConfig, Pt, path, planeMatrix, pointDepth, prism, rotate, toScreen } from 'building/iso';
import { Chair, Furniture, ZoneEdge, interiorOf, zoneEdges } from 'building/interior';
import { FloorFinish, Materials, ZoneMark, blend, faceColor, lit } from 'building/materials';
import { hash } from 'building/simulator';
import { Status, ZoneState } from 'building/telemetry';
import { boxPaths, faceQuad, onFace, segments } from './IsoPrimitives';

export const SLAB = 0.3;
const WALL_FULL = 2.9;
const PARAPET = 0.9;
const PARTITION = 1.1;
const CEILING = 2.7;
const EXT_T = 0.22;
const PART_T = 0.07;
const MAX_PEOPLE = 14;

const SHIRTS = {
  dark: ['#9db0c9', '#c9a98a', '#b9b8b2', '#98bca2', '#b49cc0'],
  light: ['#4a6789', '#8a6449', '#55544f', '#4b7a5c', '#6f5a84'],
};
const SKIN = ['#e0b08a', '#c58c62', '#8d5a3b', '#f0c9a5'];

interface Props {
  idPrefix: string;
  zone: Zone;
  state?: ZoneState;
  status: Status;
  /** Tinte, contorno y rayado según la capa (no tapan el material). */
  mark: ZoneMark;
  finish: FloorFinish;
  selected: boolean;
  hovered?: boolean;
  z0: number;
  dy: number;
  iso: IsoConfig;
  animate: boolean;
  M: Materials;
  /** Opacidad del mobiliario y las personas (menos detalle cuando la escala es pequeña). */
  detail?: number;
  /** Escala pequeña: mobiliario simplificado (menos nodos). */
  simple?: boolean;
  /** Color de realce para el paso del mouse y la selección (primario del tema). */
  accent: string;
  /** Hora de noche: ventanas oscuras. */
  night?: boolean;
}

/**
 * Punto de anclaje de la ficha de la zona (sobre el piso, a altura z sobre la losa): el centro de la parte
 * principal; en los pasillos largos, el extremo más alejado de los centros de las otras zonas de la planta.
 */
export function tagAnchor(zone: Zone, z0: number, dy: number, iso: IsoConfig, z = 0): Pt {
  const r = zone.rect;
  let x = r.x + r.w / 2;
  let y = r.y + r.d / 2;
  if (zone.type === 'pasillo' && Math.max(r.w, r.d) > 3 * Math.min(r.w, r.d)) {
    const others = ZONES.filter((o) => o.floor === zone.floor && o.id !== zone.id).map((o) => ({
      x: o.rect.x + o.rect.w / 2,
      y: o.rect.y + o.rect.d / 2,
    }));
    let best = -1;
    for (const f of [0.25, 0.5, 0.75]) {
      const cx = r.w > r.d ? r.x + r.w * f : x;
      const cy = r.w > r.d ? y : r.y + r.d * f;
      const d = Math.min(...others.map((o) => Math.hypot(o.x - cx, o.y - cy)), Infinity);
      if (d > best + 0.01) {
        best = d;
        x = cx;
        y = cy;
      }
    }
  }
  return toScreen(x, y, z0 + SLAB + z, iso, dy);
}

/** Rectángulo (planta) del muro de un borde, hacia el interior de la zona. */
export function wallRect(e: Pick<ZoneEdge, 'side' | 'a' | 'b'>, t: number): Rect {
  const x0 = Math.min(e.a.x, e.b.x);
  const x1 = Math.max(e.a.x, e.b.x);
  const y0 = Math.min(e.a.y, e.b.y);
  const y1 = Math.max(e.a.y, e.b.y);
  switch (e.side) {
    case 's':
      return { x: x0, y: y0, w: x1 - x0, d: t };
    case 'n':
      return { x: x0, y: y0 - t, w: x1 - x0, d: t };
    case 'w':
      return { x: x0, y: y0, w: t, d: y1 - y0 };
    default:
      return { x: x0 - t, y: y0, w: t, d: y1 - y0 };
  }
}

/** Franja de sombra ambiental junto al muro (planta). */
function aoRect(e: Pick<ZoneEdge, 'side' | 'a' | 'b'>, t: number, width: number): Rect {
  const w = wallRect(e, t);
  switch (e.side) {
    case 's':
      return { x: w.x, y: w.y + t, w: w.w, d: width };
    case 'n':
      return { x: w.x, y: w.y - width, w: w.w, d: width };
    case 'w':
      return { x: w.x + t, y: w.y, w: width, d: w.d };
    default:
      return { x: w.x - width, y: w.y, w: width, d: w.d };
  }
}

const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, d: r.d + 2 * m });

/** Zona en corte: piso con su acabado, tinte de la capa, muros con grosor, ventanas con carpintería,
 * mobiliario a escala con sombras de contacto, personas, unidades interiores VRF con flujo de aire. */
export const ZoneInterior: React.FC<Props> = ({
  idPrefix,
  zone,
  state,
  status,
  mark,
  finish,
  selected,
  hovered = false,
  z0,
  dy,
  iso,
  animate,
  M,
  detail = 1,
  simple = false,
  accent,
  night = false,
}) => {
  const s = iso.scale;
  const zf = z0 + SLAB;
  const r = zone.rect;
  const inner = interiorOf(zone);
  const outline = zoneEdges(zone);
  const plane = planeMatrix(zf + 0.002, iso, dy);
  const box = (rect: Rect, z: number, h: number) => prism(rect, zf + z, h, iso, 0, dy);
  const lit_ = (state?.lights ?? 0) > 0.05;
  const occupied = (state?.occupants ?? 0) > 0;

  // --- muros: los de atrás (respecto al observador) van completos; los de adelante, bajos con vidrio encima
  const edges = outline.map((e, i) => {
    const center = rotate(e.part.x + e.part.w / 2, e.part.y + e.part.d / 2, iso.azimuth);
    const mid = rotate((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2, iso.azimuth);
    const back = mid.y - center.y > 0.01 || mid.x - center.x < -0.01;
    const t = e.exterior ? EXT_T : PART_T;
    const h = e.exterior ? (back ? WALL_FULL : PARAPET) : PARTITION;
    const p = box(wallRect(e, t), 0, h);
    return { ...e, key: i, back, h, t, p };
  });

  const wall = (e: (typeof edges)[number]) => {
    const horizontal = e.side === 'n' || e.side === 's';
    const longFace = e.p.sides.find((sd) =>
      horizontal ? sd.edge === 'n' || sd.edge === 's' : sd.edge === 'e' || sd.edge === 'w'
    );
    const windows = e.exterior && zone.windows?.includes(e.side) && longFace;
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    const color = e.exterior ? M.wall : blend(M.wall, M.partition, 0.5);
    const out: React.ReactNode[] = boxPaths(e.p, color, `w${e.key}`, { top: M.wallCap });
    if (windows && e.back) {
      // ventanas en el muro de fondo: paños de vidrio con marco (la carpintería es el muro entre paños)
      const n = Math.max(1, Math.round(len / 1.8));
      const q = longFace.points;
      for (let i = 0; i < n; i++) {
        const u0 = (i + 0.08) / n;
        const u1 = (i + 0.92) / n;
        const pane = faceQuad(q, u0, u1, 0.3, 0.9);
        out.push(
          <path
            key={`g${e.key}-${i}`}
            d={path(pane)}
            fill={`url(#${idPrefix}-${lit_ && night ? 'glassLit' : 'glass'})`}
            stroke={M.mullion}
            strokeWidth={0.5}
            strokeLinejoin="round"
          />
        );
      }
      // travesaño horizontal y reflejo
      const rails: Array<[Pt, Pt]> = [];
      for (let i = 0; i < n; i++) {
        rails.push([onFace(q, (i + 0.08) / n, 0.72), onFace(q, (i + 0.92) / n, 0.72)]);
      }
      out.push(<path key={`gr${e.key}`} d={segments(rails)} stroke={M.mullion} strokeWidth={0.45} opacity={0.8} />);
    }
    if (!e.back && e.exterior) {
      // muro cortina sobre el antepecho: vidrio translúcido con montantes
      const q = [
        toScreen(e.a.x, e.a.y, zf + PARAPET, iso, dy),
        toScreen(e.b.x, e.b.y, zf + PARAPET, iso, dy),
        toScreen(e.b.x, e.b.y, zf + WALL_FULL, iso, dy),
        toScreen(e.a.x, e.a.y, zf + WALL_FULL, iso, dy),
      ];
      const n = Math.max(1, Math.round(len / 1.8));
      const mull: Array<[Pt, Pt]> = [];
      for (let i = 0; i <= n; i++) {
        mull.push([onFace(q, i / n, 0), onFace(q, i / n, 1)]);
      }
      out.push(
        <path key={`c${e.key}`} d={path(q)} fill={`url(#${idPrefix}-curtain)`} />,
        <path key={`cm${e.key}`} d={segments(mull)} stroke={M.mullion} strokeWidth={0.6} opacity={0.55} />,
        <path
          key={`ct${e.key}`}
          d={segments([[q[3], q[2]]])}
          stroke={M.mullion}
          strokeWidth={1}
          opacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    return <g key={`wall${e.key}`}>{out}</g>;
  };

  // --- objetos interiores ordenados de atrás hacia adelante
  type Obj = { depth: number; el: React.ReactNode };
  const objs: Obj[] = [];
  const shadows: Rect[] = [];

  const chairObj = (c: Chair, k: number) => {
    const seat = box({ x: c.x - 0.24, y: c.y - 0.24, w: 0.48, d: 0.48 }, 0.42, 0.07);
    const backRect: Rect =
      c.facing === 'n'
        ? { x: c.x - 0.22, y: c.y - 0.27, w: 0.44, d: 0.06 }
        : c.facing === 's'
          ? { x: c.x - 0.22, y: c.y + 0.21, w: 0.44, d: 0.06 }
          : c.facing === 'e'
            ? { x: c.x - 0.27, y: c.y - 0.22, w: 0.06, d: 0.44 }
            : { x: c.x + 0.21, y: c.y - 0.22, w: 0.06, d: 0.44 };
    const back = box(backRect, 0.5, 0.36);
    shadows.push({ x: c.x - 0.28, y: c.y - 0.28, w: 0.56, d: 0.56 });
    objs.push({ depth: seat.depth, el: <g key={`ch${k}`}>{boxPaths(seat, M.chair, 'c', { edge: false })}</g> });
    objs.push({ depth: back.depth - 0.001, el: <g key={`cb${k}`}>{boxPaths(back, M.chair, 'b', { edge: false })}</g> });
  };

  const furnitureObj = (f: Furniture, i: number) => {
    const fr = f.rect;
    const els: React.ReactNode[] = [];
    let depthP = box(fr, 0, f.h);
    shadows.push(grow(fr, 0.12));
    switch (f.kind) {
      case 'desk': {
        const top = box(fr, 0.71, 0.04);
        if (!simple) {
          const ped = box({ x: fr.x + fr.w - 0.46, y: fr.y + 0.06, w: 0.4, d: fr.d - 0.12 }, 0, 0.71);
          const leg = box({ x: fr.x + 0.05, y: fr.y + 0.06, w: 0.05, d: fr.d - 0.12 }, 0, 0.71);
          els.push(...boxPaths(leg, M.deskBase, 'l', { edge: false }), ...boxPaths(ped, M.deskBase, 'p'));
        }
        els.push(...boxPaths(top, M.deskTop, 't'));
        const mon = box({ x: fr.x + fr.w / 2 - 0.3, y: fr.y + fr.d - 0.2, w: 0.6, d: 0.04 }, 0.76, 0.36);
        els.push(...boxPaths(mon, M.screen, 'm', { edge: false }));
        // pantalla encendida hacia el puesto (cara sur del monitor si se ve)
        const face = mon.sides.find((sd) => sd.edge === 's');
        if (face && occupied && lit_) {
          els.push(
            <path key="scr" d={path(faceQuad(face.points, 0.06, 0.94, 0.1, 0.92))} fill={M.screenOn} opacity={0.85} />
          );
        }
        depthP = top;
        break;
      }
      case 'table': {
        const top = box(fr, 0.71, 0.05);
        const long = fr.d >= fr.w;
        for (const t of [0.22, 0.78]) {
          const b = long
            ? box({ x: fr.x + fr.w / 2 - 0.12, y: fr.y + fr.d * t - 0.12, w: 0.24, d: 0.24 }, 0, 0.71)
            : box({ x: fr.x + fr.w * t - 0.12, y: fr.y + fr.d / 2 - 0.12, w: 0.24, d: 0.24 }, 0, 0.71);
          els.push(...boxPaths(b, M.deskBase, `b${t}`, { edge: false }));
        }
        els.push(...boxPaths(top, M.wood, 't'));
        depthP = top;
        break;
      }
      case 'tableRound':
      case 'cabinet':
        els.push(...boxPaths(depthP, f.kind === 'cabinet' ? M.deskBase : M.wood, 'x'));
        break;
      case 'counter': {
        const body = box({ x: fr.x + 0.05, y: fr.y + 0.05, w: fr.w - 0.1, d: fr.d - 0.1 }, 0, f.h - 0.04);
        const top = box(fr, f.h - 0.04, 0.04);
        els.push(...boxPaths(body, M.wood, 'b'), ...boxPaths(top, M.stone, 't'));
        break;
      }
      case 'sofa': {
        // respaldo del lado más cercano al muro de la zona
        const dl = fr.x - r.x;
        const dr = r.x + r.w - (fr.x + fr.w);
        const ds = fr.y - r.y;
        const dn = r.y + r.d - (fr.y + fr.d);
        const m = Math.min(dl, dr, ds, dn);
        const t = 0.22;
        const back: Rect =
          m === dl
            ? { x: fr.x, y: fr.y, w: t, d: fr.d }
            : m === dr
              ? { x: fr.x + fr.w - t, y: fr.y, w: t, d: fr.d }
              : m === ds
                ? { x: fr.x, y: fr.y, w: fr.w, d: t }
                : { x: fr.x, y: fr.y + fr.d - t, w: fr.w, d: t };
        const seat = box(fr, 0.1, 0.32);
        els.push(...boxPaths(seat, M.fabric, 's'), ...boxPaths(box(back, 0.1, 0.62), lit(M.fabric, 0.92), 'b'));
        break;
      }
      case 'bench':
        els.push(...boxPaths(box(fr, 0.38, 0.06), M.wood, 'b'));
        break;
      case 'rack': {
        const p = box(fr, 0, f.h);
        els.push(...boxPaths(p, M.rack, 'r', { top: lit(M.rack, 1.25) }));
        // puerta (cara corta visible) con perforado, unidades y LEDs
        const shortFace = [...p.sides].sort(
          (a, b) =>
            Math.hypot(a.points[1].x - a.points[0].x, a.points[1].y - a.points[0].y) -
            Math.hypot(b.points[1].x - b.points[0].x, b.points[1].y - b.points[0].y)
        )[0];
        const q = shortFace.points;
        els.push(
          <path key="door" d={path(faceQuad(q, 0.1, 0.9, 0.04, 0.96))} fill={faceColor(M.rackDoor, shortFace.facing)} />
        );
        if (!simple) {
          const units: Array<[Pt, Pt]> = [];
          for (let k = 1; k < 9; k++) {
            units.push([onFace(q, 0.16, k / 9), onFace(q, 0.84, k / 9)]);
          }
          els.push(<path key="u" d={segments(units)} stroke="#000" strokeWidth={0.35} opacity={0.45} />);
        }
        for (let k = 0; k < (simple ? 2 : 5); k++) {
          const pt = onFace(q, 0.26 + (k % 2) * 0.12, 0.88 - k * 0.16);
          const ledColor =
            status === 'offline'
              ? '#6e737a'
              : k === 3 && hash(zone.id, i) > 0.8
                ? '#fab219'
                : k === 0
                  ? '#3d9df3'
                  : '#3ddc84';
          els.push(
            <circle key={`led${k}`} cx={pt.x} cy={pt.y} r={0.75} fill={ledColor}>
              {animate && k > 0 && (
                <animate
                  attributeName="opacity"
                  values="1;0.2;1"
                  dur={`${0.6 + 1.6 * hash(zone.id, i, k)}s`}
                  repeatCount="indefinite"
                />
              )}
            </circle>
          );
        }
        break;
      }
      case 'plant': {
        const pot = box({ x: fr.x + 0.08, y: fr.y + 0.08, w: fr.w - 0.16, d: fr.d - 0.16 }, 0, 0.42);
        els.push(...boxPaths(pot, M.pot, 'p'));
        const cx = fr.x + fr.w / 2;
        const cy = fr.y + fr.d / 2;
        const rr = Math.max(fr.w, fr.d) * 0.62 * s;
        const c1 = toScreen(cx, cy, zf + 0.42 + f.h * 0.42, iso, dy);
        els.push(
          <circle key="f1" cx={c1.x - rr * 0.35} cy={c1.y + rr * 0.15} r={rr * 0.7} fill={`url(#${idPrefix}-leaf)`} />,
          <circle key="f2" cx={c1.x + rr * 0.35} cy={c1.y + rr * 0.1} r={rr * 0.68} fill={`url(#${idPrefix}-leaf)`} />,
          <circle key="f3" cx={c1.x} cy={c1.y - rr * 0.35} r={rr * 0.72} fill={`url(#${idPrefix}-leaf)`} />
        );
        break;
      }
      case 'stall': {
        // cubículo de baño: mamparas laterales, puerta entreabierta e inodoro contra el muro
        const along = fr.w < fr.d; // mamparas paralelas al eje y
        const tk = 0.04;
        const panels: Rect[] = along
          ? [
              { x: fr.x, y: fr.y, w: tk, d: fr.d },
              { x: fr.x + fr.w - tk, y: fr.y, w: tk, d: fr.d },
            ]
          : [
              { x: fr.x, y: fr.y, w: fr.w, d: tk },
              { x: fr.x, y: fr.y + fr.d - tk, w: fr.w, d: tk },
            ];
        const nearWallLow = along ? fr.y - r.y < r.y + r.d - (fr.y + fr.d) : fr.x - r.x < r.x + r.w - (fr.x + fr.w);
        const toilet: Rect = along
          ? { x: fr.x + fr.w / 2 - 0.2, y: nearWallLow ? fr.y + 0.08 : fr.y + fr.d - 0.68, w: 0.4, d: 0.6 }
          : { x: nearWallLow ? fr.x + 0.08 : fr.x + fr.w - 0.68, y: fr.y + fr.d / 2 - 0.2, w: 0.6, d: 0.4 };
        els.push(...boxPaths(box(toilet, 0, 0.42), M.porcelain, 'wc'));
        panels.forEach((pr, k) => els.push(...boxPaths(box(pr, 0.15, 1.75), M.partition, `pn${k}`)));
        break;
      }
      case 'sink': {
        const vanity = box(fr, 0, f.h);
        els.push(...boxPaths(vanity, M.stone, 'v'));
        els.push(
          <ellipse
            key="basin"
            cx={fr.x + fr.w / 2}
            cy={fr.y + fr.d / 2}
            rx={fr.w * 0.3}
            ry={fr.d * 0.3}
            fill={M.porcelain}
            stroke={lit(M.porcelain, 0.75)}
            strokeWidth={0.02}
            transform={planeMatrix(zf + f.h + 0.002, iso, dy)}
          />
        );
        break;
      }
    }
    objs.push({ depth: depthP.depth, el: <g key={`f${i}`}>{els}</g> });
  };

  inner.furniture.forEach(furnitureObj);
  inner.chairs.forEach(chairObj);

  // PTAC de pared (baños): equipo bajo el techo contra la fachada, con su LED de estado
  const ptac = PTAC_BY_ZONE[zone.id];
  if (ptac) {
    const w = 1.0;
    const t = 0.3;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.d / 2;
    const off = EXT_T + 0.02;
    const rect: Rect =
      ptac.facade === 's'
        ? { x: cx - w / 2, y: r.y + off, w, d: t }
        : ptac.facade === 'n'
          ? { x: cx - w / 2, y: r.y + r.d - t - off, w, d: t }
          : ptac.facade === 'w'
            ? { x: r.x + off, y: cy - w / 2, w: t, d: w }
            : { x: r.x + r.w - t - off, y: cy - w / 2, w: t, d: w };
    const p = box(rect, 1.9, 0.42);
    const led = state?.drForced ? '#eb6834' : state?.hvacOn ? '#3987e5' : M.dark ? '#55554f' : '#9a988f';
    objs.push({
      depth: p.depth,
      el: (
        <g key="ptac" data-testid={`ems-ptac-${ptac.id}`}>
          {boxPaths(p, M.casing, 'pt')}
          <circle cx={p.center.x} cy={p.center.y} r={1.4} fill={led} />
        </g>
      ),
    });
  }

  // personas: sentadas en su puesto; ~30 % caminan hacia el pasillo y vuelven
  const shirts = M.dark ? SHIRTS.dark : SHIRTS.light;
  const n = Math.min(state?.occupants ?? 0, inner.seats.length, MAX_PEOPLE);
  for (let i = 0; i < n; i++) {
    const seat = inner.seats[(i * 7) % inner.seats.length];
    const walker = hash(zone.id, 'camina', i) < 0.3;
    const base = toScreen(seat.x, seat.y, zf, iso, dy);
    const shirt = shirts[i % shirts.length];
    const skin = SKIN[i % SKIN.length];
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
    // alturas (m): sentado cadera 0.45 / hombros 1.05; de pie piernas 0–0.85 / hombros 1.45
    const hip = walker ? 0.85 : 0.45;
    const shoulder = walker ? 1.45 : 1.05;
    const head = shoulder + 0.17;
    const bw = 0.36 * s;
    objs.push({
      depth: pointDepth(seat.x, seat.y, iso, dy) - 0.01,
      el: (
        <g
          key={`p${i}`}
          transform={`translate(${base.x.toFixed(1)},${base.y.toFixed(1)})`}
          data-testid={walker ? 'ems-walker' : undefined}
        >
          {motion}
          <ellipse cx={0} cy={0} rx={s * 0.24} ry={s * 0.12} fill="#000" opacity={M.aoOpacity} />
          {walker && (
            <rect
              x={-bw * 0.36}
              y={-hip * s}
              width={bw * 0.72}
              height={hip * s}
              rx={bw * 0.2}
              fill={lit(M.chair, 1.1)}
            />
          )}
          <rect
            x={-bw / 2}
            y={-shoulder * s}
            width={bw}
            height={(shoulder - hip + 0.08) * s}
            rx={bw * 0.42}
            fill={shirt}
          />
          <rect
            x={bw * 0.06}
            y={-shoulder * s + bw * 0.2}
            width={bw * 0.38}
            height={(shoulder - hip) * s * 0.7}
            rx={bw * 0.18}
            fill="#000"
            opacity={0.12}
          />
          <circle cx={0} cy={-head * s} r={s * 0.12} fill={skin} />
        </g>
      ),
    });
  }
  objs.sort((a, b) => b.depth - a.depth);

  // --- luminarias (halo en el piso) y unidades interiores VRF (casete de 4 vías) con aire frío
  const glow = lit_
    ? inner.lights.map((l, i) => (
        <circle
          key={`gl${i}`}
          cx={l.x}
          cy={l.y}
          r={2.4}
          fill={`url(#${idPrefix}-glow)`}
          opacity={0.2 + 0.6 * (state?.lights ?? 0)}
        />
      ))
    : null;
  const hvacColor = state?.drForced ? '#eb6834' : state?.hvacOn ? '#3d9df3' : M.dark ? '#5b5f66' : '#a4a8ae';
  const air: React.ReactNode[] = [];
  if (state?.hvacOn) {
    inner.diffusers.forEach((d, i) => {
      for (let k = 0; k < 3; k++) {
        const ox = (k - 1) * 0.7;
        const top = toScreen(d.x + ox, d.y, zf + CEILING - 0.15, iso, dy);
        const bottom = toScreen(d.x + ox * 1.8, d.y, zf + 0.4, iso, dy);
        const dur = 1.8 + 0.4 * k;
        air.push(
          <circle key={`${i}-${k}`} cx={top.x} cy={top.y} r={1.3} fill="#6da7ec" opacity={animate ? 0 : 0.5}>
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
                  values="0;0.85;0"
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
  const cassettes = inner.diffusers.map((d, i) => {
    const p = box({ x: d.x - 0.42, y: d.y - 0.42, w: 0.84, d: 0.84 }, CEILING - 0.12, 0.12);
    return (
      <g key={`cs${i}`}>
        {boxPaths(p, M.casing, 'k')}
        <g transform={planeMatrix(zf + CEILING + 0.001, iso, dy)}>
          <rect
            x={d.x - 0.26}
            y={d.y - 0.26}
            width={0.52}
            height={0.52}
            fill="none"
            stroke={lit(M.casing, 0.72)}
            strokeWidth={0.03}
          />
          <path
            d={`M${d.x - 0.34},${d.y - 0.32}h0.68M${d.x - 0.34},${d.y + 0.32}h0.68M${d.x - 0.32},${d.y - 0.34}v0.68M${d.x + 0.32},${d.y - 0.34}v0.68`}
            stroke={lit(M.casing, 0.6)}
            strokeWidth={0.04}
          />
          <circle cx={d.x + 0.3} cy={d.y - 0.3} r={0.06} fill={hvacColor} />
          {state?.drForced && (
            <g fill="#eb6834">
              <rect x={d.x - 0.12} y={d.y - 0.14} width={0.08} height={0.28} />
              <rect x={d.x + 0.04} y={d.y - 0.14} width={0.08} height={0.28} />
            </g>
          )}
        </g>
      </g>
    );
  });

  const focus = selected || hovered ? accent : undefined;
  const multi = zone.rects.length > 1;
  const hatchId =
    mark.hatch === 'offline'
      ? 'offline'
      : mark.hatch === 'alert'
        ? status === 'critical'
          ? 'critical'
          : 'warning'
        : undefined;

  return (
    <>
      {/* piso: acabado, halos de luz, sombras ambientales, tinte de la capa y realce */}
      <g transform={plane}>
        {zone.rects.map((pr, k) => (
          <rect key={`fl${k}`} x={pr.x} y={pr.y} width={pr.w} height={pr.d} fill={finish.color} />
        ))}
        {zone.rects.map((pr, k) => (
          <rect
            key={`pt${k}`}
            x={pr.x}
            y={pr.y}
            width={pr.w}
            height={pr.d}
            fill={`url(#${idPrefix}-fl-${finish.pattern})`}
            pointerEvents="none"
          />
        ))}
        <g pointerEvents="none">
          {glow}
          {edges.map((e) => {
            const a = aoRect(e, e.t, e.exterior ? 0.8 : 0.55);
            return (
              <rect
                key={`ao${e.key}`}
                x={a.x}
                y={a.y}
                width={a.w}
                height={a.d}
                fill={`url(#${idPrefix}-ao-${e.side})`}
              />
            );
          })}
          {detail > 0.6 &&
            shadows.map((sh, k) => (
              <rect key={`sh${k}`} x={sh.x} y={sh.y} width={sh.w} height={sh.d} fill={`url(#${idPrefix}-contact)`} />
            ))}
          {mark.tint &&
            zone.rects.map((pr, k) => (
              <rect
                key={`tn${k}`}
                x={pr.x}
                y={pr.y}
                width={pr.w}
                height={pr.d}
                fill={mark.tint}
                fillOpacity={mark.tintOpacity}
              />
            ))}
          {hatchId &&
            zone.rects.map((pr, k) => (
              <rect
                key={`h${k}`}
                x={pr.x}
                y={pr.y}
                width={pr.w}
                height={pr.d}
                fill={`url(#${idPrefix}-hatch-${hatchId})`}
              />
            ))}
          {focus &&
            zone.rects.map((pr, k) => (
              <rect
                key={`fc${k}`}
                x={pr.x}
                y={pr.y}
                width={pr.w}
                height={pr.d}
                fill={focus}
                fillOpacity={selected ? 0.2 : 0.1}
                data-testid={selected && k === 0 ? `ems-zone-selected-${zone.id}` : undefined}
              />
            ))}
          {!multi && (mark.outline || focus) && (
            <rect
              x={r.x + 0.04}
              y={r.y + 0.04}
              width={r.w - 0.08}
              height={r.d - 0.08}
              fill="none"
              stroke={focus ?? mark.outline}
              strokeWidth={focus ? (selected ? 3 : 2) : mark.outlineWidth}
              strokeDasharray={focus && !selected ? '6 4' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      </g>
      {multi &&
        (mark.outline || focus) &&
        outline.map((e, k) => {
          const a = toScreen(e.a.x, e.a.y, zf, iso, dy);
          const b = toScreen(e.b.x, e.b.y, zf, iso, dy);
          return (
            <line
              key={`ol${k}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={focus ?? mark.outline}
              strokeWidth={focus ? (selected ? 3 : 2) : mark.outlineWidth}
              strokeDasharray={focus && !selected ? '6 4' : undefined}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          );
        })}
      {edges
        .filter((e) => e.back)
        .sort((a, b) => b.p.depth - a.p.depth)
        .map(wall)}
      <g pointerEvents="none" opacity={detail}>
        {objs.map((o) => o.el)}
      </g>
      <g pointerEvents="none" opacity={0.88}>
        {cassettes}
        {air}
      </g>
      <g pointerEvents="none">
        {edges
          .filter((e) => !e.back)
          .sort((a, b) => b.p.depth - a.p.depth)
          .map(wall)}
      </g>
    </>
  );
};
