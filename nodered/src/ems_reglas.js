// Nodo función "EMS: reglas + respuesta a la demanda" — entrada: ems/<edif>/medidor/general
// Misma lógica que ems/control.py (clase ReglasDR). Se ejecuta una vez por paso de simulación.
// Salida 1: comandos por zona (ems/<edif>/zona/<Z>/cmd)
// Salida 2: estado del EMS (ems/<edif>/ems/estado)
// Salida 3: alarmas (ems/<edif>/alarma)

const P = Object.assign({
    edificio: env.get("EMS_EDIFICIO") || "edificio1",
    banda: 0.5, sp_ocupado: 24.0, sp_desocupado: 27.0,
    t_prot_max: 32.0, t_prot_retorno: 30.0, rampa_sp_c_h: 3.0, arranques_max: 2, paso_min: 5,
    precool_min: 90, entrada: 8.0, salida: 18.0,
    // arranque óptimo (cada zona empieza antes cuanto más caliente está) y tope de potencia antes de abrir
    precool_margen: 1.5, precool_min_grado: 70, precool_max_min: 420, limite_precool_kw: 90,
    lux_objetivo: 500, lux_artificial: 500,
    luces_desocupado: 0.0, equipos_desocupado: 0.1, retardo_vacancia_min: 15,
    limite_kw: 30, dr_hist_kw: 3, dr_luces: 0.7, dr_equipos: 0.85, dr_margen_confort: 0.75,
    confort_max: 26.0, confort_min: 21.0, alarma_servidor: 27.0,
    plr_min: 0.15, banda_prop: 2.0,
    // planta de respaldo (modo emergencia): límite = gen_kw × gen_carga_max
    gen_kw: 100, gen_carga_max: 0.8, sp_emergencia: 25.0, sp_emergencia_min: 24.0, luces_emergencia: 0.7,
    sin_hvac_emergencia: ["pasillo"],
    // encendido escalonado por planta (null = pre-enfriamiento por temperatura con arranque óptimo)
    arranque: /*@ARRANQUE@*/null/*@FIN@*/
}, flow.get("parametros") || {});

// Terminal VRF de cada zona: [capacidad total kW, COP estacional del sistema, ventilador kW].
// Lo genera nodered/build_flows.py desde config/edificio.yaml; se puede reemplazar con flow "parametros" → hvac.
const HVAC = P.hvac || /*@HVAC@*/{"Z01": [5.76, 1.72, 0.147], "Z02": [19.41, 1.72, 0.435], "Z03": [13.36, 1.72, 0.269], "Z04": [17.04, 2.08, 0.433], "Z05": [16.13, 2.08, 0.397], "Z06": [15.31, 2.08, 0.37], "Z07": [14.54, 2.08, 0.341], "Z08": [3.55, 2.08, 0.099], "Z09": [2.89, 3.08, 0.086], "Z10": [0.16, 1.72, 0.003]}/*@FIN@*/;
// Planta de cada zona (la genera build_flows.py; se puede reemplazar con flow "parametros" → plantas)
const PLANTAS = P.plantas || /*@PLANTAS@*/{}/*@FIN@*/;
// capacidad pedida por el terminal (ley proporcional, igual que ems/edificio.py: fraccion_carga)
const fraccionCarga = (t, sp) => Math.min(1, Math.max(P.plr_min, (t - sp + P.banda) / P.banda_prop));

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
const antesDeEntrada = laborable && h < P.entrada;
// arranque óptimo: el adelanto crece con el exceso de temperatura de la zona (igual que Controlador.precool)
// encendido escalonado por planta: [encendido, consigna] dentro de la ventana sin reglas de temperatura, o null
function arranquePlanta(zid, tipo) {
    const A = P.arranque;
    if (!A || !laborable) return null;
    const ventana = A.sin_reglas_temperatura_h || [A.inicio_h, P.entrada];
    const orden = A.orden || [];
    const fin = Math.max(ventana[1], A.inicio_h + (orden.length - 1) * A.intervalo_min / 60 + P.paso_min / 60);
    if (!(h >= ventana[0] && h < fin - 1e-9)) return null;
    const i = orden.indexOf(PLANTAS[zid]);
    if ((A.excluir_tipos || []).includes(tipo) || i < 0) return [false, A.setpoint_c];
    return [h >= A.inicio_h + i * A.intervalo_min / 60 - 1e-9, A.setpoint_c];
}
function precoolZona(temp) {
    if (P.arranque) return false;
    const exceso = temp - (P.sp_ocupado + P.precool_margen);
    const adelanto = Math.min(P.precool_min + Math.max(exceso, 0) * P.precool_min_grado, Math.max(P.precool_max_min, P.precool_min));
    return laborable && h >= P.entrada - adelanto / 60 && h < P.entrada;
}

