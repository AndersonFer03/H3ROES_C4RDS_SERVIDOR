const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
function buildUnique(n) {
  const pool = [];
  for (let i = 0; i <= 67; i++) pool.push(i.toString());
  shuffle(pool);
  return pool.slice(0, n);
}
function distTo34(score) { return Math.abs(34 - score); }
function compare(a, b) {
  a = Number(a) || 0; b = Number(b) || 0;
  if (a > b) return 1; if (b > a) return -1; return 0;
}
function delta(a, b) {
  a = Number(a) || 0; b = Number(b) || 0;
  return Math.abs(a - b);
}
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

const wss = new WebSocket.Server({ port: 8080 });
let rooms = {}; 

console.log("🚀 Servidor corriendo en ws://localhost:8080");

function createRoom() {
  const roomId = uuidv4();
  const cards = buildUnique(20);

  rooms[roomId] = {
    createdAt: Date.now(),
    players: { p1: null, p2: null },
    state: {
      phase: "decide_start",
      cards: {
        p1: cards.slice(0, 10).map((c, i) => ({ id: `p1_card_${i}`, face: c, revealed: false, locked: false })),
        p2: cards.slice(10, 20).map((c, i) => ({ id: `p2_card_${i}`, face: c, revealed: false, locked: false }))
      },
      turnOwner: null,
      roundScore: { p1: 0, p2: 0 },
      credits: { p1: 100, p2: 100 },
      bets: { p1: 10, p2: 10 },
      remainingPairs: 10,
      jokerValue: 50,
      decider: {},
      pending: null,
    },
  };
  console.log(`🎲 Sala creada: ${roomId}`);
  return roomId;
}
function findAvailableRoom(preferRoomId) {
  if (preferRoomId && rooms[preferRoomId]) {
    const r = rooms[preferRoomId];
    const count = Number(!!r.players.p1) + Number(!!r.players.p2);
    if (count < 2) return preferRoomId;
  }
  for (const [id, r] of Object.entries(rooms)) {
    const count = Number(!!r.players.p1) + Number(!!r.players.p2);
    if (count < 2) return id;
  }
  return createRoom();
}
function broadcast(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify(message);
  ["p1", "p2"].forEach(side => {
    const ws = room.players[side];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}
function playersCount(room) {
  return Number(!!room.players.p1) + Number(!!room.players.p2);
}
function bothPlayersReady(room) { return !!room.players.p1 && !!room.players.p2; }
function resetRound(room) {
  const newCards = buildUnique(20);
  room.state.cards.p1 = newCards.slice(0, 10).map((c, i) => ({ id: `p1_card_${i}`, face: c, revealed: false, locked: false }));
  room.state.cards.p2 = newCards.slice(10, 20).map((c, i) => ({ id: `p2_card_${i}`, face: c, revealed: false, locked: false }));
  room.state.roundScore = { p1: 0, p2: 0 };
  room.state.remainingPairs = 10;
  room.state.turnOwner = null;
  room.state.phase = "decide_start";
  room.state.decider = {};
  room.state.pending = null;
}

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
      console.log(`🙋 ${side} se unió a la sala ${roomId}`);

      ws.send(JSON.stringify({ type: "joined", side, roomId }));
      ws.send(JSON.stringify({ type: "round_started", gameState: deepClone(room.state) }));
      if (bothPlayersReady(room)) {
        console.log("🤝 Ambos jugadores listos en sala", roomId);
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

  console.log(`🃏 ${side} eligió ${card.face} (${card.id}) para decidir inicio`);

  if (room.state.decider.p1 && room.state.decider.p2) {
    const a = Number(room.state.decider.p1.face);
    const b = Number(room.state.decider.p2.face);

    let starter = a > b ? "p1" : b > a ? "p2" : (Math.random() < 0.5 ? "p1" : "p2");
    room.state.turnOwner = starter;
    room.state.phase = "play";

    room.state.remainingPairs--;

    console.log(`🎲 Compara inicio: p1=${a}, p2=${b} → empieza ${starter}`);
    console.log(`📉 Se descuenta el par inicial, quedan ${room.state.remainingPairs} pares`);

    room.state.decider = {};
    broadcast(ws.roomId, { type: "start_decided", gameState: deepClone(room.state) });
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
        console.log(`👉 ${side} juega su carta ${card.face} (${card.id}), esperando rival`);
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
      } else {
        const enemy = side === "p1" ? "p2" : "p1";
        const card = room.state.cards[enemy].find(c => c.id === cardId);
        if (!card || card.locked) return;
        card.revealed = true;
        const a = Number(room.state.pending.face), b = Number(card.face);
        const cmp = compare(a, b), d = delta(a, b);
        if (cmp === 1) { room.state.roundScore[room.state.pending.side] += d; console.log(`⚔️ ${room.state.pending.side} gana el duelo (${a} vs ${b}), +${d} puntos`); }
        else if (cmp === -1) { room.state.roundScore[enemy] += d; console.log(`⚔️ ${enemy} gana el duelo (${b} vs ${a}), +${d} puntos`); }
        else console.log(`🤝 Empate (${a} vs ${b}), sin puntos`);
        const ownCard = room.state.cards[room.state.pending.side].find(c => c.id === room.state.pending.cardId);
        if (ownCard) ownCard.locked = true; card.locked = true;
        room.state.remainingPairs--; room.state.turnOwner = enemy; room.state.pending = null;
        console.log(`🔄 Turno pasa a ${enemy}, quedan ${room.state.remainingPairs} pares`);
        broadcast(ws.roomId, { type: "update_state", gameState: deepClone(room.state) });
        if (room.state.remainingPairs === 0) {
          room.state.phase = "decide_start";
          const d1 = distTo34(room.state.roundScore.p1), d2 = distTo34(room.state.roundScore.p2);
          if (d1 < d2) room.state.credits.p1 += room.state.bets.p1;
          else if (d2 < d1) room.state.credits.p2 += room.state.bets.p2;
          console.log("🏁 Fin de ronda");
          console.log("   Puntuación:", room.state.roundScore);
          console.log("   Créditos:", room.state.credits);
          broadcast(ws.roomId, { type: "round_finished", gameState: deepClone(room.state) });
          resetRound(room);
          console.log("🔄 Nueva ronda iniciada");
          broadcast(ws.roomId, { type: "round_started", gameState: deepClone(room.state) });
        }
      }
      return;
    }

    if (data.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
  });

  ws.on("close", () => {
    const { roomId, side } = ws;
    console.log("❌ Cliente desconectado", roomId ? `(${roomId}/${side})` : "");
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.players[side] === ws) room.players[side] = null;
    if (playersCount(room) === 0) { delete rooms[roomId]; console.log(`🧹 Sala ${roomId} eliminada (vacía)`); }
    else {
      room.state.phase = "waiting"; room.state.turnOwner = null; room.state.pending = null;
      broadcast(roomId, { type: "player_left", gameState: deepClone(room.state) });
    }
  });

  ws.on("error", (err) => console.error("⚠️ WS error:", err?.message || err));
});

/* Heartbeat */
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { } return; }
    ws.isAlive = false; try { ws.ping(); } catch { }
  });
}, 15000);

wss.on("close", () => clearInterval(interval));
