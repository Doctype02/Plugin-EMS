// Arnés para ejecutar las funciones de Node-RED fuera de Node-RED (pruebas de paridad con Python).
// Protocolo: una línea JSON por mensaje en stdin -> una línea JSON en stdout.
//   {"tipo":"zona","payload":{...}}       -> {"ok":true}
//   {"tipo":"medidor","payload":{...}}    -> {"cmds":[...], "estado":{...}, "alarmas":[...]}
//   {"tipo":"parametros","payload":{...}} -> {"ok":true}
//   {"tipo":"override","payload":{...}}   -> {"overrides":{...}}
//   {"tipo":"http","payload":{...}}       -> {"mqtt":..., "parametros":..., "status":200, ...}
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const src = (f) => fs.readFileSync(path.join(__dirname, "src", f), "utf8");
const ctx = {};
const flow = { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } };
const env = { get: (k) => process.env[k] };
const node = { status: () => {}, warn: (m) => process.stderr.write(String(m) + "\n"), error: (m) => process.stderr.write(String(m) + "\n") };
const mk = (code) => new Function("msg", "flow", "env", "node", code);
const fZona = mk(src("estado_zona.js"));
const fEms = mk(src("ems_reglas.js"));
const fPar = mk(src("parametros.js"));
const fOverride = mk(src("override.js"));
const fHttp = mk(src("http_control.js"));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    let out = { ok: true };
    if (m.tipo === "zona") fZona({ payload: m.payload }, flow, env, node);
    else if (m.tipo === "parametros") fPar({ payload: m.payload }, flow, env, node);
    else if (m.tipo === "override") out = { overrides: (fOverride({ payload: m.payload }, flow, env, node) || {}).payload || null };
    else if (m.tipo === "http") {
        const [mq, par, res] = fHttp({ payload: m.payload, req: {}, res: {} }, flow, env, node);
        out = { mqtt: mq && { topic: mq.topic, payload: mq.payload }, parametros: par && { topic: par.topic, payload: par.payload }, status: res.statusCode, cuerpo: JSON.parse(res.payload), cors: res.headers["Access-Control-Allow-Origin"] };
    }
    else if (m.tipo === "medidor") {
        const [cmds, estado, alarmas] = fEms({ payload: m.payload }, flow, env, node);
        out = { cmds: cmds.map((c) => ({ zona: c.topic.split("/")[3], ...c.payload })), estado: estado.payload, alarmas: alarmas.map((a) => a.payload) };
    }
    process.stdout.write(JSON.stringify(out) + "\n");
});
