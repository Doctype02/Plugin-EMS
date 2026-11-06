/**
 * «¿Qué pasaría si…?»: consecuencias de mantener una temperatura durante horas y de perder el
 * enfriamiento, con el mismo modelo RC del gemelo (model.ts → thermal) y los criterios de comfort.ts.
 */
import { batteryLifeFactor, itClass, ItClass, pmv, pmvLabel, ppd, productivityLoss, xFactor } from './comfort';
import { ENVELOPE, ZONE_BY_ID, thermal } from './model';
import { SimOptions, freeFloat, instant, simulate } from './simulator';
import { newEvent } from './events';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Supuestos económicos (documentados; ajustables). */
export const ASSUMPTIONS = {
  /** Costo laboral por hora en oficina, Ciudad de Panamá (≈ 1 300 USD/mes con cargas sociales). */
  wageUsdH: 7.5,
  /** Precio medio de la energía (USD/kWh, tarifa comercial BTD supuesta). */
  priceUsdKwh: 0.21,
  /** Setpoint de referencia del EMS con ocupación. */
  refSetpoint: 24,
  rh: 55,
};

export interface Consequence {
  level: 'ok' | 'info' | 'warn' | 'crit';
  title: string;
  detail: string;
}

export interface ZoneProjection {
  zone: string;
  temp: number;
  hours: number;
  pmv: number;
  ppd: number;
  sensation: string;
  productivityLoss: number;
  productivityUsd: number;
  energyKwh: number;
  energyUsd: number;
  it?: { xFactor: number; cls: ItClass; extraFailuresPct: number; batteryLife: number; batteryDaysLost: number };
  consequences: Consequence[];
}

/** Consecuencias de mantener la zona a `temp` °C durante `hours` horas (con su ocupación de diseño). */
export function projectZone(zoneId: string, temp: number, hours: number, rh = ASSUMPTIONS.rh): ZoneProjection {
  const z = ZONE_BY_ID[zoneId];
  const th = thermal(z);
  const v = pmv({ ta: temp, rh });
  const p = ppd(v);
  const loss = productivityLoss(temp);
  const people = z.occupants;
  const productivityUsd = (people * hours * ASSUMPTIONS.wageUsdH * loss) / 100;
  // cada °C por debajo de la referencia exige retirar G·ΔT más de calor sensible (más su COP)
  const g = th.ua + th.gInf + th.uaGround;
  const ref = z.fixedSetpoint ?? ASSUMPTIONS.refSetpoint;
  const energyKwh = ((g * (ref - temp)) / z.cop) * hours;
  const out: ZoneProjection = {
    zone: zoneId,
    temp,
    hours,
    pmv: v,
    ppd: p,
    sensation: pmvLabel(v),
    productivityLoss: loss,
    productivityUsd,
    energyKwh,
    energyUsd: energyKwh * ASSUMPTIONS.priceUsdKwh,
    consequences: [],
  };
  const c = out.consequences;
  if (z.type === 'servidores' || z.type === 'electrico') {
    const x = xFactor(temp);
    const cls = itClass(temp);
    const life = batteryLifeFactor(temp);
    out.it = {
      xFactor: x,
      cls,
      extraFailuresPct: (x / xFactor(z.fixedSetpoint ?? 24) - 1) * 100,
      batteryLife: life,
      // horas a temp equivalen a horas/life a 25 °C: días de vida consumidos de más
      batteryDaysLost: (hours * (1 / life - 1)) / 24,
    };
    if (temp > 35) {
      c.push({
        level: 'crit',
        title: 'Apagado térmico probable',
        detail: 'Por encima de 35 °C los servidores se protegen apagándose: pérdida de servicio.',
      });
    }
    c.push({
      level: cls === 'recomendado' ? 'ok' : cls === 'admisible' ? 'warn' : 'crit',
      title:
        cls === 'recomendado'
          ? 'Dentro del rango recomendado ASHRAE (18–27 °C)'
          : cls === 'admisible'
            ? 'Fuera del rango recomendado (admisible A1 ≤ 32 °C)'
            : 'Fuera del rango admisible A1',
      detail: `Tasa de fallas relativa ×${x.toFixed(2)} (${out.it.extraFailuresPct >= 0 ? '+' : ''}${out.it.extraFailuresPct.toFixed(0)} % frente a ${z.fixedSetpoint ?? 24} °C).`,
    });
    if (temp > 25) {
      c.push({
        level: temp > 30 ? 'warn' : 'info',
        title: `Baterías del UPS al ${(life * 100).toFixed(0)} % de su vida`,
        detail: `Cada 8 °C sobre 25 °C reducen a la mitad la vida de una batería plomo-ácido: ${hours} h aquí consumen ${out.it.batteryDaysLost.toFixed(1)} días extra de vida.`,
      });
    }
  } else {
    c.push({
      level: Math.abs(v) <= 0.5 ? 'ok' : Math.abs(v) <= 1 ? 'info' : Math.abs(v) <= 2 ? 'warn' : 'crit',
      title: `Sensación: ${out.sensation.toLowerCase()} (PMV ${v >= 0 ? '+' : ''}${v.toFixed(1)})`,
      detail: `${p.toFixed(0)} % de insatisfechos previstos (ISO 7730; categoría B exige ≤ 10 %).`,
    });
    if (people > 0 && loss > 0) {
      c.push({
        level: loss >= 10 ? 'crit' : loss >= 4 ? 'warn' : 'info',
        title: `Rendimiento −${loss.toFixed(0)} %`,
        detail: `${people} personas × ${hours} h: ≈ ${productivityUsd.toFixed(0)} USD de trabajo perdido (Seppänen 2006, ${ASSUMPTIONS.wageUsdH} USD/h).`,
      });
    }
    if (temp >= 30) {
      c.push({
        level: 'crit',
        title: 'Estrés térmico',
        detail:
          'Fatiga, cefalea y deshidratación; se recomienda suspender el trabajo sedentario prolongado o reubicar al personal.',
      });
    }
    if (temp >= 27 && rh >= 60) {
      c.push({
        level: 'warn',
        title: 'Humedad y moho',
        detail: 'Con HR alta sostenida aumentan la condensación en superficies frías y el riesgo de moho.',
      });
    }
  }
  if (temp < ref - 0.5) {
    c.push({
      level: temp < ref - 3 ? 'warn' : 'info',
      title: `Sobreenfriamiento: +${energyKwh.toFixed(1)} kWh`,
      detail: `${(ref - temp).toFixed(1)} °C por debajo de ${ref} °C cuestan ≈ ${out.energyUsd.toFixed(2)} USD en ${hours} h (${((g / z.cop) * 1000).toFixed(0)} W eléctricos por °C).`,
    });
  } else if (temp > ref + 0.5) {
    c.push({
      level: 'info',
      title: `Ahorro: ${(-energyKwh).toFixed(1)} kWh`,
      detail: `Mantenerla más caliente ahorra ≈ ${(-out.energyUsd).toFixed(2)} USD, a costa del confort.`,
    });
  }
  return out;
}

