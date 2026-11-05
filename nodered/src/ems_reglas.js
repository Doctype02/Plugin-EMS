// Nodo función "EMS: reglas + respuesta a la demanda" — entrada: ems/<edif>/medidor/general
// Misma lógica que ems/control.py (clase ReglasDR). Se ejecuta una vez por paso de simulación.
// Salida 1: comandos por zona (ems/<edif>/zona/<Z>/cmd)
// Salida 2: estado del EMS (ems/<edif>/ems/estado)
// Salida 3: alarmas (ems/<edif>/alarma)

const P = Object.assign({
    edificio: env.get("EMS_EDIFICIO") || "edificio1",
    banda: 0.5, sp_ocupado: 24.0, sp_desocupado: 27.0, sp_noche: 29.0,
    precool_min: 60, entrada: 7.5, salida: 17.5,
    lux_objetivo: 500, lux_artificial: 500,
    luces_desocupado: 0.0, equipos_desocupado: 0.10, retardo_vacancia_min: 15,
    limite_kw: 145, dr_hist_kw: 10, dr_luces: 0.70, dr_equipos: 0.85, dr_margen_confort: 0.75,
    confort_max: 26.0, confort_min: 21.0, alarma_servidor: 27.0, fan_frac: 0.08
}, flow.get("parametros") || {});

// capacidad térmica (kW) y COP nominal por zona (config/edificio.yaml)
const HVAC = {
    Z01: [24, 3.0], Z02: [30, 3.0], Z03: [30, 3.0], Z04: [30, 3.0], Z05: [30, 3.0],
    Z06: [18, 3.0], Z07: [26, 3.0], Z08: [24, 3.0], Z09: [30, 2.8], Z10: [10, 3.0]
};

const tInicio = Date.now();
const med = msg.payload;
const zonas = flow.get("zonas") || {};
const st = flow.get("st") || { ultimoOcup: {}, hist: {}, cont: {}, activas: {}, drEtapa: 0, drCont: 0, cmdId: 0 };
const base = "ems/" + P.edificio;

// ---------------------------------------------------------------- tiempo local (Panamá, UTC-5)
const d = new Date(med.ts);
const loc = new Date(d.getTime() - 5 * 3600 * 1000);
const h = loc.getUTCHours() + loc.getUTCMinutes() / 60;
const dow = loc.getUTCDay();                // 0 = domingo
const laborable = dow >= 1 && dow <= 5;
const horarioLaboral = laborable && h >= P.entrada - 0.5 && h < P.salida + 0.5;
const precool = laborable && h >= P.entrada - P.precool_min / 60 && h < P.entrada;

const alarmas = [];
function cond(clave, activa, pasos) {
    st.cont[clave] = activa ? (st.cont[clave] || 0) + 1 : 0;
    if (st.cont[clave] >= (pasos || 1) && !st.activas[clave]) { st.activas[clave] = true; return true; }
    if (!activa) { delete st.activas[clave]; }
    return false;
}
function alarma(nivel, codigo, zona, mensaje, valor) {
    alarmas.push({ ts: med.ts, nivel, codigo, zona, mensaje, valor: valor === undefined ? null : valor, origen: "nodered" });
}

// ---------------------------------------------------------------- validación de sensores + alarmas
const invalidos = {};
for (const zid of Object.keys(zonas)) {
    const z = zonas[zid];
    const hs = st.hist[zid] = (st.hist[zid] || []).concat([z.temp_c]).slice(-6);
    let motivo = null;
    if (typeof z.temp_c !== "number" || !isFinite(z.temp_c) || z.temp_c < 5 || z.temp_c > 50) motivo = "SENSOR_FUERA_RANGO";
    else if (hs.length === 6 && Math.max(...hs) - Math.min(...hs) < 0.005) motivo = "SENSOR_CONGELADO";
    else if (hs.length >= 4) {
        let saltos = 0;
        for (let i = 1; i < hs.length; i++) if (Math.abs(hs[i] - hs[i - 1]) > 1.2) saltos++;
        if (saltos >= 3) motivo = "SENSOR_FUERA_RANGO";
    }
    if (motivo) invalidos[zid] = true;
    if (cond(zid + ":SENSOR", !!motivo)) alarma("crit", motivo, zid, `Sensor no confiable (${z.temp_c}) → modo seguro`, z.temp_c);
    if (motivo) continue;
    if (cond(zid + ":TEMP_ALTA", z.ocupado && z.temp_c > P.confort_max, 3))
        alarma("warn", "TEMP_ALTA", zid, `${z.temp_c.toFixed(1)} °C > ${P.confort_max} °C con ocupación`, z.temp_c);
    if (cond(zid + ":TEMP_BAJA", z.ocupado && z.temp_c < P.confort_min, 3))
        alarma("info", "TEMP_BAJA", zid, `${z.temp_c.toFixed(1)} °C < ${P.confort_min} °C con ocupación`, z.temp_c);
    if (z.tipo === "servidores" && cond(zid + ":SRV", z.temp_c > P.alarma_servidor, 2))
        alarma("crit", "SERVIDOR_TEMP", zid, `Cuarto de servidores a ${z.temp_c.toFixed(1)} °C`, z.temp_c);
    if (!z.critica && cond(zid + ":HVAC_SIN_OCUP", z.hvac_on && !z.ocupado, 12))
        alarma("info", "HVAC_ON_SIN_OCUPACION", zid, "HVAC encendido > 60 min sin ocupación");
}
if (cond("EDIF:PICO", med.demanda_15min_kw > P.limite_kw))
    alarma("warn", "PICO_DEMANDA", "EDIF", `Demanda 15 min ${med.demanda_15min_kw.toFixed(1)} kW > ${P.limite_kw} kW`, med.demanda_15min_kw);

