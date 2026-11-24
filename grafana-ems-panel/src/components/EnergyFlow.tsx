/**
 * Diagrama de flujo de energía (unifilar simplificado): las tres fuentes —red, planta de respaldo y paneles
 * solares— llegan al tablero del edificio a través de la transferencia automática; el UPS alimenta los
 * servidores. Las líneas activas se colorean y muestran la potencia; en un corte la red se apaga y la planta
 * toma la carga.
 */
import React from 'react';
import { useTheme2 } from '@grafana/ui';
import { BACKUP } from 'building/model';
import { MeterState } from 'building/telemetry';

interface Props {
  meter?: MeterState;
  pv: boolean;
}

const C = { grid: '#A352CC', gen: '#FF780A', pv: '#E8B10C', ups: '#5794F2', load: '#73BF69' };

export const EnergyFlow: React.FC<Props> = ({ meter: m, pv }) => {
  const theme = useTheme2();
  if (!m || !BACKUP.enabled) {
    return null;
  }
  const off = theme.colors.border.medium;
  const ink = theme.colors.text.primary;
  const ink2 = theme.colors.text.secondary;
  const bg = theme.colors.background.primary;
  const mode = m.powerMode ?? (m.gridOk === false ? 'ups' : 'red');
  const gridKw = mode === 'red' ? Math.max(m.pGrid ?? m.pTotal, 0) : 0;
  const genKw = m.pGen ?? 0;
  const pvKw = m.pPv ?? 0;
  const dark = mode === 'ups' || mode === 'sin_energia';
  const kw = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} kW`;
  const fuel = Math.max(0, Math.min(100, m.genFuelPct ?? 100));

  const node = (x: number, y: number, label: string, value: string, color: string, on: boolean, extra?: React.ReactNode) => (
    <g transform={`translate(${x} ${y})`}>
      <rect width={86} height={40} rx={6} fill={bg} stroke={on ? color : off} strokeWidth={on ? 1.6 : 1} />
      <circle cx={10} cy={12} r={3.5} fill={on ? color : off} />
      <text x={18} y={15.5} fontSize={10} fill={ink2}>
        {label}
      </text>
      <text x={8} y={32} fontSize={12.5} fontWeight={600} fill={on ? ink : ink2}>
        {value}
      </text>
      {extra}
    </g>
  );
  const wire = (d: string, color: string, on: boolean) => (
    <path d={d} fill="none" stroke={on ? color : off} strokeWidth={on ? 2.2 : 1.2} strokeDasharray={on ? undefined : '3 3'} />
  );

  return (
    <svg viewBox="0 0 300 168" width="100%" role="img" aria-label="Flujo de energía del edificio" data-testid="ems-energy-flow">
      {/* fuentes → transferencia / tablero */}
      {wire('M92,24 H128 V70 H150', C.grid, gridKw > 0.05)}
      {wire('M92,84 H150', C.gen, genKw > 0.05)}
      {pv && wire('M92,144 H128 V98 H150', C.pv, pvKw > 0.05)}
      {wire('M190,84 H212', C.load, !dark && m.pTotal > 0.05)}
      {wire('M252,104 V122', C.ups, (m.upsKw ?? m.pCritical ?? 0) > 0.05 && mode !== 'sin_energia')}

      {node(6, 4, 'Red eléctrica', mode === 'red' ? kw(gridKw) : 'Sin tensión', C.grid, gridKw > 0.05)}
      {node(
        6,
        64,
        'Planta de respaldo',
        mode === 'generador' ? kw(genKw) : mode === 'red' ? 'En espera' : 'Sin servicio',
        C.gen,
        genKw > 0.05,
        // nivel de diésel
        <g transform="translate(70 8)">
          <rect width={8} height={24} rx={2} fill="none" stroke={off} />
          <rect x={1} y={1 + (22 * (100 - fuel)) / 100} width={6} height={(22 * fuel) / 100} rx={1} fill={fuel < 20 ? '#F2495C' : '#C9A227'} />
        </g>
      )}
      {pv && node(6, 124, 'Paneles solares', kw(pvKw), C.pv, pvKw > 0.05)}

      {/* transferencia automática */}
      <g transform="translate(150 62)">
        <rect width={40} height={44} rx={6} fill={bg} stroke={mode === 'generador' ? C.gen : mode === 'red' ? C.grid : off} strokeWidth={1.4} />
        <text x={20} y={19} fontSize={9} textAnchor="middle" fill={ink2}>
          Transf.
        </text>
        <text x={20} y={33} fontSize={10.5} fontWeight={700} textAnchor="middle" fill={ink}>
          {mode === 'generador' ? 'Planta' : mode === 'red' ? 'Red' : '—'}
        </text>
      </g>

      {node(212, 64, 'Edificio', dark ? '0 kW' : kw(m.pTotal), C.load, !dark && m.pTotal > 0.05)}
      {node(
        212,
        122,
        'UPS servidores',
        mode === 'sin_energia' ? 'Agotado' : mode === 'ups' ? `${(m.upsMinutes ?? 0).toFixed(0)} min` : 'En línea',
        C.ups,
        mode !== 'sin_energia'
      )}
    </svg>
  );
};
