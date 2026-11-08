// Nodo función "Comando HTTP del panel" — entrada: POST /ems/control (http in)
// Valida el comando del panel de Grafana y lo publica por MQTT.
// Salida 1: override/liberar → ems/<edif>/ems/override; evento simulado → ems/<edif>/sim/control
// Salida 2: parámetros       → ems/<edif>/ems/parametros
// Salida 3: respuesta HTTP (con CORS)
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
const zonaValida = (z) => /^Z(0[1-9]|10)$/.test(z || "");
if (b.tipo === "override") {
    if (!zonaValida(b.zona) || ["Z09", "Z10"].includes(b.zona)) {
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
    if (typeof b.limite_kw === "number" && b.limite_kw >= 10 && b.limite_kw <= 100) p.limite_kw = b.limite_kw;
    if (typeof b.sp_ocupado === "number" && b.sp_ocupado >= 20 && b.sp_ocupado <= 28) p.sp_ocupado = b.sp_ocupado;
    if (!Object.keys(p).length) return [null, null, responder(400, { ok: false, mensaje: "Parámetros inválidos" })];
    return [null, { topic: `${base}/ems/parametros`, payload: p }, responder(200, { ok: true, mensaje: "parámetros publicados", parametros: p })];
}
if (b.tipo === "ocupacion") {
    // escenario de simulación: personas fijas en una zona o % del horario en todo el edificio ('*')
    const zona = b.zona;
    if (zona !== "*" && (!zonaValida(zona) || ["Z08", "Z09", "Z10"].includes(zona))) {
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
    if (b.unidad !== undefined && !/^VRF-[ABC]$/.test(b.unidad)) return [null, null, responder(400, { ok: false, mensaje: "Unidad inválida" })];
    const dur = Number(b.duracion_min);
    if (!(dur > 0 && dur <= 10080)) return [null, null, responder(400, { ok: false, mensaje: "Duración inválida" })];
    const ev = { accion: "evento", operacion: "iniciar", id: String(b.id || `${b.evento}-${Date.now()}`), evento: b.evento,
        duracion_min: dur, usuario: b.usuario || "" };
    for (const k of ["zona", "unidad", "intensidad"]) if (b[k] !== undefined && b[k] !== null) ev[k] = b[k];
    return [{ topic: `${base}/sim/control`, payload: ev }, null, responder(200, { ok: true, mensaje: "evento publicado", id: ev.id })];
}
return [null, null, responder(400, { ok: false, mensaje: "tipo debe ser override, liberar, parametros, evento u ocupacion" })];
