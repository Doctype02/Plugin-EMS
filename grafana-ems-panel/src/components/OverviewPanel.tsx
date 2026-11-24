import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import { PV, TARIFF, ZONES } from 'building/model';
import { Snapshot, Status } from 'building/telemetry';
import { dayPeriod, localParts } from 'building/clock';
import { MiniChart } from './MiniChart';
import { DemandGauge } from './DemandGauge';
import { EnergyFlow } from './EnergyFlow';

interface Props {
  snapshot: Snapshot;
  statuses: Record<string, Status>;
  statusColors: Record<Status, string>;
  limitKw: number;
  /** Curva de potencia del día (t, kW) en pasos de 15 min. */
  dayCurve: Array<[number, number]>;
  /** Generación FV del día (t, kW), sólo en la variante con fotovoltaica. */
  pvCurve?: Array<[number, number]>;
  now: number;
  onSelectZone: (id: string) => void;
  /** Detalle del medidor eléctrico (P, Q, S, FP, V, I). */
  meter?: React.ReactNode;
}

/** Factor de emisión del SIN de Panamá (supuesto documentado en config/edificio.yaml). */
const CO2_KG_KWH = TARIFF.co2KgKwh;

const STATUS_TEXT: Record<Status, string> = {
  ok: 'Normal',
  warning: 'Alerta',
  critical: 'Crítico',
  offline: 'Sin datos',
};