// ---------------------------------------------------------------- reglas por zona
const cmds = {};
const tMs = d.getTime();
for (const zid of Object.keys(zonas)) {
    const z = zonas[zid];
    if (z.critica) continue;
    if (z.ocupado) st.ultimoOcup[zid] = tMs;
    const ocup = z.ocupado || (st.ultimoOcup[zid] !== undefined && tMs - st.ultimoOcup[zid] <= P.retardo_vacancia_min * 60000);
    let sp, en;
    if (ocup || precool) { sp = P.sp_ocupado; en = true; }
    else if (horarioLaboral) { sp = P.sp_desocupado; en = true; }
    else { sp = P.sp_noche; en = z.temp_c > P.sp_noche + P.banda; }
    let luces, equipos;
    if (ocup) {
        const luxDia = Math.max(z.lux - P.lux_artificial * z.luces_nivel, 0);
        luces = Math.min(Math.max((P.lux_objetivo - luxDia) / P.lux_artificial, 0.1), 1.0);
        luces = Math.round(Math.round(luces / 0.05) * 0.05 * 100) / 100;
        equipos = 1.0;
    } else { luces = P.luces_desocupado; equipos = P.equipos_desocupado; }
    cmds[zid] = { hvac_enable: en, setpoint_c: sp, ventilacion: "dcv", luces_nivel: luces, equipos_nivel: equipos, hvac_mod: null };
}

// ---------------------------------------------------------------- limitador de demanda (rotación de compresores)
let pCompActual = 0;
const sol = [];
for (const zid of Object.keys(cmds)) {
    const z = zonas[zid], c = cmds[zid];
    if (invalidos[zid]) continue;
    const [cap, copN] = HVAC[zid] || [20, 3.0];
    const cop = Math.max(copN * (1 - 0.015 * (med.t_ext_c - 30)), 1);
    const fan = z.hvac_enable && (z.ocupado || z.hvac_on) ? P.fan_frac * cap * 0.6 : 0;
    if (z.hvac_on) pCompActual += Math.max(z.p_hvac_kw - fan, 0);
    if (!c.hvac_enable) continue;
    const pide = z.temp_c > c.setpoint_c + P.banda || (z.hvac_on && z.temp_c > c.setpoint_c - P.banda);
    if (pide) sol.push({ zid, urg: z.temp_c - c.setpoint_c, kw: cap / cop, emerg: z.temp_c > P.confort_max - P.dr_margen_confort });
}
let presupuesto = P.limite_kw - 3 - (med.p_total_kw - pCompActual);
let forzadas = 0;
sol.sort((a, b) => (a.emerg === b.emerg ? b.urg - a.urg : (a.emerg ? -1 : 1)));
for (const s of sol) {
    if (s.emerg || s.kw <= presupuesto) { presupuesto -= s.kw; continue; }
    cmds[s.zid].hvac_mod = 0.0;
    forzadas++;
}
const dem = med.demanda_15min_kw;
if (dem > P.limite_kw) { st.drEtapa = 2; st.drCont = 0; }
else if (st.drEtapa === 2 && dem < P.limite_kw - P.dr_hist_kw) { st.drCont++; if (st.drCont >= 3) { st.drEtapa = 0; st.drCont = 0; } }
if (st.drEtapa < 2) st.drEtapa = forzadas ? 1 : 0;
if (st.drEtapa >= 2) {
    for (const zid of Object.keys(cmds)) {
        cmds[zid].luces_nivel = Math.round(cmds[zid].luces_nivel * P.dr_luces * 1000) / 1000;
        cmds[zid].equipos_nivel = Math.min(cmds[zid].equipos_nivel, P.dr_equipos);
    }
}
const drActivo = st.drEtapa > 0;
if (cond("EDIF:DR", drActivo)) alarma("info", "DR_ACTIVO", "EDIF", "Respuesta a la demanda activada");

// ---------------------------------------------------------------- modo seguro
for (const zid of Object.keys(invalidos)) {
    const crit = zonas[zid] && zonas[zid].critica;
    cmds[zid] = Object.assign(cmds[zid] || {}, { hvac_enable: true, hvac_mod: crit ? 1.0 : 0.55, setpoint_c: P.sp_ocupado });
}
for (const zid of Object.keys(zonas)) {
    if (zonas[zid].critica && !invalidos[zid]) cmds[zid] = { hvac_mod: null };
}

// ---------------------------------------------------------------- salidas
const ahora = Date.now();
const salidaCmd = Object.keys(cmds).map(zid => ({
    topic: `${base}/zona/${zid}/cmd`,
    payload: Object.assign({ cmd_id: ++st.cmdId, wall_ms: ahora }, cmds[zid])
}));
const estado = {
    topic: `${base}/ems/estado`,
    payload: {
        ts: med.ts, origen: "nodered", modo: "reglas_dr", dr_activo: drActivo, dr_etapa: st.drEtapa,
        limite_kw: P.limite_kw, n_alarmas: Object.keys(st.activas).length,
        modo_seguro: Object.keys(invalidos), latencia_ms: Date.now() - tInicio, zonas_forzadas: forzadas
    }
};
flow.set("st", st);
const salidaAl = alarmas.map(a => ({ topic: `${base}/alarma`, payload: a }));
return [salidaCmd, estado, salidaAl];
