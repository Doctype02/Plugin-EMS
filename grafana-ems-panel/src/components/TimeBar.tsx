import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { IconButton, RadioButtonGroup, Tooltip, useStyles2 } from '@grafana/ui';
import { ClockState, SPEEDS, WEEKDAYS, atHour, atWeekday, dayPeriod, formatClock, localParts } from 'building/clock';

interface Props {
  now: number;
  clock?: ClockState;
  live: boolean;
  compact: boolean;
  onTime: (t: number) => void;
  onSpeed: (speed: number) => void;
  onTogglePlay: () => void;
  onLive: () => void;
}

/** Bandas del día en la escala de 24 h (noche, jornada, punta). */
const BANDS = [
  { from: 0, to: 6, kind: 'night' },
  { from: 6, to: 8, kind: 'dawn' },
  { from: 8, to: 9, kind: 'work' },
  { from: 9, to: 17, kind: 'peak' },
  { from: 17, to: 18, kind: 'work' },
  { from: 18, to: 20, kind: 'dawn' },
  { from: 20, to: 24, kind: 'night' },
] as const;

/** Barra de tiempo: reproducir/pausar, velocidad, día de la semana y hora del día. */
export const TimeBar: React.FC<Props> = ({ now, clock, live, compact, onTime, onSpeed, onTogglePlay, onLive }) => {
  const styles = useStyles2(getStyles);
  const parts = localParts(now);
  const f = formatClock(now);
  const realTime =
    !!clock && clock.playing && clock.speed === 1 && Math.abs(clock.anchorSim - clock.anchorReal) < 90_000;

  if (live) {
    return (
      <div className={styles.bar} data-testid="ems-timebar">
        <span className={cx(styles.dot, styles.dotLive)} />
        <span className={styles.liveText}>En vivo · datos del edificio</span>
        <span className={styles.clock}>
          {f.time}
          <span className={styles.day}>
            {f.day} {f.date}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className={cx(styles.bar, compact && styles.wrap)} data-testid="ems-timebar">
      <div className={styles.group}>
        <IconButton
          name={clock?.playing ? 'pause' : 'play'}
          size="lg"
          tooltip={clock?.playing ? 'Pausar el tiempo' : 'Reanudar el tiempo'}
          onClick={onTogglePlay}
          data-testid="ems-time-play"
        />
        <span className={styles.clock} data-testid="ems-time-label">
          {f.time}
          <span className={styles.day}>
            {f.day} {f.date}
          </span>
        </span>
      </div>

      <div className={styles.group}>
        <RadioButtonGroup
          size="sm"
          value={clock?.speed}
          onChange={onSpeed}
          options={SPEEDS.map((s) => ({ value: s.value, label: s.label, description: s.hint }))}
        />
      </div>

      <div className={styles.days} role="group" aria-label="Día de la semana">
        {WEEKDAYS.map((d, i) => (
          <button
            key={d}
            type="button"
            className={cx(styles.chip, i === parts.dow && styles.chipOn, i >= 5 && styles.chipWeekend)}
            onClick={() => onTime(atWeekday(now, i))}
            aria-pressed={i === parts.dow}
          >
            {d}
          </button>
        ))}
      </div>

      <div className={styles.sliderBox}>
        <div className={styles.track}>
          {BANDS.map((b) => (
            <div
              key={b.from}
              className={cx(styles.band, styles[b.kind])}
              style={{ left: `${(b.from / 24) * 100}%`, width: `${((b.to - b.from) / 24) * 100}%` }}
            />
          ))}
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h} className={styles.tick} style={{ left: `${(h / 24) * 100}%` }}>
              {h}
            </span>
          ))}
        </div>
        <input
          type="range"
          className={styles.range}
          min={0}
          max={24 * 60 - 1}
          step={5}
          value={Math.round(parts.hour * 60)}
          onChange={(e) => onTime(atHour(now, Number(e.currentTarget.value) / 60))}
          aria-label="Hora del día"
          data-testid="ems-time-slider"
        />
        <div className={styles.period}>{dayPeriod(parts.hour, parts.dow)}</div>
      </div>

      <Tooltip content="Volver a la hora real de Panamá">
        <button type="button" className={cx(styles.now, realTime && styles.nowOn)} onClick={onLive}>
          <span className={cx(styles.dot, realTime && styles.dotLive)} />
          Ahora
        </button>
      </Tooltip>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const night = theme.isDark ? '#1b2340' : '#c9d3ee';
  const dawn = theme.isDark ? '#4b3f6b' : '#e8dcf2';
  const work = theme.isDark ? '#3d5a73' : '#d7ecf7';
  const peak = theme.isDark ? '#7a5a1e' : '#fbe3b0';
  return {
    bar: css`
      display: flex;
      align-items: center;
      gap: ${theme.spacing(1.5)};
      padding: ${theme.spacing(0.5, 1)};
      margin-bottom: ${theme.spacing(1)};
      border: 1px solid ${theme.colors.border.weak};
      border-radius: ${theme.shape.radius.default};
      background: ${theme.colors.background.primary};
    `,
    wrap: css`
      flex-wrap: wrap;
      row-gap: ${theme.spacing(0.5)};
    `,
    group: css`
      display: flex;
      align-items: center;
      gap: ${theme.spacing(0.5)};
    `,
    clock: css`
      display: flex;
      align-items: baseline;
      gap: ${theme.spacing(0.75)};
      font-size: ${theme.typography.h4.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      font-variant-numeric: tabular-nums;
      min-width: 150px;
    `,
    day: css`
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightRegular};
      color: ${theme.colors.text.secondary};
    `,
    days: css`
      display: flex;
      gap: 2px;
    `,
    chip: css`
      border: 1px solid ${theme.colors.border.weak};
      background: transparent;
      color: ${theme.colors.text.secondary};
      border-radius: ${theme.shape.radius.default};
      padding: 0 ${theme.spacing(0.75)};
      height: 24px;
      font-size: ${theme.typography.bodySmall.fontSize};
      cursor: pointer;
      &:hover {
        color: ${theme.colors.text.primary};
        border-color: ${theme.colors.border.strong};
      }
    `,
    chipWeekend: css`
      font-style: italic;
    `,
    chipOn: css`
      background: ${theme.colors.primary.main};
      border-color: ${theme.colors.primary.main};
      color: ${theme.colors.primary.contrastText};
      &:hover {
        color: ${theme.colors.primary.contrastText};
      }
    `,
    sliderBox: css`
      position: relative;
      flex: 1;
      min-width: 220px;
      height: 40px;
    `,
    track: css`
      position: absolute;
      left: 0;
      right: 0;
      top: 8px;
      height: 10px;
      border-radius: 5px;
      overflow: visible;
    `,
    band: css`
      position: absolute;
      top: 0;
      bottom: 0;
      &:first-of-type {
        border-radius: 5px 0 0 5px;
      }
    `,
    night: css`
      background: ${night};
    `,
    dawn: css`
      background: ${dawn};
    `,
    work: css`
      background: ${work};
    `,
    peak: css`
      background: ${peak};
    `,
    tick: css`
      position: absolute;
      top: 12px;
      transform: translateX(-50%);
      font-size: 10px;
      color: ${theme.colors.text.disabled};
      pointer-events: none;
    `,
    range: css`
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      width: 100%;
      height: 26px;
      margin: 0;
      background: transparent;
      appearance: none;
      cursor: pointer;
      &::-webkit-slider-runnable-track {
        background: transparent;
        height: 26px;
      }
      &::-moz-range-track {
        background: transparent;
      }
      &::-webkit-slider-thumb {
        appearance: none;
        width: 6px;
        height: 22px;
        margin-top: 2px;
        border-radius: 3px;
        background: ${theme.colors.primary.main};
        box-shadow:
          0 0 0 2px ${theme.colors.background.primary},
          ${theme.shadows.z2};
      }
      &::-moz-range-thumb {
        width: 6px;
        height: 22px;
        border: none;
        border-radius: 3px;
        background: ${theme.colors.primary.main};
      }
      &:focus-visible {
        outline: 2px solid ${colorManipulator.alpha(theme.colors.primary.main, 0.5)};
      }
    `,
    period: css`
      position: absolute;
      right: 0;
      bottom: 0;
      font-size: 10px;
      color: ${theme.colors.text.secondary};
      white-space: nowrap;
    `,
    now: css`
      display: flex;
      align-items: center;
      gap: ${theme.spacing(0.5)};
      height: 24px;
      padding: 0 ${theme.spacing(1)};
      border: 1px solid ${theme.colors.border.medium};
      border-radius: ${theme.shape.radius.pill};
      background: transparent;
      color: ${theme.colors.text.primary};
      font-size: ${theme.typography.bodySmall.fontSize};
      cursor: pointer;
    `,
    nowOn: css`
      border-color: ${theme.colors.success.border};
      color: ${theme.colors.success.text};
    `,
    dot: css`
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${theme.colors.text.disabled};
    `,
    dotLive: css`
      background: ${theme.colors.success.main};
      box-shadow: 0 0 0 3px ${colorManipulator.alpha(theme.colors.success.main, 0.25)};
    `,
    liveText: css`
      color: ${theme.colors.success.text};
      font-size: ${theme.typography.bodySmall.fontSize};
      flex: 1;
    `,
  };
};