// edificio alimentado por la planta de respaldo (corte de red): reglas de emergencia
const emergencia = med.modo_energia === "generador";

// el pre-enfriamiento enciende el aire sin gente a propósito: no es una alarma
const enPrecool = laborable && h >= P.entrada - Math.max(P.precool_max_min, P.precool_min) / 60 && h < P.entrada + 0.5;

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
    if (!z.critica && cond(zid + ":HVAC_SIN_OCUP", z.hvac_on && !z.ocupado && !enPrecool, 12))
        alarma("info", "HVAC_ON_SIN_OCUPACION", zid, "HVAC encendido > 60 min sin ocupación");
}
if (cond("EDIF:PICO", med.demanda_15min_kw > P.limite_kw))
    alarma("warn", "PICO_DEMANDA", "EDIF", `Demanda 15 min ${med.demanda_15min_kw.toFixed(1)} kW > ${P.limite_kw} kW`, med.demanda_15min_kw);

// ---------------------------------------------------------------- reglas por zona
// contadores de cada regla (zonas afectadas en este paso) → dashboard «Reglas del EMS»
const R = { ocupadas: 0, vacancia: 0, setback: 0, apagadas: 0, proteccion_alta: 0, proteccion_baja: 0,
            luz_natural: 0, standby: 0, emergencia: 0, arranque_planta: 0, precool: 0, fuera_horario: horarioLaboral ? 0 : 1 };
const cmds = {};
const tMs = d.getTime();
for (const zid of Object.keys(zonas)) {
    const z = zonas[zid];
    if (z.critica) continue;
    if (z.ocupado) st.ultimoOcup[zid] = tMs;
    const ocup = z.ocupado || (st.ultimoOcup[zid] !== undefined && tMs - st.ultimoOcup[zid] <= P.retardo_vacancia_min * 60000);
    const ap = emergencia ? null : arranquePlanta(zid, z.tipo);
    if (ap) {
        // ventana de encendido escalonado: sin reglas de temperatura, sólo el turno de la planta
        if (z.ocupado) R.ocupadas++; else if (ap[0]) R.arranque_planta++; else R.apagadas++;
        let lz, ez;
        if (ocup) {
            const luxDia = Math.max(z.lux - P.lux_artificial * z.luces_nivel, 0);
            lz = Math.min(Math.max((P.lux_objetivo - luxDia) / P.lux_artificial, 0.1), 1.0);
            lz = Math.round(Math.round(lz / 0.05) * 0.05 * 100) / 100; ez = 1.0;
        } else { lz = P.luces_desocupado; ez = P.equipos_desocupado; R.standby++; }
        cmds[zid] = { hvac_enable: ap[0], setpoint_c: ap[1], ventilacion: "dcv", luces_nivel: lz, equipos_nivel: ez, hvac_mod: null };
        continue;
    }
    if (z.ocupado) R.ocupadas++; else if (ocup) R.vacancia++;
    let sp, en;
    // enclavamiento: una vez iniciado, el pre-enfriamiento sigue hasta la entrada
    const precool = precoolZona(z.temp_c) || (antesDeEntrada && !!z.hvac_enable && z.setpoint_c < P.sp_desocupado
        && h >= P.entrada - Math.max(P.precool_max_min, P.precool_min) / 60);
    if (ocup || precool) {
        sp = P.sp_ocupado; en = true;
        if (!ocup) R.precool++;
        if (emergencia) sp = Math.max(P.sp_emergencia, P.sp_emergencia_min, sp);
    }
    else if (horarioLaboral) { sp = P.sp_desocupado; en = true; R.setback++; }
    else {
        // noches, sábados y domingos: aire apagado (la zona sigue al clima exterior); sólo protección
        // por alta temperatura: arranca sobre t_prot_max y enfría hasta t_prot_retorno
        sp = P.t_prot_retorno;
        en = z.temp_c > P.t_prot_max || (!!z.hvac_enable && z.temp_c > P.t_prot_retorno);
        if (en) R.proteccion_alta++; else R.apagadas++;
    }
    let luces, equipos;
    if (ocup) {
        const luxDia = Math.max(z.lux - P.lux_artificial * z.luces_nivel, 0);
        luces = Math.min(Math.max((P.lux_objetivo - luxDia) / P.lux_artificial, 0.1), 1.0);
        luces = Math.round(Math.round(luces / 0.05) * 0.05 * 100) / 100;
        equipos = 1.0;
        if (luces < 1.0) R.luz_natural++;
    } else { luces = P.luces_desocupado; equipos = P.equipos_desocupado; R.standby++; }
    let vent = "dcv";
    // protección por baja temperatura (losa al terreno a 18 °C en el modelo E+): ventilador con aire exterior
    if (z.temp_c < P.confort_min + 1.0) { en = true; vent = "fija"; R.proteccion_baja++; }
    if (emergencia) {
        // iluminación limitada y terminales de pasillo apagados
        luces = Math.min(luces, P.luces_emergencia);
        if (P.sin_hvac_emergencia.includes(z.tipo)) en = false;
        R.emergencia++;
    }
    cmds[zid] = { hvac_enable: en, setpoint_c: sp, ventilacion: vent, luces_nivel: luces, equipos_nivel: equipos, hvac_mod: null };
}

