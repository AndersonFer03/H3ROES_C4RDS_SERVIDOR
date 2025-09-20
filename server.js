const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 3000 });

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    console.log("Recibido:", data);

    // reenviar a todos los demás
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    });
  });
});

console.log("WS conectado vía 3000");