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
    displayFace: card.face === "0" ? "joker" : card.face,
  };
}

function printGameState(room, prefix = "") {
  const rs = room.state.roundScore;
  const cr = room.state.credits;
  console.log(
    `${prefix} 📊 Estado → P1: ${rs.p1} pts / ${cr.p1} créditos | P2: ${rs.p2} pts / ${cr.p2} créditos | Ronda: ${room.state.roundIndex}`
  );
}

const wss = new WebSocket.Server({ port: 8080 });
console.log("🚀 Servidor corriendo en ws://localhost:8080");

wss.on("connection", (ws) => {
  console.log("✅ Cliente conectado");
  ws.isAlive = true;
  ws.roomId = null;
  ws.side = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("❌ Error al parsear:", raw);
      return;
    }

    if (data.type === "join") {
      const roomId = findAvailableRoom(data.roomId);
      const room = rooms[roomId];
      const side = !room.players.p1 ? "p1" : "p2";
      room.players[side] = ws;
      ws.roomId = roomId;
      ws.side = side;

      logAndBroadcast(roomId, `🙋 ${side} se unió a la sala ${roomId}`);
      ws.send(JSON.stringify({ type: "joined", side, roomId }));
      ws.send(
        JSON.stringify({ type: "round_started", gameState: deepClone(room.state) })
      );

      if (bothPlayersReady(room)) {
        logAndBroadcast(roomId, "🤝 Ambos jugadores listos");
        broadcast(roomId, { type: "both_ready", gameState: deepClone(room.state) });
      }
      return;
    }

    if (!ws.roomId || !ws.side) return;
    const room = rooms[ws.roomId];
    if (!room) return;

    // Aplicar elección del ganador tras el duelo
    if (data.type === "apply_score") {
      const ps = room.state.pendingScore;
      if (!ps || !room.state.waitingScoreChoice) return;

      if (ws.side !== ps.winner) {
        logAndBroadcast(
          ws.roomId,
          `⛔ Solo ${ps.winner} puede aplicar la puntuación pendiente`
        );
        return;
      }

      if (data.mode === "sumar") {
        room.state.roundScore[ps.winner] += ps.diff;
        logAndBroadcast(ws.roomId, `➕ ${ps.winner} eligió SUMAR ${ps.diff}`);
      } else if (data.mode === "restar") {
        room.state.roundScore[ps.loser] -= ps.diff;
        logAndBroadcast(ws.roomId, `➖ ${ps.winner} eligió RESTAR ${ps.diff} a ${ps.loser}`);
      } else {
        return;
      }

      room.state.pendingScore = null;
      room.state.waitingScoreChoice = false;

      broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
      printGameState(room, "✅ Después de apply_score");

      if (room.state.remainingPairs === 0) {
        room.state.phase = "decide_start";
        const d1 = distTo34(room.state.roundScore.p1);
        const d2 = distTo34(room.state.roundScore.p2);
        if (d1 < d2) room.state.credits.p1 += room.state.bets.p1;
        else if (d2 < d1) room.state.credits.p2 += room.state.bets.p2;

        logAndBroadcast(ws.roomId, `🏁 Fin de ronda ${room.state.roundIndex}`);
        printGameState(room, "🏁 Fin de ronda");

        broadcast(ws.roomId, {
          type: "round_finished",
          gameState: deepClone(room.state),
        });

        resetRound(room);
        logAndBroadcast(ws.roomId, `🔄 Nueva ronda iniciada (#${room.state.roundIndex})`);
        broadcast(ws.roomId, {
          type: "round_started",
          gameState: deepClone(room.state),
        });
      }
      return;
    }

    if (data.type === "decide_card") {
      if (room.state.phase !== "decide_start" || !bothPlayersReady(room)) return;

      const side = ws.side;
      const { cardId } = data;
      const card = room.state.cards[side].find((c) => c.id === cardId);
      if (!card || card.locked || room.state.decider[side]) return;

      card.revealed = true;
      card.locked = true;

      room.state.decider[side] = playedCardPayload(card);

      const shown = card.face === "0" ? `JOKER(${card.jokerValue})` : card.face;
      logAndBroadcast(ws.roomId, `🃏 ${side} eligió ${shown} (${card.id})`);

      if (room.state.decider.p1 && room.state.decider.p2) {
        const valP1 = getCardValue(room.state.decider.p1);
        const valP2 = getCardValue(room.state.decider.p2);

        let starter =
          valP1 > valP2
            ? "p1"
            : valP2 > valP1
            ? "p2"
            : Math.random() < 0.5
            ? "p1"
            : "p2";

        room.state.turnOwner = starter;
        room.state.phase = "play";
        room.state.remainingPairs--;

        const snapshot = deepClone(room.state);
        logAndBroadcast(
          ws.roomId,
          `🎲 Compara inicio: p1=${valP1}, p2=${valP2} → empieza ${starter}`
        );
        logAndBroadcast(
          ws.roomId,
          `📉 Se descuenta el par inicial, quedan ${room.state.remainingPairs} pares`
        );

        broadcast(ws.roomId, { type: "start_decided", gameState: snapshot });
        room.state.decider = {};
      } else {
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
      }
      return;
    }

    if (data.type === "play_card") {
      if (room.state.phase !== "play" || !bothPlayersReady(room)) return;

      if (room.state.waitingScoreChoice) {
        logAndBroadcast(ws.roomId, "⏳ Esperando elección de puntaje del ganador...");
        return;
      }

      const side = ws.side;
      if (room.state.turnOwner !== side && !room.state.pending) return;

      const { cardId } = data;

      if (!room.state.pending) {
        const playedCard = room.state.cards[side].find((c) => c.id === cardId);
        if (!playedCard || playedCard.locked) return;
        playedCard.revealed = true;

        const pendingPayload = playedCardPayload(playedCard);
        room.state.pending = { ...pendingPayload, side, cardId: playedCard.id };
        room.state.decider[side] = pendingPayload;

        const shown = playedCard.face === "0" ? `JOKER(${playedCard.jokerValue})` : playedCard.face;
        logAndBroadcast(ws.roomId, `👉 ${side} juega ${shown} (${playedCard.id}), esperando rival`);

        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
        return;
      }

      const enemy = side === "p1" ? "p2" : "p1";
      const enemyCard = room.state.cards[enemy].find((c) => c.id === cardId);
      if (!enemyCard || enemyCard.locked) return;
      enemyCard.revealed = true;

      room.state.decider[enemy] = playedCardPayload(enemyCard);

      const a = getCardValue(room.state.pending);
      const b = getCardValue(enemyCard);
      const cmp = compare(a, b);
      const d = delta(a, b);

      const pendingOwner = room.state.pending.side;
      const ownCard = room.state.cards[pendingOwner].find(
        (c) => c.id === room.state.pending.cardId
      );
      if (ownCard) ownCard.locked = true;
      enemyCard.locked = true;

      room.state.remainingPairs--;
      room.state.turnOwner = enemy;
      room.state.pending = null;
      room.state.decider = {};

      if (cmp === 0) {
        logAndBroadcast(ws.roomId, `🤝 Duelo empatado (${a} vs ${b})`);
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
        return;
      }

      const winner = cmp === 1 ? pendingOwner : enemy;
      const loser = winner === "p1" ? "p2" : "p1";

      room.state.pendingScore = { winner, loser, diff: d };
      room.state.waitingScoreChoice = true;

      logAndBroadcast(
        ws.roomId,
        `🏆 Duelo: ${winner} gana (${a} vs ${b}), debe elegir SUMAR o RESTAR ${d}`
      );
      printGameState(room, "⏳ Esperando apply_score");

      broadcast(ws.roomId, {
        type: "score_choice",
        winner,
        diff: d,
        gameState: deepClone(room.state),
      });
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
      room.state.waitingScoreChoice = false;
      room.state.pendingScore = null;
      broadcast(roomId, { type: "player_left", gameState: deepClone(room.state) });
    }
  });

  ws.on("error", (err) => console.error("⚠️ WS error:", err?.message || err));
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, 15000);

wss.on("close", () => clearInterval(interval));
