import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { Button, useStyles2 } from '@grafana/ui';
import { Glyph, GlyphName } from './Glyph';

const STEPS: Array<[GlyphName, string, string]> = [
  [
    'clock',
    'Elige la hora',
    'Mueve la barra de tiempo, cambia el día o acelera la simulación (hasta 1 hora por segundo).',
  ],
  [
    'cursor',
    'Explora el edificio',
    'Pasa el mouse sobre una zona o una unidad VRF de la azotea; haz clic en una zona para ver su detalle.',
  ],
  [
    'sliders',
    'Controla',
    'Pestaña Control: setpoint, límite de demanda, acciones rápidas o control manual de cada zona.',
  ],
  [
    'fire',
    'Simula',
    'Pestaña Simular: incendio, corte de energía, fallas… y «¿qué pasaría si?» una temperatura se mantiene horas.',
  ],
  [
    'building',
    'Cambia la vista',
    'Arriba: estado, temperatura, ocupación, potencia, iluminación o HVAC. Gira el edificio o sepáralo por pisos.',
  ],
];

export const HelpOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.backdrop} onClick={onClose} data-testid="ems-help">
      <div className={styles.card} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Cómo usar el panel">
        <div className={styles.title}>Cómo usar el panel</div>
        {STEPS.map(([g, t, d]) => (
          <div key={t} className={styles.step}>
            <span className={styles.glyph}>
              <Glyph name={g} size={20} />
            </span>
            <div>
              <div className={styles.stepTitle}>{t}</div>
              <div className={styles.stepDetail}>{d}</div>
            </div>
          </div>
        ))}
        <Button onClick={onClose} fullWidth>
          Entendido
        </Button>
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  backdrop: css`
    position: absolute;
    inset: 0;
    background: ${theme.isDark ? 'rgba(0,0,0,0.55)' : 'rgba(20,20,40,0.25)'};
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  `,
  card: css`
    width: min(420px, calc(100% - 32px));
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.25)};
    padding: ${theme.spacing(2)};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary};
    border: 1px solid ${theme.colors.border.medium};
    box-shadow: ${theme.shadows.z3};
  `,
  title: css`
    font-size: ${theme.typography.h4.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  step: css`
    display: flex;
    gap: ${theme.spacing(1)};
  `,
  glyph: css`
    font-size: 20px;
    width: 28px;
    text-align: center;
  `,
  stepTitle: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  stepDetail: css`
    font-size: ${theme.typography.bodySmall.fontSize};
    color: ${theme.colors.text.secondary};
  `,
});
