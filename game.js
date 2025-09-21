const { v4: uuidv4 } = require("uuid");
const { buildUnique, deepClone } = require("./utils");
const WebSocket = require("ws");

let rooms = {};

function broadcast(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify(message);
  ["p1", "p2"].forEach(side => {
    const ws = room.players[side];
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}

function logAndBroadcast(roomId, msg) {
  console.log(msg);
  broadcast(roomId, { type: "log", message: msg });
}

function playersCount(room) {
  return Number(!!room.players.p1) + Number(!!room.players.p2);
}

function bothPlayersReady(room) {
  return !!room.players.p1 && !!room.players.p2;
}

function createRoom() {
  const roomId = uuidv4();
  const cards = buildUnique(20);
  rooms[roomId] = {
    createdAt: Date.now(),
    players: { p1: null, p2: null },
    state: {
      phase: "decide_start",
      cards: {
        p1: cards.slice(0, 10).map((c,i)=>({id:`p1_card_${i}`,face:c,revealed:false,locked:false})),
        p2: cards.slice(10, 20).map((c,i)=>({id:`p2_card_${i}`,face:c,revealed:false,locked:false}))
      },
      turnOwner: null,
      roundScore: { p1: 0, p2: 0 },
      credits: { p1: 100, p2: 100 },
      bets: { p1: 10, p2: 10 },
      remainingPairs: 10,
      jokerValue: 50,
      decider: {},
      pending: null,
      roundIndex: 1
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

function resetRound(room) {
  const newCards = buildUnique(20);
  room.state.cards.p1 = newCards.slice(0, 10).map((c,i)=>({id:`p1_card_${i}`,face:c,revealed:false,locked:false}));
  room.state.cards.p2 = newCards.slice(10, 20).map((c,i)=>({id:`p2_card_${i}`,face:c,revealed:false,locked:false}));
  room.state.roundScore = { p1: 0, p2: 0 };
  room.state.remainingPairs = 10;
  room.state.turnOwner = null;
  room.state.phase = "decide_start";
  room.state.decider = {};
  room.state.pending = null;
  room.state.roundIndex = (room.state.roundIndex || 0) + 1;  
}

module.exports = {
  rooms,
  broadcast,
  logAndBroadcast,
  playersCount,
  bothPlayersReady,
  createRoom,
  findAvailableRoom,
  resetRound,
};
