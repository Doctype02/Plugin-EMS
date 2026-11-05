import { useMemo } from 'react';
import { useTheme2 } from '@grafana/ui';
import { Status } from 'building/telemetry';

export function useStatusColors(): Record<Status, string> {
  const theme = useTheme2();
  return useMemo(
    () => ({
      ok: theme.visualization.getColorByName('green'),
      warning: theme.visualization.getColorByName('orange'),
      critical: theme.visualization.getColorByName('red'),
      offline: theme.colors.text.disabled,
    }),
    [theme]
  );
}
