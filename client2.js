const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:8080");

ws.on("open", () => {
  console.log("Cliente 2 conectado al servidor");
  ws.send(JSON.stringify({ type: "join" }));
});

ws.on("message", (msg) => {
  const data = JSON.parse(msg);
  console.log("Cliente2 recibió:", data);

  if (data.type === "round_started") {
    const card = data.gameState.cards.p2[0];
    console.log("Cliente2 elige carta:", card);
    ws.send(
      JSON.stringify({
        type: "play_card",
        roomId: data.roomId,
        side: "p2",
        cardId: card.id
      })
    );
  }
});
