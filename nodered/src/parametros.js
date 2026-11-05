// Nodo función "Cambiar parámetros EMS" — entrada: inject o ems/<edif>/ems/parametros
// payload ej.: {"limite_kw": 135, "sp_ocupado": 24.5}. Permite variar parámetros en vivo (demo).
const actual = flow.get("parametros") || {};
const nuevos = Object.assign({}, actual, msg.payload || {});
flow.set("parametros", nuevos);
node.status({ fill: "green", shape: "dot", text: JSON.stringify(nuevos).slice(0, 60) });
msg.payload = nuevos;
return msg;
