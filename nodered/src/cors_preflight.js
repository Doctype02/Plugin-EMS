// Nodo función "CORS preflight" — entrada: OPTIONS /ems/control
msg.statusCode = 204;
msg.headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600"
};
msg.payload = "";
return msg;
