const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080");

ws.on("open", () => {
  console.log("✅ Client1 conectado");
  ws.send(JSON.stringify({ type: "join", roomId: "demo-room" }));

  setTimeout(() => {
    console.log("🃏 Client1 juega carta 67");
    ws.send(JSON.stringify({ type: "play_card", cardId: "p1_card_0" }));
  }, 2000);
});

ws.on("message", (msg) => {
  const data = JSON.parse(msg);
  console.log("📩 [Client1] Recibido:", data);
});
