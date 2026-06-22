const socket = io();

const SESSION_KEY = "scribbleFriendsSessionId";
const NAME_KEY = "scribbleFriendsName";

const state = {
  room: null,
  color: "#111827",
  size: 6,
  drawing: false,
  currentStroke: null
};

const els = {
  lobby: document.getElementById("lobby"),
  game: document.getElementById("game"),
  lobbyForm: document.getElementById("lobbyForm"),
  nameInput: document.getElementById("nameInput"),
  roomInput: document.getElementById("roomInput"),
  createButton: document.getElementById("createButton"),
  joinButton: document.getElementById("joinButton"),
  roomCode: document.getElementById("roomCode"),
  copyLinkButton: document.getElementById("copyLinkButton"),
  roundLabel: document.getElementById("roundLabel"),
  timerLabel: document.getElementById("timerLabel"),
  wordLabel: document.getElementById("wordLabel"),
  playersList: document.getElementById("playersList"),
  startButton: document.getElementById("startButton"),
  skipButton: document.getElementById("skipButton"),
  canvas: document.getElementById("canvas"),
  clearButton: document.getElementById("clearButton"),
  sizeInput: document.getElementById("sizeInput"),
  wordChoice: document.getElementById("wordChoice"),
  wordButtons: document.getElementById("wordButtons"),
  messages: document.getElementById("messages"),
  guessForm: document.getElementById("guessForm"),
  guessInput: document.getElementById("guessInput")
};

const ctx = els.canvas.getContext("2d");

boot();

function boot() {
  els.nameInput.value = localStorage.getItem(NAME_KEY) || "";
  const pathRoom = location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)/)?.[1];
  if (pathRoom) els.roomInput.value = pathRoom.toUpperCase();

  els.createButton.addEventListener("click", createRoom);
  els.lobbyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    joinRoom();
  });
  els.copyLinkButton.addEventListener("click", copyInviteLink);
  els.startButton.addEventListener("click", () => emitAck("game:start"));
  els.skipButton.addEventListener("click", () => emitAck("turn:next"));
  els.clearButton.addEventListener("click", () => emitAck("draw:clear"));
  els.sizeInput.addEventListener("input", () => {
    state.size = Number(els.sizeInput.value);
  });
  els.guessForm.addEventListener("submit", submitGuess);
  document.querySelectorAll(".swatch").forEach((button) => {
    button.addEventListener("click", () => {
      state.color = button.dataset.color;
      document.querySelectorAll(".swatch").forEach((swatch) => swatch.classList.remove("active"));
      button.classList.add("active");
    });
  });

  els.canvas.addEventListener("pointerdown", startStroke);
  els.canvas.addEventListener("pointermove", moveStroke);
  els.canvas.addEventListener("pointerup", endStroke);
  els.canvas.addEventListener("pointercancel", endStroke);
  window.addEventListener("resize", () => renderCanvas());

  socket.on("state:sync", applyState);
  socket.on("draw:stroke", (stroke) => {
    if (!state.room) return;
    state.room.strokes.push(stroke);
    drawStroke(stroke);
  });
  socket.on("draw:clear", () => {
    if (state.room) state.room.strokes = [];
    clearCanvas();
  });
  socket.on("error", (payload) => showStatus(payload.message || "Something went wrong."));

  if (pathRoom && els.nameInput.value) {
    joinRoom();
  }
}

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function createRoom() {
  const name = readName();
  if (!name) return;
  emitAck("room:create", { name, sessionId: getSessionId() }, (response) => {
    history.replaceState(null, "", `/room/${response.roomCode}`);
    applyState(response.state);
  });
}

function joinRoom() {
  const name = readName();
  const roomCode = els.roomInput.value.trim().toUpperCase();
  if (!name || !roomCode) return showStatus("Enter a room code.");
  emitAck("room:join", { name, roomCode, sessionId: getSessionId() }, (response) => {
    history.replaceState(null, "", `/room/${response.roomCode}`);
    applyState(response.state);
  });
}

function readName() {
  const name = els.nameInput.value.trim();
  if (!name) {
    showStatus("Enter your name.");
    els.nameInput.focus();
    return "";
  }
  localStorage.setItem(NAME_KEY, name);
  return name;
}

function emitAck(event, payload = {}, onOk = () => {}) {
  socket.emit(event, payload, (response = {}) => {
    if (!response.ok) {
      showStatus(response.message || "Something went wrong.");
      return;
    }
    onOk(response);
  });
}

function applyState(nextState) {
  if (!nextState) return;
  state.room = nextState;
  els.lobby.classList.add("hidden");
  els.game.classList.remove("hidden");

  renderStatus();
  renderPlayers();
  renderWordChoice();
  renderMessages();
  renderCanvas();
}

