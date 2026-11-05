import React from 'react';
import { GrafanaTheme2, colorManipulator } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';
import { Status } from 'building/telemetry';
import { useStatusColors } from './useStatusColors';

interface Props {
  status: Status;
  label: string;
}

export const StatusBadge: React.FC<Props> = ({ status, label }) => {
  const styles = useStyles2(getStyles);
  const color = useStatusColors()[status];

  return (
    <span
      className={styles.badge}
      style={{
        color,
        borderColor: colorManipulator.alpha(color, 0.5),
        background: colorManipulator.alpha(color, 0.12),
      }}
    >
      <span className={styles.dot} style={{ background: color }} />
      {label}
    </span>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  badge: css`
    display: inline-flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
    padding: ${theme.spacing(0.25, 1)};
    border: 1px solid;
    border-radius: ${theme.shape.radius.pill};
    font-size: ${theme.typography.bodySmall.fontSize};
    font-weight: ${theme.typography.fontWeightMedium};
    white-space: nowrap;
  `,
  dot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
  `,
});
