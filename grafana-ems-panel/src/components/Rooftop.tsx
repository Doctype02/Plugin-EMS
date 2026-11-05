import React from 'react';
import { colorManipulator } from '@grafana/data';
import { Rect } from 'building/model';
import { IsoConfig, path, planeMatrix, prism } from 'building/iso';
import { Snapshot } from 'building/telemetry';

interface Props {
  units: Array<{ zoneId: string; rect: Rect }>;
  z: number;
  dy: number;
  height: number;
  iso: IsoConfig;
  snapshot: Snapshot;
  animate: boolean;
  dark: boolean;
  labelColor: string;
}

const shade = (c: string, a: number) => colorManipulator.darken(c, a);

/** Unidades condensadoras: azul = compresor enfriando (ventilador girando), naranja = en espera por DR. */
export const Rooftop: React.FC<Props> = ({ units, z, dy, height, iso, snapshot, animate, dark, labelColor }) => (
  <>
    {units
      .map((u) => ({ u, p: prism(u.rect, z, height, iso, 0, dy) }))
      .sort((a, b) => b.p.depth - a.p.depth)
      .map(({ u, p }) => {
        const s = snapshot.zones[u.zoneId];
        const on = !!s?.hvacOn;
        const c = s?.drForced ? '#eb6834' : on ? '#2a78d6' : dark ? '#55554f' : '#b9b7af';
        const cx = u.rect.x + u.rect.w / 2;
        const cy = u.rect.y + u.rect.d / 2;
        const rad = Math.min(u.rect.w, u.rect.d) * 0.36;
        const blades = [0, 120, 240].map((a) => (
          <path
            key={a}
            d={`M${cx} ${cy} q ${rad * 0.55} ${-rad * 0.25} ${rad * 0.95} 0 q ${-rad * 0.4} ${rad * 0.3} ${-rad * 0.95} 0Z`}
            transform={`rotate(${a} ${cx} ${cy})`}
            fill={shade(c, 0.55)}
          />
        ));
        return (
          <g key={u.zoneId} data-testid={`ems-roof-${u.zoneId}`} data-on={on ? 'si' : 'no'}>
            {p.sides.map((sd, i) => (
              <path key={i} d={path(sd.points)} fill={shade(c, 0.15 + i * 0.12)} />
            ))}
            <path d={path(p.top)} fill={c} stroke={shade(c, 0.3)} strokeWidth={0.5} />
            <g transform={planeMatrix(z + height + 0.01, iso, dy)}>
              <circle cx={cx} cy={cy} r={rad * 1.08} fill={shade(c, 0.3)} />
              <g>
                {blades}
                {animate && on && (
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from={`0 ${cx} ${cy}`}
                    to={`360 ${cx} ${cy}`}
                    dur="0.8s"
                    repeatCount="indefinite"
                  />
                )}
              </g>
              <circle cx={cx} cy={cy} r={rad * 0.15} fill={shade(c, 0.7)} />
            </g>
            <text x={p.center.x} y={p.center.y - iso.scale * 1.3} textAnchor="middle" fontSize={8} fill={labelColor}>
              {u.zoneId}
            </text>
          </g>
        );
      })}
  </>
);
