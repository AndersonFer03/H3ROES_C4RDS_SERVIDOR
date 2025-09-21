const WebSocket = require("ws");
const { deepClone, compare, delta, distTo34 } = require("./utils");
const {
  rooms,
  broadcast,
  logAndBroadcast,
  playersCount,
  bothPlayersReady,
  createRoom,
  findAvailableRoom,
  resetRound,
} = require("./game");

const wss = new WebSocket.Server({ port: 8080 });
console.log("🚀 Servidor corriendo en ws://localhost:8080");

wss.on("connection", (ws) => {
  console.log("✅ Cliente conectado");
  ws.isAlive = true;
  ws.roomId = null;
  ws.side = null;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { console.error("❌ Error al parsear:", raw); return; }

    if (data.type === "join") {
      const roomId = findAvailableRoom(data.roomId);
      const room = rooms[roomId];
      let side = !room.players.p1 ? "p1" : "p2";
      room.players[side] = ws;
      ws.roomId = roomId; ws.side = side;
      logAndBroadcast(roomId, `🙋 ${side} se unió a la sala ${roomId}`);

      ws.send(JSON.stringify({ type: "joined", side, roomId }));
      ws.send(JSON.stringify({ type: "round_started", gameState: deepClone(room.state) }));
      if (bothPlayersReady(room)) {
        logAndBroadcast(roomId, "🤝 Ambos jugadores listos");
        broadcast(roomId, { type: "both_ready", gameState: deepClone(room.state) });
      }
      return;
    }

    if (!ws.roomId || !ws.side) return;
    const room = rooms[ws.roomId];
    if (!room) return;

    if (data.type === "decide_card") {
      if (room.state.phase !== "decide_start" || !bothPlayersReady(room)) return;
      const { cardId } = data;
      const side = ws.side;
      const card = room.state.cards[side].find(c => c.id === cardId);
      if (!card || card.locked || room.state.decider[side]) return;

      card.revealed = true; 
      card.locked = true;
      room.state.decider[side] = { id: card.id, face: card.face };

      logAndBroadcast(ws.roomId, `🃏 ${side} eligió ${card.face} (${card.id})`);

      if (room.state.decider.p1 && room.state.decider.p2) {
        const a = Number(room.state.decider.p1.face);
        const b = Number(room.state.decider.p2.face);
        let starter = a > b ? "p1" : b > a ? "p2" : (Math.random() < 0.5 ? "p1" : "p2");

        room.state.turnOwner = starter;
        room.state.phase = "play";
        room.state.remainingPairs--; 

        const snapshot = deepClone(room.state);

        logAndBroadcast(ws.roomId, `🎲 Compara inicio: p1=${a}, p2=${b} → empieza ${starter}`);
        logAndBroadcast(ws.roomId, `📉 Se descuenta el par inicial, quedan ${room.state.remainingPairs} pares`);

        broadcast(ws.roomId, { type: "start_decided", gameState: snapshot });

        room.state.decider = {};
      } else {
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
      }
      return;
    }

    if (data.type === "play_card") {
      if (room.state.phase !== "play" || !bothPlayersReady(room)) return;
      const side = ws.side;
      if (room.state.turnOwner !== side && !room.state.pending) return;
      const { cardId } = data;

      if (!room.state.pending) {
        const card = room.state.cards[side].find(c => c.id === cardId);
        if (!card || card.locked) return;
        card.revealed = true;

        room.state.pending = { side, cardId: card.id, face: card.face };
        room.state.decider[side] = { id: card.id, face: card.face };

        logAndBroadcast(ws.roomId, `👉 ${side} juega ${card.face} (${card.id}), esperando rival`);
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
      } else {
        const enemy = side === "p1" ? "p2" : "p1";
        const card = room.state.cards[enemy].find(c => c.id === cardId);
        if (!card || card.locked) return;
        card.revealed = true;

        const a = Number(room.state.pending.face);
        const b = Number(card.face);
        const cmp = compare(a, b);
        const d = delta(a, b);

        if (cmp === 1) {
          room.state.roundScore[room.state.pending.side] += d;
          logAndBroadcast(ws.roomId, `⚔️ ${room.state.pending.side} gana (${a} vs ${b}), +${d}`);
        } else if (cmp === -1) {
          room.state.roundScore[enemy] += d;
          logAndBroadcast(ws.roomId, `⚔️ ${enemy} gana (${b} vs ${a}), +${d}`);
        } else {
          logAndBroadcast(ws.roomId, `🤝 Empate (${a} vs ${b})`);
        }

        room.state.decider[room.state.pending.side] = { id: room.state.pending.cardId, face: room.state.pending.face };
        room.state.decider[enemy] = { id: card.id, face: card.face };

        const ownCard = room.state.cards[room.state.pending.side].find(c => c.id === room.state.pending.cardId);
        if (ownCard) ownCard.locked = true;
        card.locked = true;

        room.state.remainingPairs--;
        room.state.turnOwner = enemy;
        room.state.pending = null;

        logAndBroadcast(ws.roomId, `🔄 Turno pasa a ${enemy}, quedan ${room.state.remainingPairs} pares`);

        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });

        room.state.decider = {};

        if (room.state.remainingPairs === 0) {
          room.state.phase = "decide_start";
          const d1 = distTo34(room.state.roundScore.p1);
          const d2 = distTo34(room.state.roundScore.p2);
          if (d1 < d2) room.state.credits.p1 += room.state.bets.p1;
          else if (d2 < d1) room.state.credits.p2 += room.state.bets.p2;

          logAndBroadcast(ws.roomId, `🏁 Fin de ronda ${room.state.roundIndex}`);
          logAndBroadcast(ws.roomId, `   Puntuación: ${JSON.stringify(room.state.roundScore)}`);
          logAndBroadcast(ws.roomId, `   Créditos: ${JSON.stringify(room.state.credits)}`);

          broadcast(ws.roomId, { type: "round_finished", gameState: deepClone(room.state) });
          resetRound(room);
          logAndBroadcast(ws.roomId, `🔄 Nueva ronda iniciada (#${room.state.roundIndex})`);
          broadcast(ws.roomId, { type: "round_started", gameState: deepClone(room.state) });
        }
      }
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
  });

  ws.on("close", () => {
    const { roomId, side } = ws;
    console.log("❌ Cliente desconectado", roomId ? `(${roomId}/${side})` : "");
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.players[side] === ws) room.players[side] = null;
    if (playersCount(room) === 0) {
      delete rooms[roomId];
      console.log(`🧹 Sala ${roomId} eliminada (vacía)`);
    } else {
      room.state.phase = "waiting";
      room.state.turnOwner = null;
      room.state.pending = null;
      broadcast(roomId, { type: "player_left", gameState: deepClone(room.state) });
    }
  });

  ws.on("error", (err) => console.error("⚠️ WS error:", err?.message || err));
});

const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  });
}, 15000);

wss.on("close", () => clearInterval(interval));
