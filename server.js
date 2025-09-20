const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 3000 });

// Estructura para manejar salas
const rooms = new Map();
const MAX_PLAYERS_PER_ROOM = 2;

// Función para encontrar una sala disponible o crear una nueva
function findAvailableRoom() {
  for (let [roomId, room] of rooms) {
    if (room.players.length < MAX_PLAYERS_PER_ROOM) {
      return roomId;
    }
  }
  
  // Crear nueva sala si no hay disponibles
  const newRoomId = `room_${Date.now()}`;
  rooms.set(newRoomId, {
    players: [],
    gameState: {}
  });
  return newRoomId;
}

wss.on("connection", (ws) => {
  console.log("Nueva conexión detectada");
  
  // Asignar a una sala disponible
  const roomId = findAvailableRoom();
  const room = rooms.get(roomId);
  
  // Agregar jugador a la sala
  const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  ws.roomId = roomId;
  ws.playerId = playerId;
  
  room.players.push({
    id: playerId,
    ws: ws,
    connected: true
  });
  
  console.log(`Jugador ${playerId} conectado a ${roomId}. Jugadores en sala: ${room.players.length}`);
  
  // Notificar al jugador su información
  ws.send(JSON.stringify({
    type: "connection_info",
    playerId: playerId,
    roomId: roomId,
    playerCount: room.players.length,
    maxPlayers: MAX_PLAYERS_PER_ROOM
  }));
  
  // Si la sala está llena, notificar que el juego puede comenzar
  if (room.players.length === MAX_PLAYERS_PER_ROOM) {
    room.players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: "room_full",
          message: "Sala completa, el juego puede comenzar",
          playerCount: room.players.length
        }));
      }
    });
  }

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log(`Recibido de ${playerId} en ${roomId}:`, data);

      // Reenviar mensaje solo a jugadores de la misma sala
      const currentRoom = rooms.get(roomId);
      if (currentRoom) {
        currentRoom.players.forEach(player => {
          if (player.id !== playerId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
              ...data,
              fromPlayer: playerId,
              roomId: roomId
            }));
          }
        });
      }
    } catch (error) {
      console.error("Error parsing message:", error);
      ws.send(JSON.stringify({
        type: "error",
        message: "Formato de mensaje inválido"
      }));
    }
  });

  ws.on("close", () => {
    console.log(`Jugador ${playerId} desconectado de ${roomId}`);
    
    // Remover jugador de la sala
    const currentRoom = rooms.get(roomId);
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(player => player.id !== playerId);
      
      // Notificar a otros jugadores de la desconexión
      currentRoom.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
          player.ws.send(JSON.stringify({
            type: "player_disconnected",
            disconnectedPlayer: playerId,
            playerCount: currentRoom.players.length
          }));
        }
      });
      
      // Eliminar sala si está vacía
      if (currentRoom.players.length === 0) {
        rooms.delete(roomId);
        console.log(`Sala ${roomId} eliminada (vacía)`);
      }
    }
  });

  ws.on("error", (error) => {
    console.error(`Error en conexión ${playerId}:`, error);
  });
});

// Función para obtener estadísticas del servidor
function getServerStats() {
  const totalRooms = rooms.size;
  const totalPlayers = Array.from(rooms.values()).reduce((sum, room) => sum + room.players.length, 0);
  const fullRooms = Array.from(rooms.values()).filter(room => room.players.length === MAX_PLAYERS_PER_ROOM).length;
  
  return {
    totalRooms,
    totalPlayers,
    fullRooms,
    availableRooms: totalRooms - fullRooms
  };
}

// Log periódico de estadísticas (opcional)
setInterval(() => {
  const stats = getServerStats();
  if (stats.totalPlayers > 0) {
    console.log(`Estadísticas del servidor:`, stats);
  }
}, 30000); // cada 30 segundos

console.log("Servidor WebSocket iniciado en puerto 3000");
console.log(`Máximo ${MAX_PLAYERS_PER_ROOM} jugadores por sala`);