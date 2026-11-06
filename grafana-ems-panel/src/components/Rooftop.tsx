import React from 'react';
import { colorManipulator } from '@grafana/data';
import { VrfUnit } from 'building/model';
import { IsoConfig, path, planeMatrix, prism } from 'building/iso';
import { Snapshot } from 'building/telemetry';

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
  /** Vista exterior: rótulo corto para no encimar etiquetas. */
  compact?: boolean;
}

const shade = (c: string, a: number) => colorManipulator.darken(c, a);

/** Unidades exteriores VRF: azul = alguna zona servida enfriando (ventiladores girando),
 * naranja = alguna zona con el compresor en espera por el limitador de demanda. */
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
  compact,
}) => (
  <>
    {units
      .map((u) => ({ u, p: prism(u.rect, z, height, iso, 0, dy) }))
      .sort((a, b) => b.p.depth - a.p.depth)
      .map(({ u, p }) => {
        const served = u.zones.map((id) => snapshot.zones[id]).filter(Boolean);
        const on = served.some((s) => s.hvacOn);
        const forced = served.some((s) => s.drForced);
        const kw = served.reduce((a, s) => a + (s.hvacOn ? s.pHvac : 0), 0);
        const c = forced ? '#eb6834' : on ? '#2a78d6' : dark ? '#55554f' : '#b9b7af';
        const nFans = u.capacityKw > 10 ? 2 : 1;
        const long = u.rect.w >= u.rect.d;
        const rad = Math.min(long ? u.rect.w / (2 * nFans) : u.rect.w, long ? u.rect.d : u.rect.d / (2 * nFans)) * 0.4;
        const fans = Array.from({ length: nFans }, (_, i) => {
          const f = (i + 0.5) / nFans;
          return long
            ? { cx: u.rect.x + u.rect.w * f, cy: u.rect.y + u.rect.d / 2 }
            : { cx: u.rect.x + u.rect.w / 2, cy: u.rect.y + u.rect.d * f };
        });
        const speed = Math.max(0.35, 1.2 - kw / 20);
        return (
          <g key={u.id} data-testid={`ems-roof-${u.id}`} data-on={on ? 'si' : 'no'}>
            {p.sides.map((sd, i) => (
              <path key={i} d={path(sd.points)} fill={shade(c, 0.15 + i * 0.12)} />
            ))}
            <path d={path(p.top)} fill={c} stroke={shade(c, 0.3)} strokeWidth={0.5} />
            <g transform={planeMatrix(z + height + 0.01, iso, dy)}>
              {fans.map(({ cx, cy }, i) => (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={rad * 1.1} fill={shade(c, 0.3)} />
                  <g>
                    {[0, 120, 240].map((a) => (
                      <path
                        key={a}
                        d={`M${cx} ${cy} q ${rad * 0.55} ${-rad * 0.25} ${rad * 0.95} 0 q ${-rad * 0.4} ${rad * 0.3} ${-rad * 0.95} 0Z`}
                        transform={`rotate(${a} ${cx} ${cy})`}
                        fill={shade(c, 0.55)}
                      />
                    ))}
                    {animate && on && (
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
                  <circle cx={cx} cy={cy} r={rad * 0.15} fill={shade(c, 0.7)} />
                </g>
              ))}
            </g>
            <text
              x={p.center.x}
              y={p.center.y - iso.scale * 1.6}
              textAnchor="middle"
              fontSize={9}
              fontWeight={600}
              fill={labelColor}
            >
              {compact ? u.id : `${u.id} · ${u.capacityKw.toFixed(1)} kW`}
            </text>
            {!compact && (
              <text
                x={p.center.x}
                y={p.center.y - iso.scale * 1.6 + 10}
                textAnchor="middle"
                fontSize={8}
                fill={labelColor}
              >
                {u.zones.join(' ')}
              </text>
            )}
          </g>
        );
      })}
  </>
);
