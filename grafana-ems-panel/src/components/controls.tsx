import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css, cx } from '@emotion/css';
import { Button, Icon, IconButton, Input, Spinner, useStyles2 } from '@grafana/ui';
import { SendFeedback } from 'building/control';

/** Formatea un número con los decimales del paso (24 → «24», 24.5 → «24.5»). */
export const fmtStep = (v: number, step: number) => (Number.isFinite(v) ? v.toFixed(step < 1 ? 1 : 0) : '—');

interface NumberParamProps {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** Valor vigente en el EMS: si difiere se muestra «actual → nuevo». */
  current?: number;
  note?: React.ReactNode;
  disabled?: boolean;
  testId?: string;
}

/**
 * Parámetro numérico con deslizador, campo editable y botones ±. El campo acepta cualquier número; fuera de rango
 * se marca en rojo con el motivo (el que llama decide si deshabilita «Aplicar»).
 */
export const NumberParam: React.FC<NumberParamProps> = ({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
  current,
  note,
  disabled,
  testId,
}) => {
  const styles = useStyles2(getStyles);
  const valid = Number.isFinite(value) && value >= min && value <= max;
  const shown = valid ? value : Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const changed = current !== undefined && valid && Math.abs(current - value) > 1e-9;
  const id = `ems-param-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const bump = (dir: 1 | -1) => onChange(Math.min(max, Math.max(min, +(shown + dir * step).toFixed(2))));
  return (
    <div className={styles.param} data-testid={testId}>
      <div className={styles.head}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        <div className={styles.inputBox}>
          <Input
            id={id}
            type="number"
            width={11}
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ''}
            invalid={!valid}
            disabled={disabled}
            suffix={unit}
            className={styles.input}
            onChange={(e) => {
              const raw = e.currentTarget.value;
              onChange(raw === '' ? NaN : Number(raw));
            }}
            data-testid={testId ? `${testId}-input` : undefined}
          />
        </div>
      </div>
      <div className={styles.sliderRow}>
        <IconButton
          name="minus"
          size="md"
          aria-label={`Bajar ${label}`}
          disabled={disabled || shown <= min}
          onClick={() => bump(-1)}
        />
        <input
          type="range"
          className={styles.range}
          min={min}
          max={max}
          step={step}
          value={shown}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
        <IconButton
          name="plus"
          size="md"
          aria-label={`Subir ${label}`}
          disabled={disabled || shown >= max}
          onClick={() => bump(1)}
        />
      </div>
      <div className={styles.scale}>
        <span>
          {fmtStep(min, step)} {unit}
        </span>
        {changed && (
          <span className={styles.diff}>
            actual {fmtStep(current!, step)} → <b>{fmtStep(value, step)}</b> {unit}
          </span>
        )}
        <span>
          {fmtStep(max, step)} {unit}
        </span>
      </div>
      {!valid ? (
        <div className={styles.error} role="alert">
          Fuera de rango: entre {fmtStep(min, step)} y {fmtStep(max, step)} {unit}
        </div>
      ) : (
        note && <div className={styles.note}>{note}</div>
      )}
    </div>
  );
};

interface ConfirmProps {
  /** Qué va a pasar, en una frase. */
  title: string;
  detail?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

/** Confirmación en línea antes de una acción de impacto (no usa modal: funciona en pantalla completa). */
export const ConfirmInline: React.FC<ConfirmProps> = ({
  title,
  detail,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
  testId,
}) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={cx(styles.confirm, destructive && styles.confirmDanger)} role="alertdialog" data-testid={testId}>
      <div className={styles.confirmText}>
        <Icon name="exclamation-triangle" className={styles.confirmIcon} />
        <div>
          <div className={styles.confirmTitle}>{title}</div>
          {detail && <div className={styles.note}>{detail}</div>}
        </div>
      </div>
      <div className={styles.confirmActions}>
        <Button size="sm" variant="secondary" fill="outline" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button
          size="sm"
          variant={destructive ? 'destructive' : 'primary'}
          icon={busy ? undefined : 'check'}
          onClick={onConfirm}
          disabled={busy}
          data-testid={testId ? `${testId}-ok` : undefined}
        >
          {busy ? 'Enviando…' : confirmLabel}
        </Button>
      </div>
    </div>
  );
};

/** Estado del envío de comandos: enviando, aplicado o error (se queda visible arriba al desplazarse). */
export const SendStatus: React.FC<{ busy: boolean; feedback?: SendFeedback; onDismiss?: () => void }> = ({
  busy,
  feedback,
  onDismiss,
}) => {
  const styles = useStyles2(getStyles);
  if (!busy && !feedback) {
    return null;
  }
  const phase = busy ? 'sending' : feedback!.phase;
  return (
    <div
      className={cx(
        styles.status,
        phase === 'ok' && styles.statusOk,
        phase === 'error' && styles.statusError,
        phase === 'sending' && styles.statusSending
      )}
      role={phase === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-testid="ems-send-status"
      data-phase={phase}
    >
      {phase === 'sending' ? (
        <Spinner inline size="sm" />
      ) : (
        <Icon name={phase === 'ok' ? 'check-circle' : 'exclamation-circle'} />
      )}
      <span className={styles.statusText}>{phase === 'sending' ? 'Enviando comando…' : feedback!.text}</span>
      {!busy && onDismiss && <IconButton name="times" size="sm" aria-label="Ocultar" onClick={onDismiss} />}
    </div>
  );
};

/** Bloque con título para agrupar controles relacionados. */
export const ControlGroup: React.FC<{
  title: string;
  icon?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}> = ({ title, icon, aside, children, testId }) => {
  const styles = useStyles2(getStyles);
  return (
    <section className={styles.group} data-testid={testId}>
      <div className={styles.groupHead}>
        {icon}
        <span className={styles.groupTitle}>{title}</span>
        {aside && <span className={styles.groupAside}>{aside}</span>}
      </div>
      {children}
    </section>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  param: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
  `,
  head: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
  `,
  label: css`
    margin: 0;
    font-size: ${theme.typography.body.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  inputBox: css`
    flex-shrink: 0;
  `,
  input: css`
    input {
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: ${theme.typography.fontWeightMedium};
    }
  `,
  sliderRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  range: css`
    flex: 1;
    min-width: 0;
    accent-color: ${theme.colors.primary.main};
    cursor: pointer;
    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,
  scale: css`
    display: flex;
    justify-content: space-between;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0, 3.5)};
    font-size: 11px;
    color: ${theme.colors.text.secondary};
    font-variant-numeric: tabular-nums;
  `,
  diff: css`
    color: ${theme.colors.primary.text};
    b {
      font-weight: ${theme.typography.fontWeightBold};
    }
  `,
  note: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
    line-height: 1.4;
  `,
  error: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.error.text};
  `,
  confirm: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1, 1.25)};
    border: 1px solid ${theme.colors.warning.border};
    border-radius: ${theme.shape.radius.default};
    background: ${colorManipulator.alpha(theme.colors.warning.main, theme.isDark ? 0.12 : 0.08)};
  `,
  confirmDanger: css`
    border-color: ${theme.colors.error.border};
    background: ${colorManipulator.alpha(theme.colors.error.main, theme.isDark ? 0.12 : 0.06)};
  `,
  confirmText: css`
    display: flex;
    gap: ${theme.spacing(1)};
    align-items: flex-start;
  `,
  confirmIcon: css`
    flex-shrink: 0;
    margin-top: 2px;
    color: ${theme.colors.warning.text};
  `,
  confirmTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  confirmActions: css`
    display: flex;
    justify-content: flex-end;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
  status: css`
    position: sticky;
    top: ${theme.spacing(-1.5)};
    z-index: 2;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(0.75, 1)};
    border-radius: ${theme.shape.radius.default};
    border: 1px solid ${theme.colors.border.medium};
    background: ${theme.colors.background.primary};
    box-shadow: ${theme.shadows.z1};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  statusText: css`
    flex: 1;
    min-width: 0;
  `,
  statusSending: css`
    border-color: ${theme.colors.info.border};
    color: ${theme.colors.info.text};
  `,
  statusOk: css`
    border-color: ${theme.colors.success.border};
    color: ${theme.colors.success.text};
    background: ${theme.colors.background.primary};
    background-image: linear-gradient(
      ${colorManipulator.alpha(theme.colors.success.main, 0.1)},
      ${colorManipulator.alpha(theme.colors.success.main, 0.1)}
    );
  `,
  statusError: css`
    border-color: ${theme.colors.error.border};
    color: ${theme.colors.error.text};
    background-image: linear-gradient(
      ${colorManipulator.alpha(theme.colors.error.main, 0.12)},
      ${colorManipulator.alpha(theme.colors.error.main, 0.12)}
    );
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    padding: ${theme.spacing(1.25)};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  groupHead: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.75)};
    min-height: 24px;
    color: ${theme.colors.text.primary};
  `,
  groupTitle: css`
    font-size: ${theme.typography.h6.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  groupAside: css`
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