/** Pestaña Resumen: estado general, demanda del día, energía, desglose de cargas y tabla de zonas. */
export const OverviewPanel: React.FC<Props> = ({
  snapshot,
  statuses,
  statusColors,
  limitKw,
  dayCurve,
  pvCurve,
  now,
  onSelectZone,
  meter,
}) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const m = snapshot.meter;
  const p = localParts(now);
  const crit = snapshot.alarms.filter((a) => a.level === 'crit').length;
  const warn = snapshot.alarms.filter((a) => a.level === 'warn').length;
  const overall: Status = crit ? 'critical' : warn ? 'warning' : 'ok';
  const past = dayCurve.filter(([t]) => t <= now);
  const future = dayCurve.filter(([t]) => t >= now - 15 * 60_000);
  const peak = past.length ? Math.max(...past.map(([, v]) => v)) : 0;
  const parts = m
    ? [
        { k: 'HVAC', v: m.pHvac, c: theme.visualization.getColorByName('blue') },
        { k: 'Iluminación', v: m.pLights, c: theme.visualization.getColorByName('yellow') },
        { k: 'Equipos', v: m.pPlugs, c: theme.visualization.getColorByName('purple') },
        { k: 'Fijas', v: m.pFixed, c: theme.visualization.getColorByName('orange') },
      ]
    : [];
  const total = parts.reduce((a, x) => a + x.v, 0) || 1;
  const hourFmt = (t: number) => `${Math.round((t - p.dayStart) / 3_600_000)}h`;
  const hasPv = m?.pPv !== undefined;
  // energía comprada a la red: consumo menos lo generado (la FV inyectada se paga a precio de excedente)
  const eNet = m ? m.eKwh - (m.ePv ?? 0) : 0;
  const pvShare = m && hasPv && m.pTotal > 0 ? Math.min(1, (m.pPv ?? 0) / m.pTotal) : 0;
  const pvSeries = pvCurve?.length
    ? [
        {
          name: 'FV',
          color: theme.visualization.getColorByName('green'),
          points: pvCurve.filter(([t]) => t <= now),
        },
      ]
    : [];

  return (
    <div className={styles.box} data-testid="ems-overview">
      <section
        className={styles.hero}
        style={{ borderLeftColor: statusColors[overall] }}
        data-testid="ems-overview-hero"
      >
        <div className={styles.heroHead}>
          <span className={styles.heroDot} style={{ background: statusColors[overall] }} />
          <div className={styles.heroTitle}>
            {overall === 'ok'
              ? 'Operación normal'
              : overall === 'warning'
                ? `${warn} alerta${warn > 1 ? 's' : ''} activa${warn > 1 ? 's' : ''}`
                : `${crit} alarma${crit > 1 ? 's' : ''} crítica${crit > 1 ? 's' : ''}`}
          </div>
          <div className={styles.muted}>{dayPeriod(p.hour, p.dow)}</div>
        </div>
        <DemandGauge meter={m} ems={snapshot.ems} limit={snapshot.ems?.limitKw || limitKw} pv={hasPv} />
      </section>

      {m && (
        <section className={styles.card} data-testid="ems-overview-energy">
          <div className={styles.cardHead}>
            <span>Fuentes de energía</span>
          </div>
          <EnergyFlow meter={m} pv={hasPv} />
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <span>Demanda del día</span>
          <span className={styles.muted}>
            pico {peak.toFixed(1)} kW · límite {limitKw} kW
          </span>
        </div>
        <MiniChart
          height={130}
          area
          series={[
            { name: 'Medido', color: theme.visualization.getColorByName('blue'), points: past },
            { name: 'Previsto', color: theme.colors.text.secondary, points: future, dashed: true },
            ...pvSeries,
          ]}
          rules={[{ y: limitKw, label: `${limitKw} kW`, color: theme.colors.warning.text }]}
          marker={{ x: now, label: 'ahora' }}
          xDomain={[p.dayStart, p.dayStart + 86_400_000]}
          xTicks={[0, 6, 12, 18, 24].map((h) => p.dayStart + h * 3_600_000)}
          xLabel={hourFmt}
          yUnit="kW"
        />
      </section>

      <div className={styles.stats}>
        <Stat label="Energía hoy" value={m ? `${m.eKwh.toFixed(0)} kWh` : '—'} />
        <Stat label="Costo hoy" value={m ? `${(Math.max(eNet, 0) * m.price).toFixed(0)} USD` : '—'} />
        <Stat label="CO₂ hoy" value={m ? `${((Math.max(eNet, 0) * CO2_KG_KWH) / 1000).toFixed(2)} t` : '—'} />
        <Stat
          label="Pico de hoy"
          value={`${peak.toFixed(1)} kW`}
          accent={peak > limitKw ? statusColors.critical : undefined}
        />
      </div>

      {m && hasPv && (
        <section className={styles.card} data-testid="ems-overview-pv">
          <div className={styles.cardHead}>
            <span>Fotovoltaica</span>
            <span className={styles.muted}>
              {PV.areaM2.toFixed(0)} m² · pico ≈ {PV.peakKw.toFixed(0)} kW
            </span>
          </div>
          <div className={styles.stack}>
            <div
              style={{ width: `${pvShare * 100}%`, background: theme.visualization.getColorByName('green') }}
              title={`FV: ${(m.pPv ?? 0).toFixed(1)} kW`}
            />
            <div
              style={{ width: `${(1 - pvShare) * 100}%`, background: theme.visualization.getColorByName('blue') }}
              title={`Red: ${Math.max(m.pGrid ?? 0, 0).toFixed(1)} kW`}
            />
          </div>
          <div className={styles.stats}>
            <Stat label="Generación" value={`${(m.pPv ?? 0).toFixed(1)} kW`} />
            <Stat
              label={(m.pGrid ?? 0) < 0 ? 'Exportación' : 'Red (neta)'}
              value={`${Math.abs(m.pGrid ?? 0).toFixed(1)} kW`}
              accent={(m.pGrid ?? 0) < 0 ? theme.visualization.getColorByName('green') : undefined}
            />
            <Stat label="FV hoy" value={`${(m.ePv ?? 0).toFixed(0)} kWh`} />
            <Stat label="Cubre" value={`${Math.round(pvShare * 100)} %`} />
          </div>
        </section>
      )}

      {m && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span>Desglose de la carga</span>
            <span className={styles.muted}>
              FP {m.pf.toFixed(2)} · {m.tExt.toFixed(1)} °C ext.
            </span>
          </div>
          <div className={styles.stack}>
            {parts.map((x) => (
              <div
                key={x.k}
                style={{ width: `${(x.v / total) * 100}%`, background: x.c }}
                title={`${x.k}: ${x.v.toFixed(1)} kW`}
              />
            ))}
          </div>
          <div className={styles.legend}>
            {parts.map((x) => (
              <span key={x.k}>
                <i style={{ background: x.c }} />
                {x.k} <b>{x.v.toFixed(1)}</b> kW · {Math.round((x.v / total) * 100)} %
              </span>
            ))}
          </div>
        </section>
      )}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <span>Zonas</span>
          <span className={styles.muted}>clic para el detalle</span>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th>Zona</th>
              <th>T °C</th>
              <th>Pers.</th>
              <th>kW</th>
            </tr>
          </thead>
          <tbody>
            {ZONES.map((z) => {
              const s = snapshot.zones[z.id];
              const st = statuses[z.id] ?? 'offline';
              return (
                <tr key={z.id} onClick={() => onSelectZone(z.id)} data-testid={`ems-overview-row-${z.id}`}>
                  <td>
                    <span className={styles.dot} style={{ background: statusColors[st] }} title={STATUS_TEXT[st]} />
                  </td>
                  <td className={styles.zname}>
                    <b>{z.id}</b> {z.name}
                  </td>
                  <td className={cx(st !== 'ok' && styles.hot)}>{s ? s.temp.toFixed(1) : '—'}</td>
                  <td>{s ? (z.occupants ? `${s.occupants}/${z.occupants}` : '—') : '—'}</td>
                  <td>{s ? s.pTotal.toFixed(1) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {meter && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span>Medidor general</span>
          </div>
          {meter}
        </section>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue} style={accent ? { color: accent } : undefined}>
        {value}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  box: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
  `,
  hero: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.25, 1.5)};
    border: 1px solid ${theme.colors.border.weak};
    border-left: 4px solid;
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  heroHead: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    flex-wrap: wrap;
    & > :last-child {
      margin-left: auto;
    }
  `,
  heroDot: css`
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  `,
  heroTitle: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.75)};
    padding: ${theme.spacing(1.25)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  cardHead: css`
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: ${theme.typography.h6.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    gap: ${theme.spacing(1)};
  `,
  stats: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: ${theme.spacing(0.75)};
  `,
  stat: css`
    padding: ${theme.spacing(0.75, 1)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
  `,
  statLabel: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
  statValue: css`
    font-size: ${theme.typography.h5.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    font-variant-numeric: tabular-nums;
  `,
  stack: css`
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: ${theme.colors.border.weak};
    div {
      height: 100%;
    }
  `,
  legend: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    b {
      color: ${theme.colors.text.primary};
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      margin-right: 6px;
    }
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    th {
      text-align: right;
      font-weight: ${theme.typography.fontWeightRegular};
      font-size: 11px;
      color: ${theme.colors.text.secondary};
      padding: 2px 4px;
      border-bottom: 1px solid ${theme.colors.border.weak};
    }
    th:nth-child(2) {
      text-align: left;
    }
    td {
      text-align: right;
      padding: 3px 4px;
      border-bottom: 1px solid ${colorManipulator.alpha(theme.colors.border.weak, 0.5)};
    }
    tbody tr {
      cursor: pointer;
    }
    tbody tr:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  zname: css`
    text-align: left !important;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 150px;
    b {
      font-weight: 500;
      margin-right: 4px;
    }
  `,
  hot: css`
    color: ${theme.colors.warning.text};
  `,
  dot: css`
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  muted: css`
    font-size: 11px;
    font-weight: ${theme.typography.fontWeightRegular};
    color: ${theme.colors.text.secondary};
  `,
});
