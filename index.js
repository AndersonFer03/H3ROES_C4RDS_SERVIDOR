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
  resetGame,
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
function snapshotState(state) {
  // Crear una copia del estado excluyendo propiedades problemáticas
  const cleanState = { ...state };
  
  // Eliminar timers y referencias circulares antes de clonar
  if (cleanState.scoreChoiceTimer) {
    delete cleanState.scoreChoiceTimer;
  }
  
  return deepClone(cleanState);
}
function printGameState(room, prefix = "") {
  const rs = room.state.roundScore;
  const cr = room.state.credits;
  console.log(
    `${prefix} 📊 Estado → P1: ${rs.p1} pts / ${cr.p1} créditos | P2: ${rs.p2} pts / ${cr.p2} créditos | Ronda: ${room.state.roundIndex}`
  );
}

function startNextRound(roomId, room) {
  resetRound(room);
  logAndBroadcast(roomId, `🔄 Nueva ronda iniciada (#${room.state.roundIndex})`);
  broadcast(roomId, { type: "round_started", gameState: snapshotState(room.state) });
}
function sendRoundResult(roomId, room, winner, isTie) {
  room.state.phase = "round_end";
  room.state.waitingNextRound = room.state.waitingNextRound || { p1: false, p2: false };

  broadcast(roomId, {
    type: "round_result",
    winner: isTie ? null : winner,
    isTie: !!isTie,
    gameState: snapshotState(room.state),
  });

  logAndBroadcast(
    roomId,
    isTie ? `Ronda ${room.state.roundIndex} empatada`
          : `Ganador de la ronda ${room.state.roundIndex}: ${winner}`
  );
}
function maybeStartAfterAcks(roomId, room) {
  const w = room.state.waitingNextRound || { p1: false, p2: false };
  if (w.p1 && w.p2) {
    room.state.waitingNextRound = { p1: false, p2: false };
    startNextRound(roomId, room);
  }
}

function maybeFinishRound(roomId, room) {
  const s = room.state;
  if (s.remainingPairs === 0 && !s.waitingScoreChoice && s.phase === "play") {
    finishRound(roomId, room);
  }
}

function finishRound(roomId, room) {
  const s = room.state;
  s.phase = "round_end";

  const d1 = distTo34(s.roundScore.p1);
  const d2 = distTo34(s.roundScore.p2);

  let winner = null;
  let isTie = false;

  if (d1 === d2) {
    isTie = true;
    logAndBroadcast(roomId, ` Ronda ${s.roundIndex} empatada: no hay cambios de créditos`);
  } else {
    winner = d1 < d2 ? "p1" : "p2";
    const loser = winner === "p1" ? "p2" : "p1";
    const winBet = Number(s.bets[winner]) || 0;
    const loseBet = Number(s.bets[loser]) || 0;
    s.credits[winner] += winBet;
    s.credits[loser]  -= loseBet;

    logAndBroadcast(
      roomId,
      ` Fin de ronda ${s.roundIndex} → ganador ${winner}. 💸 Liquidación: ${winner} +${winBet}, ${loser} -${loseBet}`
    );
  }

  printGameState(room, " Fin de ronda");

  if (s.credits.p1 <= 0 || s.credits.p2 <= 0) {
    const busted = s.credits.p1 <= 0 ? "p1" : "p2";
    const goWinner = busted === "p1" ? "p2" : "p1";
    logAndBroadcast(roomId, ` ${busted} BUSTED! Gana ${goWinner}`);
    broadcast(roomId, { type: "game_over", winner: goWinner, reason: "busted", gameState: snapshotState(s) });
    return;
  }
  if (s.credits.p1 >= 1000 || s.credits.p2 >= 1000) {
    const goWinner = s.credits.p1 >= 1000 ? "p1" : "p2";
    logAndBroadcast(roomId, ` ${goWinner} alcanzó 1000 créditos!`);
    broadcast(roomId, { type: "game_over", winner: goWinner, reason: "real_winner", gameState: snapshotState(s) });
    return;
  }

  sendRoundResult(roomId, room, winner, isTie);
}