// ---------------------------------------------------------------- toma de carga escalonada tras una transferencia
// al pasar a la planta de respaldo (o al volver a la red) todos los terminales se paran y el arranque
// escalonado los devuelve por turnos (misma lógica que Reglas._decidir)
{
    const modo = med.modo_energia || "red";
    R.rearranque = 0;
    if (st.modoPrev !== undefined && st.modoPrev !== null && modo !== st.modoPrev && (modo === "red" || modo === "generador")) {
        for (const zid of Object.keys(cmds)) {
            if (cmds[zid].hvac_enable) { cmds[zid].hvac_enable = false; R.rearranque++; }
        }
    }
    st.modoPrev = modo;
}

// ---------------------------------------------------------------- rampa de setpoint + arranque escalonado
// (misma lógica que Controlador._secuenciar en ems/control.py)
{
    const pasoC = P.rampa_sp_c_h * P.paso_min / 60;
    const nuevos = [];
    for (const zid of Object.keys(cmds)) {
        const z = zonas[zid], c = cmds[zid];
        if (!c.hvac_enable) continue;
        if (!z.hvac_enable && c.ventilacion !== "fija") nuevos.push({ zid, urg: z.temp_c - c.setpoint_c });
    }
    nuevos.sort((a, b) => (b.urg - a.urg) || (a.zid < b.zid ? -1 : a.zid > b.zid ? 1 : 0));
    const espera = {};
    if (P.arranques_max > 0) for (const n of nuevos.slice(P.arranques_max)) espera[n.zid] = true;
    let nRampa = 0;
    for (const zid of Object.keys(cmds)) {
        const z = zonas[zid], c = cmds[zid];
        if (espera[zid]) { c.hvac_enable = false; continue; }
        if (pasoC <= 0 || !c.hvac_enable) continue;
        const objetivo = c.setpoint_c;
        const previo = z.hvac_enable ? z.setpoint_c : Math.max(objetivo, Math.min(z.temp_c, 30));
        c.setpoint_c = Math.round((previo + Math.max(-pasoC, Math.min(pasoC, objetivo - previo))) * 100) / 100;
        if (Math.abs(c.setpoint_c - objetivo) > 1e-6) nRampa++;
    }
    R.rampa_setpoint = nRampa;
    R.arranque_espera = Object.keys(espera).length;
    R.arranques = nuevos.length - R.arranque_espera;
}

// ---------------------------------------------------------------- overrides del operador (prioridad sobre las reglas)
const ovs = flow.get("overrides") || {};
const manual = {};
for (const zid of Object.keys(ovs)) {
    const o = ovs[zid];
    if (!o || o.hasta <= Date.now()) { delete ovs[zid]; continue; }
    if (!cmds[zid]) continue; // zonas críticas o sin telemetría
    manual[zid] = true;
    // en emergencia nadie puede pedir más frío que el mínimo (protege la planta)
    if (o.setpoint_c !== undefined) { cmds[zid].setpoint_c = emergencia ? Math.max(o.setpoint_c, P.sp_emergencia_min) : o.setpoint_c; cmds[zid].hvac_enable = true; }
    if (o.hvac_enable !== undefined) cmds[zid].hvac_enable = o.hvac_enable;
    if (o.luces_nivel !== undefined) cmds[zid].luces_nivel = o.luces_nivel;
    if (o.equipos_nivel !== undefined) cmds[zid].equipos_nivel = o.equipos_nivel;
}
flow.set("overrides", ovs);

