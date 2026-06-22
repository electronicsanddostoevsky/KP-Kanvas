const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { GameStore, createSessionId } = require("./game");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || true,
    methods: ["GET", "POST"]
  }
});

const store = new GameStore();
const turnTimers = new Map();

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));

app.get("/room/:code", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("room:create", (payload = {}, ack) => {
    handleAck(ack, () => {
      const sessionId = payload.sessionId || createSessionId();
      const { room, player } = store.createRoom({
        name: payload.name,
        sessionId,
        socketId: socket.id
      });
      attachSocket(socket, room.code, player.id);
      socket.join(room.code);
      emitState(room.code);
      return { roomCode: room.code, playerId: player.id, sessionId, state: store.publicState(room.code, player.id) };
    });
  });

  socket.on("room:join", (payload = {}, ack) => {
    handleAck(ack, () => {
      const sessionId = payload.sessionId || createSessionId();
      const { room, player } = store.joinRoom(payload.roomCode, {
        name: payload.name,
        sessionId,
        socketId: socket.id
      });
      attachSocket(socket, room.code, player.id);
      socket.join(room.code);
      emitState(room.code);
      return { roomCode: room.code, playerId: player.id, sessionId, state: store.publicState(room.code, player.id) };
    });
  });

  socket.on("room:leave", (_payload = {}, ack) => {
    handleAck(ack, () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return { left: true };
      const room = store.leaveRoom(roomCode, playerId);
      socket.leave(roomCode);
      clearTimerIfNeeded(roomCode);
      if (room) {
        scheduleTurnEnd(room);
        emitState(room.code);
      }
      socket.data.roomCode = null;
      socket.data.playerId = null;
      return { left: true };
    });
  });

  socket.on("game:start", (_payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const room = store.startGame(roomCode, playerId);
      scheduleTurnEnd(room);
      emitState(room.code);
      return { state: store.publicState(room.code, playerId) };
    });
  });

  socket.on("word:choose", (payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const room = store.chooseWord(roomCode, playerId, payload.word);
      scheduleTurnEnd(room);
      emitState(room.code);
      return { state: store.publicState(room.code, playerId) };
    });
  });

  socket.on("draw:stroke", (payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const { room, stroke } = store.addStroke(roomCode, playerId, payload.stroke);
      socket.to(room.code).emit("draw:stroke", stroke);
      return {};
    });
  });

  socket.on("draw:clear", (_payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const room = store.clearCanvas(roomCode, playerId);
      io.to(room.code).emit("draw:clear");
      emitState(room.code);
      return {};
    });
  });

  socket.on("guess:submit", (payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const { room, correct } = store.submitGuess(roomCode, playerId, payload.guess);
      emitState(room.code);
      const remainingGuessers = store
        .connectedPlayers(room)
        .filter((player) => player.id !== room.drawerId && !room.guessedIds.has(player.id));
      if (correct && remainingGuessers.length === 0) {
        setTimeout(() => {
          const latest = store.getRoom(room.code);
          if (!latest || latest.phase !== "drawing") return;
          const next = store.nextTurn(latest.code);
          scheduleTurnEnd(next);
          emitState(next.code);
        }, 1200);
      }
      return { correct };
    });
  });

  socket.on("turn:next", (_payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      const room = store.getRoom(roomCode);
      if (!room) throw new Error("Room not found.");
      if (room.hostId !== playerId) throw new Error("Only the host can skip turns.");
      const next = store.nextTurn(roomCode);
      scheduleTurnEnd(next);
      emitState(next.code);
      return { state: store.publicState(next.code, playerId) };
    });
  });

  socket.on("state:sync", (_payload = {}, ack) => {
    handleRoomAction(socket, ack, ({ roomCode, playerId }) => {
      return { state: store.publicState(roomCode, playerId) };
    });
  });

  socket.on("disconnect", () => {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) return;
    const room = store.disconnectPlayer(roomCode, playerId);
    if (!room) return;
    if (room.drawerId === playerId && room.phase !== "lobby" && room.phase !== "ended") {
      const next = store.nextTurn(room.code);
      scheduleTurnEnd(next);
      emitState(next.code);
      return;
    }
    emitState(room.code);
  });
});

function attachSocket(socket, roomCode, playerId) {
  socket.data.roomCode = roomCode;
  socket.data.playerId = playerId;
}

function handleRoomAction(socket, ack, action) {
  handleAck(ack, () => {
    const { roomCode, playerId } = socket.data;
    if (!roomCode || !playerId) throw new Error("Join a room first.");
    return action({ roomCode, playerId });
  }, socket);
}

function handleAck(ack, action, socket = null) {
  try {
    const result = action();
    if (typeof ack === "function") ack({ ok: true, ...result });
  } catch (error) {
    const payload = { ok: false, message: error.message || "Something went wrong." };
    if (typeof ack === "function") ack(payload);
    if (socket) socket.emit("error", payload);
  }
}

function emitState(roomCode) {
  const room = store.getRoom(roomCode);
  if (!room) return;
  room.players.forEach((player) => {
    if (!player.socketId) return;
    io.to(player.socketId).emit("state:sync", store.publicState(room.code, player.id));
  });
}

function scheduleTurnEnd(room) {
  clearTimerIfNeeded(room.code);
  if (room.phase !== "drawing" || !room.turnEndsAt) return;
  const ms = Math.max(0, room.turnEndsAt - Date.now());
  const timer = setTimeout(() => {
    const latest = store.getRoom(room.code);
    if (!latest || latest.phase !== "drawing") return;
    const next = store.nextTurn(latest.code);
    scheduleTurnEnd(next);
    emitState(next.code);
  }, ms);
  turnTimers.set(room.code, timer);
}

function clearTimerIfNeeded(roomCode) {
  const timer = turnTimers.get(roomCode);
  if (!timer) return;
  clearTimeout(timer);
  turnTimers.delete(roomCode);
}

setInterval(() => {
  const removed = store.cleanupRooms();
  removed.forEach(clearTimerIfNeeded);
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`KP Kanvas!!!!!!!! listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io, store };
