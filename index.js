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

function getCardValue(card) {
  if (!card) return 0;
  if (card.face === "0") return Number(card.jokerValue) || 0;
  return Number(card.face) || 0;
}

function playedCardPayload(card) {
  if (!card) return null;
  return {
    id: card.id,
    face: card.face,
    jokerValue: card.jokerValue || null,
    displayFace: card.face === "0" ? "joker" : card.face
  };
}

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
      const side = !room.players.p1 ? "p1" : "p2";
      room.players[side] = ws;
      ws.roomId = roomId;
      ws.side = side;

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

    // --- DECIDE STARTER ---
    if (data.type === "decide_card") {
      if (room.state.phase !== "decide_start" || !bothPlayersReady(room)) return;

      const side = ws.side;
      const { cardId } = data;
      const card = room.state.cards[side].find(c => c.id === cardId);
      if (!card || card.locked || room.state.decider[side]) return;

      card.revealed = true;
      card.locked = true;

      room.state.decider[side] = playedCardPayload(card);

      const shown = (card.face === "0") ? `JOKER(${card.jokerValue})` : card.face;
      logAndBroadcast(ws.roomId, `🃏 ${side} eligió ${shown} (${card.id})`);

      if (room.state.decider.p1 && room.state.decider.p2) {
        const valP1 = getCardValue(room.state.decider.p1);
        const valP2 = getCardValue(room.state.decider.p2);

        let starter = valP1 > valP2 ? "p1" : valP2 > valP1 ? "p2" : (Math.random() < 0.5 ? "p1" : "p2");
        room.state.turnOwner = starter;
        room.state.phase = "play";
        room.state.remainingPairs--;

        const snapshot = deepClone(room.state);
        logAndBroadcast(ws.roomId, `🎲 Compara inicio: p1=${valP1}, p2=${valP2} → empieza ${starter}`);
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
        const playedCard = room.state.cards[side].find(c => c.id === cardId);
        if (!playedCard || playedCard.locked) return;
        playedCard.revealed = true;

        const pendingPayload = playedCardPayload(playedCard);
        room.state.pending = { ...pendingPayload, side, cardId: playedCard.id };
        room.state.decider[side] = pendingPayload;

        if (playedCard.face === "67") {
          const enemy = side === "p1" ? "p2" : "p1";

          room.state.cards[enemy].forEach(c => {
            if (!c.locked && !c.revealed) c.tempRevealed = true;
          });
          room.state.effectOwner = side;

          logAndBroadcast(ws.roomId, `🃏 ${side} jugó Doctor Manhattan (${playedCard.id})`);
          logAndBroadcast(ws.roomId, "🕵️ Revela todas las cartas del rival por 5 segundos");

          broadcast(ws.roomId, { 
            type: "doctor_manhattan_reveal", 
            gameState: deepClone(room.state),
            effectOwner: side
          });

          setTimeout(() => {
            room.state.cards[enemy].forEach(c => { c.tempRevealed = false; });
            room.state.effectOwner = null;

            logAndBroadcast(ws.roomId, "🙈 Se ocultaron las cartas del rival otra vez");
            broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
          }, 5000);
        }

        const shown = (playedCard.face === "0") ? `JOKER(${playedCard.jokerValue})` : playedCard.face;
        logAndBroadcast(ws.roomId, `👉 ${side} juega ${shown} (${playedCard.id}), esperando rival`);

        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
        return;
      }

      const enemy = side === "p1" ? "p2" : "p1";
      const enemyCard = room.state.cards[enemy].find(c => c.id === cardId);
      if (!enemyCard || enemyCard.locked) return;
      enemyCard.revealed = true;

      room.state.decider[enemy] = playedCardPayload(enemyCard);

      const a = getCardValue(room.state.pending);
      const b = getCardValue(enemyCard);
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

      const ownCard = room.state.cards[room.state.pending.side].find(c => c.id === room.state.pending.cardId);
      if (ownCard) ownCard.locked = true;
      enemyCard.locked = true;

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
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

wss.on("close", () => clearInterval(interval));
