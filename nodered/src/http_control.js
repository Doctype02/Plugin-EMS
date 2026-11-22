// Nodo función "Comando HTTP del panel" — entrada: POST /ems/control (http in)
// Valida el comando del panel de Grafana y lo publica por MQTT.
// Salida 1: override/liberar → ems/<edif>/ems/override; evento, ocupación, unidad y sensor → ems/<edif>/sim/control
// Salida 2: parámetros       → ems/<edif>/ems/parametros
// Salida 3: respuesta HTTP (con CORS)
// Cada orden (aceptada o rechazada) deja además un registro de auditoría en ems/<edif>/auditoria (salida 1).
const edif = env.get("EMS_EDIFICIO") || "edificio1";
const base = "ems/" + edif;
const b = (typeof msg.payload === "string" ? JSON.parse(msg.payload || "{}") : msg.payload) || {};
const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
};
function responder(code, cuerpo) {
    return { req: msg.req, res: msg.res, statusCode: code, headers: cors, payload: JSON.stringify(cuerpo) };
}
function procesar() {
// Listas generadas desde config/edificio.yaml por build_flows.py
const ZONAS = /*@ZONAS@*/["Z01", "Z02", "Z03", "Z04", "Z05", "Z06", "Z07", "Z08", "Z09", "Z10", "Z11", "Z12", "Z13", "Z14", "Z15", "Z16", "Z17", "Z18", "Z19", "Z20", "Z21", "Z22", "Z23", "Z24", "Z25", "Z26"]/*@FIN@*/;
const CRITICAS = /*@CRITICAS@*/["Z06"]/*@FIN@*/;
const SIN_PERSONAS = /*@SIN_PERSONAS@*/["Z06"]/*@FIN@*/;
const UNIDADES = /*@UNIDADES@*/["VRF-PB", "VRF-P1", "VRF-P2", "VRF-P3", "VRF-P4", "VRF-SRV", "PTAC-PB", "PTAC-P1", "PTAC-P2", "PTAC-P3", "PTAC-P4"]/*@FIN@*/;
const UNIDADES_CRITICAS = /*@UNIDADES_CRITICAS@*/["VRF-SRV"]/*@FIN@*/;
const LIMITE_KW = /*@LIMITE_KW@*/[22, 297]/*@FIN@*/;
const zonaValida = (z) => ZONAS.includes(z);
if (b.tipo === "override") {
    if (!zonaValida(b.zona) || CRITICAS.includes(b.zona)) {
        return [null, null, responder(400, { ok: false, mensaje: `Zona ${b.zona} no admite control manual` })];
    }
    const campos = ["setpoint_c", "hvac_enable", "luces_nivel", "equipos_nivel"].filter((k) => b[k] !== undefined);
    if (!campos.length) return [null, null, responder(400, { ok: false, mensaje: "Sin cambios" })];
    const out = { zona: b.zona, duracion_min: b.duracion_min || 60, usuario: b.usuario || "" };
    for (const k of campos) out[k] = b[k];
    return [{ topic: `${base}/ems/override`, payload: out }, null, responder(200, { ok: true, mensaje: "override publicado", campos })];
}
if (b.tipo === "liberar") {
    if (b.zona !== "*" && !zonaValida(b.zona)) return [null, null, responder(400, { ok: false, mensaje: "Zona inválida" })];
    return [{ topic: `${base}/ems/override`, payload: { tipo: "liberar", zona: b.zona, usuario: b.usuario || "" } }, null, responder(200, { ok: true, mensaje: "liberado" })];
}
if (b.tipo === "parametros") {
    const p = {};
    if (typeof b.limite_kw === "number" && b.limite_kw >= LIMITE_KW[0] && b.limite_kw <= LIMITE_KW[1]) p.limite_kw = b.limite_kw;
    if (typeof b.sp_ocupado === "number" && b.sp_ocupado >= 20 && b.sp_ocupado <= 28) p.sp_ocupado = b.sp_ocupado;
    if (!Object.keys(p).length) return [null, null, responder(400, { ok: false, mensaje: "Parámetros inválidos" })];
    return [null, { topic: `${base}/ems/parametros`, payload: p }, responder(200, { ok: true, mensaje: "parámetros publicados", parametros: p })];
}
if (b.tipo === "ocupacion") {
    // escenario de simulación: personas fijas en una zona o % del horario en todo el edificio ('*')
    const zona = b.zona;
    if (zona !== "*" && (!zonaValida(zona) || SIN_PERSONAS.includes(zona))) {
        return [null, null, responder(400, { ok: false, mensaje: `Zona ${zona} no admite fijar personas` })];
    }
    const p = { accion: "ocupacion", zona, usuario: b.usuario || "" };
    if (b.liberar) {
        p.liberar = true;
    } else {
        const dur = Number(b.duracion_min);
        if (!(dur > 0 && dur <= 10080)) return [null, null, responder(400, { ok: false, mensaje: "Duración inválida" })];
        p.duracion_min = dur;
        if (zona === "*") {
            if (!(typeof b.porcentaje === "number" && b.porcentaje >= 0 && b.porcentaje <= 200)) {
                return [null, null, responder(400, { ok: false, mensaje: "Porcentaje entre 0 y 200" })];
            }
            p.porcentaje = b.porcentaje;
        } else {
            if (!(Number.isInteger(b.personas) && b.personas >= 0 && b.personas <= 100)) {
                return [null, null, responder(400, { ok: false, mensaje: "Personas inválidas" })];
            }
            p.personas = b.personas;
        }
    }
    return [{ topic: `${base}/sim/control`, payload: p }, null, responder(200, { ok: true, mensaje: "ocupación publicada" })];
}
if (b.tipo === "evento") {
    // simulación de fallas y accidentes en el gemelo digital (ems/eventos.py)
    const tipos = ["incendio", "corte_energia", "falla_vrf", "falla_terminal", "puerta_abierta", "sensor",
        "ola_calor", "sobreocupacion", "pico_carga"];
    if (b.accion === "detener") {
        return [{ topic: `${base}/sim/control`, payload: { accion: "evento", operacion: "detener", id: String(b.id || "*") } },
            null, responder(200, { ok: true, mensaje: "evento detenido" })];
    }
    if (!tipos.includes(b.evento)) return [null, null, responder(400, { ok: false, mensaje: `Evento desconocido: ${b.evento}` })];
    if (b.zona !== undefined && !zonaValida(b.zona)) return [null, null, responder(400, { ok: false, mensaje: "Zona inválida" })];
    if (b.unidad !== undefined && !UNIDADES.includes(b.unidad)) return [null, null, responder(400, { ok: false, mensaje: "Unidad inválida" })];
    const dur = Number(b.duracion_min);
    if (!(dur > 0 && dur <= 10080)) return [null, null, responder(400, { ok: false, mensaje: "Duración inválida" })];
    const ev = { accion: "evento", operacion: "iniciar", id: String(b.id || `${b.evento}-${Date.now()}`), evento: b.evento,
        duracion_min: dur, usuario: b.usuario || "" };
    for (const k of ["zona", "unidad", "intensidad"]) if (b[k] !== undefined && b[k] !== null) ev[k] = b[k];
    return [{ topic: `${base}/sim/control`, payload: ev }, null, responder(200, { ok: true, mensaje: "evento publicado", id: ev.id })];
}
// ---------------------------------------------------------------- controladores (ems/controladores.py)
const enRango = (v, a, z) => typeof v === "number" && isFinite(v) && v >= a && v <= z;
const malo = (mensaje) => [null, null, responder(400, { ok: false, mensaje })];
/** duracion_min es opcional (sin ella el ajuste dura hasta «liberar»); devuelve [valor, error]. */
function duracion(v) {
    if (v === undefined || v === null) return [undefined, null];
    return enRango(v, 1e-9, 10080) ? [v, null] : [undefined, "Duración inválida (hasta 10080 min, u omitida)"];
}
if (b.tipo === "unidad") {
    // ajuste del controlador local de una unidad VRF/PTAC: encendido, modo, capacidad, setpoint, COP
    const u = b.unidad;
    if (b.liberar) {
        if (u !== "*" && !UNIDADES.includes(u)) return malo(`Unidad inválida: ${u}`);
        return [{ topic: `${base}/sim/control`, payload: { accion: "unidad", unidad: u, liberar: true, usuario: b.usuario || "" } },
            null, responder(200, { ok: true, mensaje: "unidad liberada" })];
    }
    if (!UNIDADES.includes(u)) return malo(`Unidad inválida: ${u}`);
    const p = { accion: "unidad", unidad: u, usuario: b.usuario || "" };
    if (b.encendido !== undefined && b.encendido !== null) {
        if (typeof b.encendido !== "boolean") return malo("encendido debe ser true o false");
        p.encendido = b.encendido;
    }
    if (b.modo !== undefined && b.modo !== null) {
        if (!["auto", "frio", "ventilacion"].includes(b.modo)) return malo("modo debe ser auto, frio o ventilacion");
        p.modo = b.modo;
    }
    const rangos = { capacidad_pct: [0, 100], setpoint_c: [18, 30], cop_factor: [0.5, 1.2] };
    for (const k of Object.keys(rangos)) {
        if (b[k] === undefined || b[k] === null) continue;
        if (!enRango(b[k], rangos[k][0], rangos[k][1])) return malo(`${k} fuera de rango (${rangos[k][0]}–${rangos[k][1]})`);
        p[k] = b[k];
    }
    if (Object.keys(p).length === 3) return malo("Sin cambios");
    if (UNIDADES_CRITICAS.includes(u) && b.confirmar !== true) {
        return [null, null, responder(409, { ok: false, requiere_confirmar: true, mensaje: `${u} atiende una zona crítica: envíe confirmar: true` })];
    }
    const [dur, err] = duracion(b.duracion_min);
    if (err) return malo(err);
    if (dur !== undefined) p.duracion_min = dur;
    if (b.confirmar === true) p.confirmar = true;
    return [{ topic: `${base}/sim/control`, payload: p }, null, responder(200, { ok: true, mensaje: "ajuste de unidad publicado" })];
}
if (b.tipo === "sensor") {
    // datos que lee el controlador de la zona (la física no cambia): offset o valor fijo, HR, presencia, congelado
    const z = b.zona;
    if (b.liberar) {
        if (z !== "*" && !zonaValida(z)) return malo("Zona inválida");
        return [{ topic: `${base}/sim/control`, payload: { accion: "sensor", zona: z, liberar: true, usuario: b.usuario || "" } },
            null, responder(200, { ok: true, mensaje: "sensor liberado" })];
    }
    if (!zonaValida(z)) return malo("Zona inválida");
    const p = { accion: "sensor", zona: z, usuario: b.usuario || "" };
    if (b.temp_offset_c != null && b.temp_c != null) return malo("Use temp_offset_c o temp_c, no ambos");
    const rangos = { temp_offset_c: [-10, 10], temp_c: [5, 50], hr_pct: [0, 100] };
    for (const k of Object.keys(rangos)) {
        if (b[k] === undefined || b[k] === null) continue;
        if (!enRango(b[k], rangos[k][0], rangos[k][1])) return malo(`${k} fuera de rango (${rangos[k][0]}–${rangos[k][1]})`);
        p[k] = b[k];
    }
    for (const k of ["presencia", "congelado"]) {
        if (b[k] === undefined || b[k] === null) continue;
        if (typeof b[k] !== "boolean") return malo(`${k} debe ser true o false`);
        if (k === "congelado" && !b[k]) continue;
        p[k] = b[k];
    }
    if (Object.keys(p).length === 3) return malo("Sin cambios");
    if (CRITICAS.includes(z) && b.confirmar !== true) {
        return [null, null, responder(409, { ok: false, requiere_confirmar: true, mensaje: `${z} es una zona crítica: envíe confirmar: true` })];
    }
    const [dur, err] = duracion(b.duracion_min);
    if (err) return malo(err);
    if (dur !== undefined) p.duracion_min = dur;
    if (b.confirmar === true) p.confirmar = true;
    return [{ topic: `${base}/sim/control`, payload: p }, null, responder(200, { ok: true, mensaje: "sensor forzado publicado" })];
}
return [null, null, responder(400, { ok: false, mensaje: "tipo debe ser override, liberar, parametros, evento, ocupacion, unidad o sensor" })];
}
const salida = procesar();
// ---------------------------------------------------------------- auditoría: quién ordenó qué y con qué resultado
const resp = salida[2];
const auditoria = {
    topic: `${base}/auditoria`,
    payload: {
        ts: new Date().toISOString(), tipo: String(b.tipo || "?"), usuario: String(b.usuario || ""),
        objetivo: String(b.zona || b.unidad || b.evento || ""), ok: resp.statusCode === 200, codigo: resp.statusCode,
        ip: (msg.req && msg.req.headers && (msg.req.headers["x-forwarded-for"] || "")) || "",
        detalle: JSON.stringify(b).slice(0, 300)
    }
};
salida[0] = salida[0] ? [salida[0], auditoria] : auditoria;
return salida;
