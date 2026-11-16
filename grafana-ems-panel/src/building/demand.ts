/** Fracción del límite a partir de la cual la demanda se marca en alerta (el limitador entra cerca de aquí). */
export const DEMAND_WARN = 0.85;

export type DemandLevel = 'ok' | 'warning' | 'critical';

/** Nivel de la potencia respecto al límite de demanda. */
export function demandLevel(kw: number, limit: number): DemandLevel {
  if (!(limit > 0) || !Number.isFinite(kw)) {
    return 'ok';
  }
  return kw > limit ? 'critical' : kw >= limit * DEMAND_WARN ? 'warning' : 'ok';
}

/** Escala de la barra: el límite queda a ~85 % del ancho, salvo que la potencia lo supere. */
export function gaugeScale(kw: number, limit: number): number {
  return Math.max(limit * 1.18, kw * 1.05, 1);
}