function renderStatus() {
  const room = state.room;
  const me = room.me || {};
  els.roomCode.textContent = room.code;
  els.roundLabel.textContent = room.phase === "lobby" ? "Lobby" : `${room.roundNumber}/${room.settings.rounds}`;
  els.wordLabel.textContent = room.word || room.maskedWord || (room.phase === "choosing" ? "Choosing" : "Waiting");
  const connectedPlayers = room.players.filter((player) => player.connected);
  els.startButton.disabled = !(me.isHost && room.phase === "lobby" && connectedPlayers.length >= 2);
  els.skipButton.disabled = !(me.isHost && ["choosing", "drawing"].includes(room.phase));
  els.clearButton.disabled = !(me.isDrawer && room.phase === "drawing");
  els.guessInput.disabled = room.phase !== "drawing" || me.isDrawer;
  els.guessInput.placeholder = me.isDrawer ? "You are drawing" : "Type a guess or chat";
}

function renderPlayers() {
  const sorted = [...state.room.players].sort((a, b) => b.score - a.score);
  els.playersList.replaceChildren(
    ...sorted.map((player) => {
      const item = document.createElement("li");
      const name = document.createElement("div");
      const score = document.createElement("strong");
      const meta = document.createElement("div");

      name.className = "player-name";
      score.textContent = player.score;
      name.textContent = player.name;
      meta.className = "player-meta";
      meta.textContent = [
        player.isHost ? "host" : "",
        player.isDrawer ? "drawing" : "",
        player.correctThisTurn ? "guessed" : "",
        player.connected ? "" : "offline"
      ].filter(Boolean).join(" / ");

      const left = document.createElement("div");
      left.append(name, meta);
      item.append(left, score);
      return item;
    })
  );
}

function renderWordChoice() {
  const choices = state.room.wordChoices || [];
  els.wordChoice.classList.toggle("hidden", choices.length === 0);
  els.wordButtons.replaceChildren(
    ...choices.map((word) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = word;
      button.addEventListener("click", () => emitAck("word:choose", { word }));
      return button;
    })
  );
}

function renderMessages() {
  const chat = state.room.chat || [];
  const shouldStick = els.messages.scrollTop + els.messages.clientHeight >= els.messages.scrollHeight - 20;
  els.messages.replaceChildren(
    ...chat.map((message) => {
      const item = document.createElement("div");
      item.className = `message ${message.type === "system" ? "system" : ""}`;
      if (message.type === "chat") {
        const name = document.createElement("strong");
        name.textContent = message.name;
        item.append(name, document.createTextNode(message.text));
      } else {
        item.textContent = message.text;
      }
      return item;
    })
  );
  if (shouldStick) els.messages.scrollTop = els.messages.scrollHeight;
}

function showStatus(text) {
  if (!state.room) {
    els.roomInput.setCustomValidity(text);
    els.roomInput.reportValidity();
    setTimeout(() => els.roomInput.setCustomValidity(""), 1200);
    return;
  }
  const message = document.createElement("div");
  message.className = "message system";
  message.textContent = text;
  els.messages.append(message);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function submitGuess(event) {
  event.preventDefault();
  const guess = els.guessInput.value.trim();
  if (!guess) return;
  els.guessInput.value = "";
  emitAck("guess:submit", { guess });
}

async function copyInviteLink() {
  const url = `${location.origin}/room/${state.room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    showStatus("Invite link copied.");
  } catch {
    showStatus(url);
  }
}

function startStroke(event) {
  if (!canDraw()) return;
  els.canvas.setPointerCapture(event.pointerId);
  state.drawing = true;
  state.currentStroke = {
    points: [pointFromEvent(event)],
    color: state.color,
    size: state.size
  };
}

function moveStroke(event) {
  if (!state.drawing || !state.currentStroke) return;
  const nextPoint = pointFromEvent(event);
  const points = state.currentStroke.points;
  const previous = points[points.length - 1];
  points.push(nextPoint);
  drawStroke({ ...state.currentStroke, points: [previous, nextPoint] });
}

function endStroke(event) {
  if (!state.drawing || !state.currentStroke) return;
  state.drawing = false;
  if (event.pointerId != null && els.canvas.hasPointerCapture(event.pointerId)) {
    els.canvas.releasePointerCapture(event.pointerId);
  }
  const stroke = state.currentStroke;
  state.currentStroke = null;
  if (stroke.points.length > 1) {
    state.room.strokes.push(stroke);
    emitAck("draw:stroke", { stroke });
  }
}

function canDraw() {
  return state.room?.me?.isDrawer && state.room.phase === "drawing";
}

function pointFromEvent(event) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

function renderCanvas() {
  clearCanvas();
  (state.room?.strokes || []).forEach(drawStroke);
}

function clearCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
}

function drawStroke(stroke) {
  const points = stroke.points || [];
  if (points.length < 1) return;
  ctx.save();
  ctx.strokeStyle = stroke.color || "#111827";
  ctx.lineWidth = stroke.size || 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x * els.canvas.width, points[0].y * els.canvas.height);
  points.slice(1).forEach((point) => ctx.lineTo(point.x * els.canvas.width, point.y * els.canvas.height));
  if (points.length === 1) {
    ctx.lineTo(points[0].x * els.canvas.width + 0.01, points[0].y * els.canvas.height + 0.01);
  }
  ctx.stroke();
  ctx.restore();
}

setInterval(() => {
  if (!state.room?.turnEndsAt || state.room.phase !== "drawing") {
    els.timerLabel.textContent = "--";
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.room.turnEndsAt - Date.now()) / 1000));
  els.timerLabel.textContent = `${seconds}s`;
}, 250);
