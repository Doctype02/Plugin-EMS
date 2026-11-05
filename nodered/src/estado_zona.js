// Nodo función "Guardar telemetría de zona" — entrada: ems/<edif>/zona/<Z>/telemetria
// Guarda el último valor por zona en el contexto del flujo para que la lógica EMS lo use.
const z = msg.payload;
if (!z || !z.zona) { return null; }
const zonas = flow.get("zonas") || {};
z._recibido = Date.now();
zonas[z.zona] = z;
flow.set("zonas", zonas);
return null;