function activateDoctorManhattan(roomId, room, side) {
  const enemy = side === "p1" ? "p2" : "p1";
  room.state.cards[enemy].forEach((c) => {
    if (!c.locked && !c.revealed) c.tempRevealed = true;
  });
  logAndBroadcast(roomId, ` ${side} activó Doctor Manhattan: revela cartas de ${enemy} por 5s`);
  broadcast(roomId, {
    type: "doctor_manhattan_reveal",
    gameState: snapshotState(room.state),
    effectOwner: side,
  });
  setTimeout(() => {
    const r = rooms[roomId];
    if (!r) return;
    r.state.cards[enemy].forEach((c) => {
      if (c.tempRevealed && !c.locked && !c.revealed) c.tempRevealed = false;
    });
    logAndBroadcast(roomId, " Efecto de Doctor Manhattan terminó");
    broadcast(roomId, { type: "update_state", gameState: snapshotState(r.state) });
  }, 5000);
}

const wss = new WebSocket.Server({ port: 8080 });
console.log(" Servidor corriendo en ws://localhost:8080");

wss.on("connection", (ws) => {
  console.log(" Cliente conectado");

  ws.isAlive = true;
  ws.lastPong = Date.now();
  ws.on("pong", () => {
    ws.isAlive = true;
    ws.lastPong = Date.now();
  });

  ws.roomId = null;
  ws.side = null;

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { console.error(" Error al parsear:", raw); return; }

    if (data.type === "join") {
      const roomId = findAvailableRoom(data.roomId);
      const room   = rooms[roomId];
      const side   = !room.players.p1 ? "p1" : "p2";

      room.players[side] = ws;
      ws.roomId = roomId;
      ws.side   = side;

      logAndBroadcast(roomId, ` ${side} se unió a la sala ${roomId}`);
      ws.send(JSON.stringify({ type: "joined", side, roomId }));
      ws.send(JSON.stringify({ type: "round_started", gameState: snapshotState(room.state) }));

      if (bothPlayersReady(room)) {
        logAndBroadcast(roomId, " Ambos jugadores listos");
        broadcast(roomId, { type: "both_ready", gameState: snapshotState(room.state) });
      }
      return;
    }

    if (!ws.roomId || !ws.side) return;
    const room = rooms[ws.roomId];
    if (!room) return;

    if (data.type === "place_bet") {
      if (room.state.phase !== "betting") return;
      const side = ws.side;
      const amount = Number(data.amount);
      if (amount <= 0 || amount > room.state.credits[side]) {
        ws.send(JSON.stringify({ type: "invalid_action", reason: "apuesta_invalida", gameState: snapshotState(room.state) }));
        return;
      }
      room.state.bets[side] = amount;
      logAndBroadcast(ws.roomId, ` ${side} apostó ${amount} créditos`);

      if (room.state.bets.p1 !== null && room.state.bets.p2 !== null) {
        logAndBroadcast(ws.roomId, " Ambos jugadores apostaron, empieza la ronda");
        room.state.phase = "decide_start";
        broadcast(ws.roomId, { type: "bets_locked", gameState: snapshotState(room.state) });
      } else {
        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
      }
      return;
    }

    if (data.type === "request_reset_game") {
      const side = ws.side;
      const enemy = side === "p1" ? "p2" : "p1";
      
      // Inicializar estado de reinicio si no existe
      room.state.resetRequest = room.state.resetRequest || { requester: null, pending: false };
      
      if (room.state.resetRequest.pending) {
        ws.send(JSON.stringify({ type: "reset_already_pending" }));
        return;
      }
      
      room.state.resetRequest.requester = side;
      room.state.resetRequest.pending = true;
      
      logAndBroadcast(ws.roomId, ` ${side} solicita reiniciar el juego`);
      
      // Enviar solicitud al otro jugador
      const enemyWs = room.players[enemy];
      if (enemyWs) {
        enemyWs.send(JSON.stringify({ 
          type: "reset_game_request", 
          requester: side 
        }));
      }
      
      // Confirmar al solicitante que la petición fue enviada
      ws.send(JSON.stringify({ 
        type: "reset_request_sent" 
      }));
      return;
    }

    if (data.type === "reset_game_response") {
      const { accepted } = data;
      const side = ws.side;
      
      if (!room.state.resetRequest || !room.state.resetRequest.pending) {
        return;
      }
      
      const requester = room.state.resetRequest.requester;
      const requesterWs = room.players[requester];
      
      if (accepted) {
        // Reiniciar el juego completamente
        resetGame(room);
        
        logAndBroadcast(ws.roomId, " Juego reiniciado por acuerdo mutuo");
        broadcast(ws.roomId, { type: "game_reset", gameState: snapshotState(room.state) });
      } else {
        // Cancelar solicitud
        room.state.resetRequest = { requester: null, pending: false };
        
        logAndBroadcast(ws.roomId, ` ${side} rechazó la solicitud de reinicio`);
        
        // Notificar al solicitante que fue rechazado
        if (requesterWs) {
          requesterWs.send(JSON.stringify({ type: "reset_request_denied" }));
        }
        
        // Notificar que se canceló la solicitud
        broadcast(ws.roomId, { type: "reset_request_cancelled" });
      }
      return;
    }

    if (data.type === "reset_game") {
      resetGame(room);
      logAndBroadcast(ws.roomId, " Juego reiniciado");
      broadcast(ws.roomId, { type: "game_reset", gameState: snapshotState(room.state) });
      return;
    }

    if (data.type === "round_ack") {
      if (room.state.phase !== "round_end") return;
      const side = ws.side;
      room.state.waitingNextRound = room.state.waitingNextRound || { p1: false, p2: false };
      if (!room.state.waitingNextRound[side]) {
        room.state.waitingNextRound[side] = true;
        logAndBroadcast(ws.roomId, ` ${side} listo para la siguiente ronda`);
        maybeStartAfterAcks(ws.roomId, room);
      }
      return;
    }

    if (data.type === "apply_score") {
      const ps = room.state.pendingScore;
      if (!ps || !room.state.waitingScoreChoice) return;

      if (ws.side !== ps.winner) {
        logAndBroadcast(ws.roomId, ` Solo ${ps.winner} puede aplicar la puntuación pendiente`);
        return;
      }

      if (room.state.scoreChoiceTimer) {
        clearTimeout(room.state.scoreChoiceTimer);
        room.state.scoreChoiceTimer = null;
      }

      if (data.mode === "sumar") {
        room.state.roundScore[ps.winner] += ps.diff;
        logAndBroadcast(ws.roomId, ` ${ps.winner} eligió SUMAR ${ps.diff} a su puntaje`);
      } else if (data.mode === "restar") {
        room.state.roundScore[ps.winner] -= ps.diff;
        logAndBroadcast(ws.roomId, ` ${ps.winner} eligió RESTAR ${ps.diff} a su propio puntaje`);
      } else {
        return;
      }

      room.state.pendingScore = null;
      room.state.waitingScoreChoice = false;
      room.state.lastDuel = null;

      broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
      printGameState(room, " Después de apply_score");

      maybeFinishRound(ws.roomId, room);
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
      logAndBroadcast(ws.roomId, ` ${side} eligió ${shown} (${card.id})`);

      if (room.state.decider.p1 && room.state.decider.p2) {
        const valP1 = getCardValue(room.state.decider.p1);
        const valP2 = getCardValue(room.state.decider.p2);

        let starter =
          valP1 > valP2 ? "p1" :
          valP2 > valP1 ? "p2" :
          Math.random() < 0.5 ? "p1" : "p2";

        room.state.turnOwner = starter;
        room.state.phase = "play";
        room.state.remainingPairs--;

        logAndBroadcast(ws.roomId, ` Compara inicio: p1=${valP1}, p2=${valP2} → empieza ${starter}`);
        logAndBroadcast(ws.roomId, ` Se descuenta el par inicial, quedan ${room.state.remainingPairs} pares`);

        broadcast(ws.roomId, { type: "start_decided", gameState: snapshotState(room.state) });
        room.state.decider = {};
      } else {
        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
      }
      return;
    }

    if (data.type === "play_card") {
      if (room.state.phase !== "play" || !bothPlayersReady(room)) return;

      if (room.state.waitingScoreChoice) {
        logAndBroadcast(ws.roomId, " Esperando elección de puntaje del ganador...");
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

        if (playedCard.face === "67") {
          activateDoctorManhattan(ws.roomId, room, side);
        }

        const shown = playedCard.face === "0" ? `JOKER(${playedCard.jokerValue})` : playedCard.face;
        logAndBroadcast(ws.roomId, ` ${side} juega ${shown} (${playedCard.id}), esperando rival`);
        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
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
      const d   = delta(a, b);

      const pendingOwner = room.state.pending.side;
      const ownCard = room.state.cards[pendingOwner].find((c) => c.id === room.state.pending.cardId);
      if (ownCard) ownCard.locked = true;
      enemyCard.locked = true;

      room.state.remainingPairs--;
      room.state.turnOwner = enemy;
      room.state.pending = null;

      if (cmp === 0) {
        logAndBroadcast(ws.roomId, ` Duelo empatado (${a} vs ${b})`);
        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
        room.state.decider = {};
        maybeFinishRound(ws.roomId, room);
        return;
      }

      const winner = cmp === 1 ? pendingOwner : enemy;
      room.state.lastDuel = { p1: room.state.decider.p1, p2: room.state.decider.p2 };

      if (winner === pendingOwner) {
        room.state.pendingScore = { winner, diff: d };
        room.state.waitingScoreChoice = true;

        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });

        const winnerSocket = room.players[winner];
        if (winnerSocket) {
          winnerSocket.send(JSON.stringify({
            type: "score_choice",
            winner,
            diff: d,
            gameState: snapshotState(room.state),
          }));
        }

        if (room.state.scoreChoiceTimer) clearTimeout(room.state.scoreChoiceTimer);
        room.state.scoreChoiceTimer = setTimeout(() => {
          const r = rooms[ws.roomId];
          if (!r) return;
          const s = r.state;
          if (!s.waitingScoreChoice || !s.pendingScore) return;

          const { winner, diff } = s.pendingScore;
          s.roundScore[winner] += diff; 
          s.pendingScore = null;
          s.waitingScoreChoice = false;
          s.lastDuel = null;

          logAndBroadcast(ws.roomId, ` Timeout: auto-SUMAR ${diff} para ${winner}`);
          broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(s) });
          printGameState(r, " Auto-apply por timeout");
          maybeFinishRound(ws.roomId, r);
        }, 30000);

        logAndBroadcast(ws.roomId, ` Duelo: ${winner} gana (${a} vs ${b}), debe elegir SUMAR o RESTAR ${d}`);
        printGameState(room, " Esperando apply_score");
      } else {
        logAndBroadcast(ws.roomId, ` ${pendingOwner} pierde (${a} vs ${b}), sin puntos`);
        printGameState(room, " Se pasa el turno");
        broadcast(ws.roomId, { type: "update_state", gameState: snapshotState(room.state) });
        maybeFinishRound(ws.roomId, room);
      }

      room.state.decider = {};
      return;
    }
  });

  ws.on("close", () => {
    const { roomId, side } = ws;
    console.log("❌ Cliente desconectado", roomId ? `(${roomId}/${side})` : "");
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const otherSide = side === "p1" ? "p2" : "p1";
    const otherPlayer = room.players[otherSide];

    if (otherPlayer) {
      otherPlayer.send(JSON.stringify({
        type: "room_closed",
        reason: "player_disconnected"
      }));
      setTimeout(() => {
        try { otherPlayer.close(1000, "Sala cerrada por desconexión del oponente"); } catch {}
      }, 100);
    }

    delete rooms[roomId];
    console.log(` Sala ${roomId} cerrada y eliminada (jugador ${side} desconectado)`);
  });

  ws.on("error", (err) => console.error("⚠️ WS error:", err?.message || err));
});

const PING_INTERVAL_MS = 30000;   
const IDLE_LIMIT_MS    = 10 * 60 * 1000; 

const interval = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch {}
      return;
    }
    if (now - (ws.lastPong || 0) > IDLE_LIMIT_MS) {
      console.log(" Idle >10min, cerrando socket");
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, PING_INTERVAL_MS);

wss.on("close", () => clearInterval(interval));
