const crypto = require("crypto");
const { WORDS } = require("./words");

const DEFAULT_SETTINGS = {
  maxPlayers: 6,
  rounds: 3,
  turnSeconds: 80,
  idleRoomMs: 60 * 60 * 1000,
  emptyRoomMs: 10 * 60 * 1000
};

function now() {
  return Date.now();
}

function createRoomCode(existingCodes = new Set()) {
  let code;
  do {
    code = crypto.randomBytes(5).toString("hex").toUpperCase();
  } while (existingCodes.has(code));
  return code;
}

function createSessionId() {
  return crypto.randomUUID();
}

function cleanName(name) {
  const value = String(name || "").trim().replace(/\s+/g, " ");
  if (!value) return "Player";
  return value.slice(0, 20);
}

function normalizeGuess(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function maskWord(word) {
  if (!word) return "";
  return word.replace(/[A-Za-z0-9]/g, "_");
}

function pickWords(count = 3, source = WORDS) {
  const copy = [...source];
  const picked = [];
  while (picked.length < count && copy.length > 0) {
    const index = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(index, 1)[0]);
  }
  return picked;
}

function makePlayer({ id, name, socketId, host = false }) {
  return {
    id,
    name: cleanName(name),
    socketId,
    score: 0,
    connected: true,
    isHost: host,
    correctThisTurn: false,
    joinedAt: now()
  };
}

function makeRoom({ code, hostName, hostSessionId, hostSocketId, settings = {} }) {
  const mergedSettings = { ...DEFAULT_SETTINGS, ...settings };
  const host = makePlayer({
    id: hostSessionId || createSessionId(),
    name: hostName,
    socketId: hostSocketId,
    host: true
  });

  return {
    code,
    settings: mergedSettings,
    players: new Map([[host.id, host]]),
    hostId: host.id,
    phase: "lobby",
    roundNumber: 0,
    turnIndex: -1,
    turnOrder: [],
    turnsPerRound: 0,
    drawerId: null,
    word: null,
    wordChoices: [],
    turnEndsAt: null,
    guessedIds: new Set(),
    strokes: [],
    chat: [],
    createdAt: now(),
    lastActiveAt: now()
  };
}

class GameStore {
  constructor({ settings = {}, words = WORDS } = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.words = words;
    this.rooms = new Map();
  }

  createRoom({ name, sessionId, socketId }) {
    const playerId = sessionId || createSessionId();
    const code = createRoomCode(new Set(this.rooms.keys()));
    const room = makeRoom({
      code,
      hostName: name,
      hostSessionId: playerId,
      hostSocketId: socketId,
      settings: this.settings
    });
    this.rooms.set(code, room);
    return { room, player: room.players.get(playerId) };
  }

  getRoom(code) {
    return this.rooms.get(String(code || "").toUpperCase());
  }

  joinRoom(code, { name, sessionId, socketId }) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");

    const playerId = sessionId || createSessionId();
    const existing = room.players.get(playerId);
    if (existing) {
      existing.name = cleanName(name || existing.name);
      existing.socketId = socketId;
      existing.connected = true;
      room.lastActiveAt = now();
      this.ensureHost(room);
      return { room, player: existing, rejoined: true };
    }

    if (room.players.size >= room.settings.maxPlayers && !room.players.has(playerId)) {
      throw new Error("Room is full.");
    }