export interface FreeFloatResult {
  zone: string;
  series: Array<[number, number]>;
  /** Minutos hasta superar cada umbral (undefined si no se alcanza en el horizonte). */
  thresholds: Array<{ temp: number; minutes?: number; label: string }>;
  final: number;
}

/** Evolución de la temperatura si la zona pierde el enfriamiento en el instante t0. */
export function freeFloatCurve(
  zoneId: string,
  t0: number,
  hours: number,
  opts: SimOptions,
  extraKw = 0
): FreeFloatResult {
  const z = ZONE_BY_ID[zoneId];
  const snap = simulate(t0, opts);
  const s = snap.zones[zoneId];
  const tExt = snap.meter?.tExt ?? 30;
  // mismas ganancias que el gemelo (simulator.ts): personas, luces, equipos y sol por las ventanas
  const solar = (thermal(z).glass * ENVELOPE.shgc * ENVELOPE.solarFactor * (snap.meter?.irr ?? 0) * 0.4) / 1000;
  const gains = s.occupants * 0.075 + s.pLights + s.pPlugs + extraKw + solar * 2;
  const series: Array<[number, number]> = [];
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const h = (hours * i) / n;
    series.push([h, freeFloat(z, s.temp, h, gains, tExt)]);
  }
  const marks =
    z.type === 'servidores'
      ? [
          { temp: 27, label: 'Límite recomendado ASHRAE' },
          { temp: 32, label: 'Límite admisible A1' },
          { temp: 35, label: 'Apagado térmico' },
        ]
      : [
          { temp: 26, label: 'Fin del confort (26 °C)' },
          { temp: 28, label: 'Rendimiento −6 %' },
          { temp: 30, label: 'Estrés térmico' },
        ];
  const thresholds = marks.map((m) => {
    const idx = series.findIndex(([, v]) => v >= m.temp);
    if (idx < 0) {
      return { ...m, minutes: undefined };
    }
    if (idx === 0) {
      return { ...m, minutes: 0 };
    }
    const [h0, v0] = series[idx - 1];
    const [h1, v1] = series[idx];
    return { ...m, minutes: (h0 + ((m.temp - v0) / (v1 - v0)) * (h1 - h0)) * 60 };
  });
  return { zone: zoneId, series, thresholds, final: series[series.length - 1][1] };
}

export interface HeatwaveResult {
  series: Array<{ t: number; base: number; hot: number }>;
  energyBase: number;
  energyHot: number;
  peakBase: number;
  peakHot: number;
  hoursOverLimit: number;
  costUsd: number;
}

/** Edificio completo con el exterior `delta` °C más caliente durante `hours` horas desde t0. */
export function projectHeatwave(t0: number, hours: number, delta: number, opts: SimOptions): HeatwaveResult {
  const ev = newEvent('ola_calor', t0, hours * 60, { intensity: delta, id: 'proyeccion' });
  const hotOpts = { ...opts, events: [...(opts.events ?? []), ev] };
  const step = hours > 24 ? 60 * MIN : 20 * MIN;
  const series: HeatwaveResult['series'] = [];
  let eb = 0;
  let eh = 0;
  let over = 0;
  for (let t = t0; t < t0 + hours * HOUR; t += step) {
    const b = instant(t, opts).pTotal;
    const h = instant(t, hotOpts).pTotal;
    series.push({ t, base: b, hot: h });
    eb += (b * step) / HOUR;
    eh += (h * step) / HOUR;
    over += h > opts.limitKw ? step / HOUR : 0;
  }
  return {
    series,
    energyBase: eb,
    energyHot: eh,
    peakBase: Math.max(...series.map((s) => s.base)),
    peakHot: Math.max(...series.map((s) => s.hot)),
    hoursOverLimit: over,
    costUsd: (eh - eb) * ASSUMPTIONS.priceUsdKwh,
  };
}
