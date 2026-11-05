// Nodo función "Comando HTTP del panel" — entrada: POST /ems/control (http in)
// Valida el comando del panel de Grafana y lo publica por MQTT.
// Salida 1: override/liberar → ems/<edif>/ems/override
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
    if (typeof b.limite_kw === "number" && b.limite_kw >= 50 && b.limite_kw <= 400) p.limite_kw = b.limite_kw;
    if (typeof b.sp_ocupado === "number" && b.sp_ocupado >= 20 && b.sp_ocupado <= 28) p.sp_ocupado = b.sp_ocupado;
    if (!Object.keys(p).length) return [null, null, responder(400, { ok: false, mensaje: "Parámetros inválidos" })];
    return [null, { topic: `${base}/ems/parametros`, payload: p }, responder(200, { ok: true, mensaje: "parámetros publicados", parametros: p })];
}
return [null, null, responder(400, { ok: false, mensaje: "tipo debe ser override, liberar o parametros" })];
