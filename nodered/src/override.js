// Nodo función "Guardar override del operador" — entrada: ems/<edif>/ems/override
// payload: {zona, setpoint_c?, hvac_enable?, luces_nivel?, equipos_nivel?, duracion_min?, usuario?}
//          {tipo: "liberar", zona: "Z03" | "*"}
// Las zonas críticas no admiten control manual (listas generadas desde config/edificio.yaml por build_flows.py).
const ZONAS = /*@ZONAS@*/["Z01", "Z02", "Z03", "Z04", "Z05", "Z06", "Z07", "Z08", "Z09", "Z10", "Z11", "Z12", "Z13", "Z14", "Z15", "Z16", "Z17", "Z18", "Z19", "Z20", "Z21", "Z22", "Z23", "Z24", "Z25", "Z26"]/*@FIN@*/;
const CRITICAS = /*@CRITICAS@*/["Z06"]/*@FIN@*/;
const p = msg.payload || {};
const ovs = flow.get("overrides") || {};
const ahora = Date.now();
if (p.tipo === "liberar") {
    if (p.zona === "*") {
        for (const k of Object.keys(ovs)) delete ovs[k];
    } else {
        delete ovs[p.zona];
    }
} else {
    if (!ZONAS.includes(p.zona) || CRITICAS.includes(p.zona)) {
        node.warn(`override rechazado para ${p.zona}`);
        return null;
    }
    const o = { desde: ahora, hasta: ahora + Math.min(Math.max(Number(p.duracion_min) || 60, 1), 1440) * 60000, usuario: p.usuario || "" };
    if (typeof p.setpoint_c === "number") o.setpoint_c = Math.min(Math.max(p.setpoint_c, 20), 28);
    if (typeof p.hvac_enable === "boolean") o.hvac_enable = p.hvac_enable;
    if (typeof p.luces_nivel === "number") o.luces_nivel = Math.min(Math.max(p.luces_nivel, 0), 1);
    if (typeof p.equipos_nivel === "number") o.equipos_nivel = Math.min(Math.max(p.equipos_nivel, 0), 1);
    ovs[p.zona] = o;
}
flow.set("overrides", ovs);
node.status({ fill: Object.keys(ovs).length ? "yellow" : "green", shape: "dot", text: `manual: ${Object.keys(ovs).join(", ") || "ninguna"}` });
msg.payload = ovs;
return msg;
