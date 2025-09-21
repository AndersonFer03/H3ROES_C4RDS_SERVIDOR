const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080");

ws.on("open", () => {
  console.log("✅ Client2 conectado");
  ws.send(JSON.stringify({ type: "join", roomId: "demo-room" }));
});

ws.on("message", (msg) => {
  const data = JSON.parse(msg);
  console.log("📩 [Client2] Recibido:", data);
});