    const player = makePlayer({ id: playerId, name, socketId });
    room.players.set(player.id, player);
    room.lastActiveAt = now();
    this.ensureHost(room);
    return { room, player, rejoined: false };
  }

  disconnectPlayer(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return null;
    const player = room.players.get(playerId);
    if (!player) return room;

    player.connected = false;
    player.socketId = null;
    player.correctThisTurn = false;
    room.lastActiveAt = now();
    this.ensureHost(room);
    return room;
  }

  leaveRoom(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return null;
    room.players.delete(playerId);
    room.guessedIds.delete(playerId);
    room.lastActiveAt = now();

    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return null;
    }

    if (room.drawerId === playerId && room.phase !== "lobby" && room.phase !== "ended") {
      this.nextTurn(room.code);
    } else {
      this.ensureHost(room);
    }
    return room;
  }

  startGame(code, playerId) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");
    if (room.hostId !== playerId) throw new Error("Only the host can start the game.");
    if (this.connectedPlayers(room).length < 2) throw new Error("At least 2 players are needed.");

    room.players.forEach((player) => {
      player.score = 0;
      player.correctThisTurn = false;
    });
    room.turnOrder = this.connectedPlayers(room).map((player) => player.id);
    room.turnsPerRound = room.turnOrder.length;
    room.roundNumber = 1;
    room.turnIndex = -1;
    room.phase = "choosing";
    room.chat = [];
    room.strokes = [];
    room.lastActiveAt = now();
    return this.nextTurn(code);
  }

  nextTurn(code) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");

    const previousDrawerId = room.drawerId;
    const previousTurnOrder = [...room.turnOrder];
    const previousDrawerIndex = previousTurnOrder.indexOf(previousDrawerId);
    const connectedIds = this.connectedPlayers(room).map((player) => player.id);
    room.turnOrder = room.turnOrder.filter((id) => connectedIds.includes(id));
    connectedIds.forEach((id) => {
      if (!room.turnOrder.includes(id)) room.turnOrder.push(id);
    });

    if (room.turnOrder.length < 2) {
      room.phase = "ended";
      room.drawerId = null;
      room.word = null;
      room.wordChoices = [];
      room.turnEndsAt = null;
      room.strokes = [];
      room.chat.push(systemMessage("Game ended because there are fewer than 2 players."));
      room.lastActiveAt = now();
      return room;
    }

    const turnsPerRound = room.turnsPerRound || room.turnOrder.length;
    const totalTurns = turnsPerRound * room.settings.rounds;
    room.turnIndex += 1;
    if (room.turnIndex >= totalTurns) {
      room.phase = "ended";
      room.drawerId = null;
      room.word = null;
      room.wordChoices = [];
      room.turnEndsAt = null;
      room.strokes = [];
      room.chat.push(systemMessage("Game over!"));
      room.lastActiveAt = now();
      return room;
    }

    const currentDrawerIndex = room.turnOrder.indexOf(previousDrawerId);
    let nextDrawerIndex = 0;
    if (previousDrawerId && currentDrawerIndex >= 0) {
      nextDrawerIndex = (currentDrawerIndex + 1) % room.turnOrder.length;
    } else if (previousDrawerId && previousDrawerIndex >= 0) {
      nextDrawerIndex = previousDrawerIndex >= room.turnOrder.length ? 0 : previousDrawerIndex;
    }

    room.roundNumber = Math.floor(room.turnIndex / turnsPerRound) + 1;
    room.drawerId = room.turnOrder[nextDrawerIndex];
    room.phase = "choosing";
    room.word = null;
    room.wordChoices = pickWords(3, this.words);
    room.turnEndsAt = null;
    room.guessedIds = new Set();
    room.strokes = [];
    room.players.forEach((player) => {
      player.correctThisTurn = false;
    });
    room.chat.push(systemMessage(`${room.players.get(room.drawerId)?.name || "Someone"} is choosing a word.`));
    room.lastActiveAt = now();
    return room;
  }

  chooseWord(code, playerId, word) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");
    if (room.phase !== "choosing") throw new Error("It is not word-picking time.");
    if (room.drawerId !== playerId) throw new Error("Only the drawer can choose the word.");
    if (!room.wordChoices.includes(word)) throw new Error("Choose one of the offered words.");

    room.word = word;
    room.phase = "drawing";
    room.turnEndsAt = now() + room.settings.turnSeconds * 1000;
    room.chat.push(systemMessage(`${room.players.get(playerId)?.name || "The drawer"} started drawing.`));
    room.lastActiveAt = now();
    return room;
  }

  addStroke(code, playerId, stroke) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");
    if (room.phase !== "drawing") throw new Error("Drawing is not active.");
    if (room.drawerId !== playerId) throw new Error("Only the drawer can draw.");

    const cleanStroke = sanitizeStroke(stroke);
    room.strokes.push(cleanStroke);
    if (room.strokes.length > 1500) room.strokes.shift();
    room.lastActiveAt = now();
    return { room, stroke: cleanStroke };
  }

  clearCanvas(code, playerId) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");
    if (room.drawerId !== playerId) throw new Error("Only the drawer can clear the canvas.");
    room.strokes = [];
    room.lastActiveAt = now();
    return room;
  }

  submitGuess(code, playerId, guess) {
    const room = this.getRoom(code);
    if (!room) throw new Error("Room not found.");
    const player = room.players.get(playerId);
    if (!player) throw new Error("Player not found.");

    const text = String(guess || "").trim().slice(0, 80);
    if (!text) throw new Error("Guess cannot be empty.");
    if (room.guessedIds.has(playerId)) {
      room.lastActiveAt = now();
      return { room, correct: false, message: "already-correct" };
    }

    if (room.phase !== "drawing" || !room.word || playerId === room.drawerId) {
      room.chat.push(chatMessage(player, text));
      room.lastActiveAt = now();
      return { room, correct: false, message: "chat" };
    }

    if (normalizeGuess(text) === normalizeGuess(room.word)) {
      const msLeft = Math.max(0, room.turnEndsAt - now());
      const guesserPoints = 100 + Math.ceil((msLeft / (room.settings.turnSeconds * 1000)) * 200);
      const drawer = room.players.get(room.drawerId);
      player.score += guesserPoints;
      player.correctThisTurn = true;
      room.guessedIds.add(playerId);
      if (drawer) drawer.score += 50;
      room.chat.push(systemMessage(`${player.name} guessed the word.`));
      room.lastActiveAt = now();
      return { room, correct: true, message: "correct" };
    }

    room.chat.push(chatMessage(player, text));
    room.lastActiveAt = now();
    return { room, correct: false, message: "chat" };
  }

  connectedPlayers(room) {
    return [...room.players.values()].filter((player) => player.connected);
  }

  ensureHost(room) {
    const connected = this.connectedPlayers(room);
    room.players.forEach((player) => {
      player.isHost = false;
    });

    if (!connected.some((player) => player.id === room.hostId)) {
      room.hostId = connected[0]?.id || [...room.players.keys()][0] || null;
    }

    const host = room.hostId ? room.players.get(room.hostId) : null;
    if (host) host.isHost = true;
    return host;
  }

  cleanupRooms(referenceTime = now()) {
    const removed = [];
    this.rooms.forEach((room, code) => {
      const connected = this.connectedPlayers(room).length;
      const idleFor = referenceTime - room.lastActiveAt;
      if (
        (connected === 0 && idleFor > room.settings.emptyRoomMs) ||
        idleFor > room.settings.idleRoomMs
      ) {
        this.rooms.delete(code);
        removed.push(code);
      }
    });
    return removed;
  }

  publicState(code, viewerId) {
    const room = this.getRoom(code);
    if (!room) return null;
    const viewer = room.players.get(viewerId);
    const isDrawer = room.drawerId === viewerId;
    const players = [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostId,
      isDrawer: player.id === room.drawerId,
      correctThisTurn: player.correctThisTurn
    }));

    return {
      code: room.code,
      phase: room.phase,
      settings: {
        maxPlayers: room.settings.maxPlayers,
        rounds: room.settings.rounds,
        turnSeconds: room.settings.turnSeconds
      },
      me: viewer
        ? {
            id: viewer.id,
            name: viewer.name,
            isHost: viewer.id === room.hostId,
            isDrawer
          }
        : null,
      players,
      hostId: room.hostId,
      drawerId: room.drawerId,
      roundNumber: room.roundNumber,
      turnIndex: room.turnIndex,
      turnEndsAt: room.turnEndsAt,
      maskedWord: room.word ? maskWord(room.word) : "",
      word: isDrawer ? room.word : null,
      wordChoices: isDrawer && room.phase === "choosing" ? room.wordChoices : [],
      strokes: room.strokes,
      chat: room.chat.slice(-80)
    };
  }
}

function sanitizeStroke(stroke) {
  const points = Array.isArray(stroke?.points) ? stroke.points : [];
  const cleanPoints = points
    .slice(0, 250)
    .map((point) => ({
      x: clampNumber(point?.x, 0, 1),
      y: clampNumber(point?.y, 0, 1)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

  if (cleanPoints.length < 1) throw new Error("Stroke has no points.");

  return {
    points: cleanPoints,
    color: /^#[0-9a-fA-F]{6}$/.test(stroke?.color) ? stroke.color : "#111827",
    size: clampNumber(stroke?.size, 2, 24),
    at: now()
  };
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function chatMessage(player, text) {
  return {
    id: crypto.randomUUID(),
    type: "chat",
    playerId: player.id,
    name: player.name,
    text,
    at: now()
  };
}

function systemMessage(text) {
  return {
    id: crypto.randomUUID(),
    type: "system",
    text,
    at: now()
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  GameStore,
  cleanName,
  createRoomCode,
  createSessionId,
  maskWord,
  normalizeGuess,
  pickWords
};
