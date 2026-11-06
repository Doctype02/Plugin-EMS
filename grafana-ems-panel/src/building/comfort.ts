/**
 * Confort y riesgo frente a temperaturas sostenidas.
 *
 * - PMV/PPD: ISO 7730:2005 (algoritmo del anexo D).
 * - Productividad: Seppänen, Fisk y Lei (2006), «Effect of temperature on task performance in office
 *   environment»: el rendimiento baja ≈ 2 % por °C por encima de 25 °C (máximo cerca de 22 °C).
 * - Equipos de TI: ASHRAE TC 9.9 (2011/2021), recomendado 18–27 °C, clase A1 admisible hasta 32 °C;
 *   factor X de tasa relativa de fallas según la temperatura de entrada.
 * - Baterías plomo-ácido del UPS: la vida útil se reduce a la mitad por cada 8 °C sobre 25 °C (IEEE 1188).
 */

export interface PmvInput {
  ta: number;
  tr?: number;
  rh: number;
  vel?: number;
  met?: number;
  clo?: number;
}

/** Voto medio previsto (ISO 7730). Escala −3 (frío) … +3 (calor). */
export function pmv({ ta, tr = ta, rh, vel = 0.1, met = 1.1, clo = 0.5 }: PmvInput): number {
  const pa = rh * 10 * Math.exp(16.6536 - 4030.183 / (ta + 235));
  const icl = 0.155 * clo;
  const m = met * 58.15;
  const w = 0;
  const mw = m - w;
  const fcl = icl <= 0.078 ? 1 + 1.29 * icl : 1.05 + 0.645 * icl;
  const hcf = 12.1 * Math.sqrt(vel);
  const taa = ta + 273;
  const tra = tr + 273;
  let tcla = taa + (35.5 - ta) / (3.5 * icl + 0.1);
  const p1 = icl * fcl;
  const p2 = p1 * 3.96;
  const p3 = p1 * 100;
  const p4 = p1 * taa;
  const p5 = 308.7 - 0.028 * mw + p2 * Math.pow(tra / 100, 4);
  let xn = tcla / 100;
  let xf = xn;
  let hc = hcf;
  for (let i = 0; i < 150; i++) {
    xf = (xf + xn) / 2;
    const hcn = 2.38 * Math.pow(Math.abs(100 * xf - taa), 0.25);
    hc = Math.max(hcf, hcn);
    xn = (p5 + p4 * hc - p2 * Math.pow(xf, 4)) / (100 + p3 * hc);
    if (Math.abs(xn - xf) < 0.00015) {
      break;
    }
  }
  const tcl = 100 * xn - 273;
  const hl1 = 3.05 * 0.001 * (5733 - 6.99 * mw - pa);
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0;
  const hl3 = 1.7 * 0.00001 * m * (5867 - pa);
  const hl4 = 0.0014 * m * (34 - ta);
  const hl5 = 3.96 * fcl * (Math.pow(xn, 4) - Math.pow(tra / 100, 4));
  const hl6 = fcl * hc * (tcl - ta);
  const ts = 0.303 * Math.exp(-0.036 * m) + 0.028;
  return ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6);
}

/** Porcentaje previsto de insatisfechos (ISO 7730). */
export function ppd(v: number): number {
  return 100 - 95 * Math.exp(-0.03353 * v ** 4 - 0.2179 * v ** 2);
}

export function pmvLabel(v: number): string {
  if (v < -2.5) {
    return 'Frío';
  }
  if (v < -1.5) {
    return 'Fresco';
  }
  if (v < -0.5) {
    return 'Ligeramente fresco';
  }
  if (v <= 0.5) {
    return 'Neutro (confortable)';
  }
  if (v <= 1.5) {
    return 'Ligeramente caluroso';
  }
  if (v <= 2.5) {
    return 'Caluroso';
  }
  return 'Muy caluroso';
}

/** Pérdida de rendimiento laboral (%) respecto al óptimo, Seppänen et al. (2006). */
export function productivityLoss(t: number): number {
  if (t <= 25) {
    return Math.max(0, 21 - t); // ligera pérdida por frío bajo 21 °C
  }
  return Math.min(20, 2 * (t - 25));
}

const XFACTOR: Array<[number, number]> = [
  [15, 0.72],
  [17.5, 0.87],
  [20, 1.0],
  [22.5, 1.13],
  [25, 1.24],
  [27.5, 1.34],
  [30, 1.42],
  [32.5, 1.48],
  [35, 1.55],
  [40, 1.66],
  [45, 1.76],
];

/** Tasa relativa de fallas de servidores (factor X de ASHRAE, 1.0 a 20 °C). */
export function xFactor(t: number): number {
  if (t <= XFACTOR[0][0]) {
    return XFACTOR[0][1];
  }
  for (let i = 1; i < XFACTOR.length; i++) {
    const [t1, x1] = XFACTOR[i];
    const [t0, x0] = XFACTOR[i - 1];
    if (t <= t1) {
      return x0 + ((x1 - x0) * (t - t0)) / (t1 - t0);
    }
  }
  return XFACTOR[XFACTOR.length - 1][1] + 0.02 * (t - 45);
}

/** Fracción de vida útil restante de una batería plomo-ácido operada a t (1 = 25 °C). */
export function batteryLifeFactor(t: number): number {
  return Math.min(1, Math.pow(2, -(t - 25) / 8));
}

export type ItClass = 'recomendado' | 'admisible' | 'fuera';
export function itClass(t: number): ItClass {
  return t >= 18 && t <= 27 ? 'recomendado' : t >= 15 && t <= 32 ? 'admisible' : 'fuera';
}