// ---------------------------------------------------------------- limitador de demanda (rotación de compresores)
let pCompActual = 0;
let reservado = 0;
const sol = [];
for (const zid of Object.keys(cmds)) {
    const z = zonas[zid], c = cmds[zid];
    if (invalidos[zid]) continue;
    const [cap, copN, fanKw] = HVAC[zid] || [20, 3.0, 0];
    const cop = Math.max(copN * (1 - 0.012 * (med.t_ext_c - 30)), 1);
    const fan = z.hvac_enable && (z.ocupado || z.hvac_on) ? fanKw : 0;
    if (z.hvac_on) pCompActual += Math.max(z.p_hvac_kw - fan, 0);
    if (!c.hvac_enable) continue;
    const pideManual = z.temp_c > c.setpoint_c + P.banda || (z.hvac_on && z.temp_c > c.setpoint_c - P.banda);
    if (manual[zid]) { if (pideManual) reservado += fraccionCarga(z.temp_c, c.setpoint_c) * cap / cop; continue; } // el operador manda
    const pide = z.temp_c > c.setpoint_c + P.banda || (z.hvac_on && z.temp_c > c.setpoint_c - P.banda);
    // el confort sólo tiene prioridad sobre el límite donde hay gente
    if (pide) sol.push({ zid, urg: z.temp_c - c.setpoint_c, kw: fraccionCarga(z.temp_c, c.setpoint_c) * cap / cop,
        emerg: !!z.ocupado && z.temp_c > P.confort_max - P.dr_margen_confort, enMarcha: !!z.hvac_on });
}
// antes de abrir no hay prisa: el pre-enfriamiento se reparte bajo un tope de potencia
const limiteNormal = (antesDeEntrada && P.limite_precool_kw) ? Math.min(P.limite_kw, P.limite_precool_kw) : P.limite_kw;
const limite = emergencia ? P.gen_kw * P.gen_carga_max : limiteNormal;
const pMedida = emergencia ? (med.p_gen_kw ?? med.p_total_kw) : (med.p_red_kw ?? med.p_total_kw);
let presupuesto = limite - 3 - (pMedida - pCompActual) - reservado;
let forzadas = 0;
// orden: confort con gente, luego los compresores en marcha (terminan antes de ceder el turno) y por urgencia
sol.sort((a, b) => (a.emerg !== b.emerg ? (a.emerg ? -1 : 1) : a.enMarcha !== b.enMarcha ? (a.enMarcha ? -1 : 1)
    : (b.urg - a.urg) || (a.zid < b.zid ? -1 : a.zid > b.zid ? 1 : 0)));
for (const s of sol) {
    if (s.emerg || s.kw <= presupuesto) { presupuesto -= s.kw; continue; }
    cmds[s.zid].hvac_mod = 0.0;
    forzadas++;
}
const dem = emergencia ? med.p_gen_kw : med.demanda_15min_kw;
if (dem > limite) { st.drEtapa = 2; st.drCont = 0; }
else if (st.drEtapa === 2 && dem < limite - P.dr_hist_kw) { st.drCont++; if (st.drCont >= 3) { st.drEtapa = 0; st.drCont = 0; } }
if (st.drEtapa < 2) st.drEtapa = forzadas ? 1 : 0;
R.rotacion_compresores = forzadas;
R.dr_etapa = st.drEtapa;
if (st.drEtapa >= 2) {
    for (const zid of Object.keys(cmds)) {
        if (manual[zid]) continue;
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
        emergencia: emergencia,
        modo_seguro: Object.keys(invalidos), manual: Object.keys(manual), latencia_ms: Date.now() - tInicio, zonas_forzadas: forzadas,
        reglas: R
    }
};
flow.set("st", st);
const salidaAl = alarmas.map(a => ({ topic: `${base}/alarma`, payload: a }));
return [salidaCmd, estado, salidaAl];
