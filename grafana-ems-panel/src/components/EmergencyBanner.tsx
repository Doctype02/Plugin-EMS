import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx, keyframes } from '@emotion/css';
import { Button, useStyles2 } from '@grafana/ui';
import { Snapshot } from 'building/telemetry';
import { EVENTS, SimEvent, describeEvent, isActive } from 'building/events';

interface Props {
  snapshot: Snapshot;
  events: SimEvent[];
  now: number;
  canStop: boolean;
  onShow: () => void;
  onStop: () => void;
}

/** Mensaje principal según la emergencia más grave (incendio > corte > falla de equipo). */
export function emergencyMessage(
  snapshot: Snapshot,
  events: SimEvent[],
  now: number
): { level: 'crit' | 'warn'; glyph: string; title: string; detail: string } | undefined {
  const act = events.filter((e) => isActive(e, now));
  const fire =
    act.find((e) => e.kind === 'incendio') ??
    (snapshot.ems?.fireAlarm ? ({ kind: 'incendio' } as SimEvent) : undefined);
  if (fire) {
    const people = Object.values(snapshot.zones).reduce((a, z) => a + z.occupants, 0);
    return {
      level: 'crit',
      glyph: '🔥',
      title: `INCENDIO${fire.zone ? ` en ${fire.zone}` : ''} — evacuación ${people ? `en curso (${people} personas dentro)` : 'completa'}`,
      detail: 'Climatización del edificio detenida para no propagar humo · iluminación de evacuación encendida',
    };
  }
  const m = snapshot.meter;
  if (m && m.gridOk === false) {
    return {
      level: 'crit',
      glyph: '⚡',
      title: 'CORTE DE ENERGÍA — sin tensión en la acometida',
      detail:
        (m.upsMinutes ?? 0) > 0
          ? `Servidores en UPS (${(m.upsKw ?? 0).toFixed(1)} kW) · autonomía ≈ ${(m.upsMinutes ?? 0).toFixed(0)} min · cuarto de servidores sin climatización`
          : 'UPS agotado: servidores fuera de servicio',
    };
  }
  const crit = act.filter((e) => EVENTS[e.kind].level === 'crit');
  if (crit.length) {
    return {
      level: 'crit',
      glyph: EVENTS[crit[0].kind].glyph,
      title: describeEvent(crit[0]),
      detail: crit.length > 1 ? `y ${crit.length - 1} evento(s) más` : EVENTS[crit[0].kind].description,
    };
  }
  if (act.length) {
    return {
      level: 'warn',
      glyph: EVENTS[act[0].kind].glyph,
      title: `Simulación: ${describeEvent(act[0])}`,
      detail: act.length > 1 ? `y ${act.length - 1} evento(s) más` : EVENTS[act[0].kind].description,
    };
  }
  return undefined;
}

export const EmergencyBanner: React.FC<Props> = ({ snapshot, events, now, canStop, onShow, onStop }) => {
  const styles = useStyles2(getStyles);
  const msg = emergencyMessage(snapshot, events, now);
  if (!msg) {
    return null;
  }
  return (
    <div
      className={cx(styles.banner, msg.level === 'crit' ? styles.crit : styles.warn)}
      role="alert"
      data-testid="ems-emergency"
    >
      <span className={styles.glyph}>{msg.glyph}</span>
      <div className={styles.text}>
        <div className={styles.title}>{msg.title}</div>
        <div className={styles.detail}>{msg.detail}</div>
      </div>
      <Button size="sm" variant="secondary" onClick={onShow}>
        Detalles
      </Button>
      {canStop && events.some((e) => isActive(e, now)) && (
        <Button size="sm" variant="secondary" icon="times" onClick={onStop}>
          Terminar
        </Button>
      )}
    </div>
  );
};

const pulse = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 rgba(224, 47, 68, 0.0); }
  50% { box-shadow: 0 0 0 4px rgba(224, 47, 68, 0.35); }
`;

const getStyles = (theme: GrafanaTheme2) => ({
  banner: css`
    position: absolute;
    left: 50%;
    top: ${theme.spacing(6)};
    transform: translateX(-50%);
    width: min(620px, calc(100% - ${theme.spacing(2)}));
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75, 1)};
    border-radius: ${theme.shape.radius.default};
    border: 1px solid;
    box-shadow: ${theme.shadows.z3};
    z-index: 4;
  `,
  crit: css`
    background: ${theme.isDark ? '#3b1016' : '#fde8ea'};
    border-color: ${theme.colors.error.border};
    @media (prefers-reduced-motion: no-preference) {
      animation: ${pulse} 1.6s ease-in-out infinite;
    }
  `,
  warn: css`
    background: ${theme.isDark ? colorManipulator.darken(theme.colors.warning.main, 0.7) : '#fff4dc'};
    border-color: ${theme.colors.warning.border};
  `,
  glyph: css`
    font-size: 22px;
  `,
  text: css`
    flex: 1;
    min-width: 0;
  `,
  title: css`
    font-weight: ${theme.typography.fontWeightBold};
    font-size: ${theme.typography.body.fontSize};
  `,
  detail: css`
    font-size: 11px;
    color: ${theme.colors.text.secondary};
  `,
});
