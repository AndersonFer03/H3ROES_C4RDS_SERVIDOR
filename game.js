const { v4: uuidv4 } = require("uuid");
const { buildUnique, deepClone, compare, delta, distTo34 } = require("./utils");
const WebSocket = require("ws");

let rooms = {};

function broadcast(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify(message);
  ["p1", "p2"].forEach((side) => {
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

function mapCard(owner, i, c) {
  const card = {
    id: `${owner}_card_${i}`,
    face: c,
    revealed: false,
    locked: false,
  };
  if (c === "0") {
    card.jokerValue = Math.floor(Math.random() * 68) + 1;
  }
  return card;
}

function createRoom() {
  const roomId = uuidv4();

  const cards = buildUnique(20);
 /* const cards = [
    "0", "67", "3", "4", "5", "6", "7", "8", "9", "10",
    "0", "67", "3", "4", "5", "6", "7", "8", "9", "10",
  ];*/

  rooms[roomId] = {
    createdAt: Date.now(),
    players: { p1: null, p2: null },
    state: {
      phase: "betting", 
      cards: {
        p1: cards.slice(0, 10).map((c, i) => mapCard("p1", i, c)),
        p2: cards.slice(10, 20).map((c, i) => mapCard("p2", i, c)),
      },
      turnOwner: null,
      roundScore: { p1: 0, p2: 0 },
      credits: { p1: 100, p2: 100 },
      bets: { p1: null, p2: null }, 
      remainingPairs: 10,
      decider: {},
      pending: null,
      roundIndex: 1,
      scoreMode: "sumar",
      history: [],
    },
  };

  console.log(` Sala creada: ${roomId}`);
  console.log(" Cartas P1:", rooms[roomId].state.cards.p1.map((c) => c.face));
  console.log(" Cartas P2:", rooms[roomId].state.cards.p2.map((c) => c.face));

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

function endRound(room) {
  const scoreP1 = room.state.roundScore.p1;
  const scoreP2 = room.state.roundScore.p2;

  const d1 = distTo34(scoreP1);
  const d2 = distTo34(scoreP2);

  let winner = null;
  if (d1 < d2) winner = "p1";
  else if (d2 < d1) winner = "p2";
  else winner = "draw";

  console.log(` Fin de ronda #${room.state.roundIndex}`);
  console.log(` Estado final → P1: ${scoreP1} pts | P2: ${scoreP2} pts`);
  console.log(` Ganador: ${winner}`);

  room.state.history.push({
    round: room.state.roundIndex,
    score: { p1: scoreP1, p2: scoreP2 },
    winner,
  });

  return winner;
}

function resetRound(room) {
  endRound(room);

  const newCards = buildUnique(20);

  room.state.cards.p1 = newCards.slice(0, 10).map((c, i) => mapCard("p1", i, c));
  room.state.cards.p2 = newCards.slice(10, 20).map((c, i) => mapCard("p2", i, c));

  room.state.roundScore = { p1: 0, p2: 0 };
  room.state.remainingPairs = 10;
  room.state.turnOwner = null;
  room.state.phase = "betting"; 
  room.state.bets = { p1: null, p2: null };
  room.state.decider = {};
  room.state.pending = null;
  room.state.roundIndex = (room.state.roundIndex || 0) + 1;

  console.log(` Nueva ronda (#${room.state.roundIndex})`);
  console.log(" Cartas P1:", room.state.cards.p1.map((c) => c.face));
  console.log(" Cartas P2:", room.state.cards.p2.map((c) => c.face));
}

function getCardValue(card) {
  if (!card) return 0;
  if (card.face === "0" && card.jokerValue) {
    return card.jokerValue;
  }
  return Number(card.face) || 0;
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
  getCardValue,
  endRound,
};
