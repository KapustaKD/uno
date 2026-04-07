const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Deck Builder ────────────────────────────────────────────────────────────

function buildDeck() {
  const colors = ['red', 'blue', 'green', 'yellow'];
  const deck = [];

  for (const color of colors) {
    // 0 — одна штука
    deck.push({ color, value: '0', type: 'number' });
    // 1–9 — по дві
    for (let n = 1; n <= 9; n++) {
      deck.push({ color, value: String(n), type: 'number' });
      deck.push({ color, value: String(n), type: 'number' });
    }
    // Дії — по дві кожна
    for (let i = 0; i < 2; i++) {
      deck.push({ color, value: '+2', type: 'action' });
      deck.push({ color, value: 'reverse', type: 'action' });
      deck.push({ color, value: 'skip', type: 'action' });
    }
  }

  // Wild cards — по 4
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'black', value: 'wild', type: 'wild' });
    deck.push({ color: 'black', value: 'wild+4', type: 'wild' });
  }

  // Карти нового правила — 2 штуки
  deck.push({ color: 'black', value: 'newrule', type: 'newrule' });
  deck.push({ color: 'black', value: 'newrule', type: 'newrule' });

  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Game Rooms ───────────────────────────────────────────────────────────────

const rooms = {}; // roomCode -> { state, names, turnTimer }
const TURN_DURATION_MS = 15000;

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createGameState() {
  const deck = buildDeck();

  // Перша карта в стопку скидання — не може бути wild/newrule
  let startIdx = deck.findIndex(c => c.type === 'number');
  const [topCard] = deck.splice(startIdx, 1);

  return {
    deck,
    discardPile: [topCard],
    hands: {},
    players: [],
    currentTurn: null,
    activeRule: null,
    waitingForRule: false,
    waitingForColor: null, // socketId хто обирає колір
    pendingDraw: 0,        // накопичений +2/+4
    unoSaid: {},           // socketId -> bool
    winner: null,
    direction: 1,          // 1 або -1 (reverse)
    turnDeadline: null     // timestamp коли закінчується поточний хід
  };
}

function dealCards(state) {
  for (const pid of state.players) {
    state.hands[pid] = [];
    for (let i = 0; i < 7; i++) {
      state.hands[pid].push(state.deck.pop());
    }
    state.unoSaid[pid] = false;
  }
}

function topCard(state) {
  return state.discardPile[state.discardPile.length - 1];
}

function canPlay(card, top, state) {
  if (card.type === 'wild' || card.type === 'newrule') return true;
  if (card.value === 'wild+4') return true;
  const effectiveColor = top.chosenColor || top.color;
  return card.color === effectiveColor || card.value === top.value;
}

function nextPlayerIndex(state) {
  const idx = state.players.indexOf(state.currentTurn);
  return (idx + state.direction + state.players.length) % state.players.length;
}

function advanceTurn(state, skip = false) {
  let steps = skip ? 2 : 1;
  let idx = state.players.indexOf(state.currentTurn);
  idx = (idx + state.direction * steps + state.players.length * steps) % state.players.length;
  state.currentTurn = state.players[idx];
}

function drawCards(state, playerId, count) {
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) reshuffleDeck(state);
    if (state.deck.length > 0) state.hands[playerId].push(state.deck.pop());
  }
  state.unoSaid[playerId] = false;
}

function reshuffleDeck(state) {
  if (state.discardPile.length <= 1) return;
  const top = state.discardPile.pop();
  state.deck = shuffle(state.discardPile);
  // Прибираємо chosenColor зі старих карт
  state.deck = state.deck.map(c => ({ ...c, chosenColor: undefined }));
  state.discardPile = [top];
}

// ─── Sanitize state per player (hide opponent cards) ─────────────────────────

function stateForPlayer(state, playerId) {
  const opponent = state.players.find(p => p !== playerId);
  return {
    myHand: state.hands[playerId] || [],
    opponentCardCount: opponent ? (state.hands[opponent] || []).length : 0,
    discardTop: topCard(state),
    deckCount: state.deck.length,
    currentTurn: state.currentTurn,
    activeRule: state.activeRule,
    waitingForRule: state.waitingForRule,
    waitingForColor: state.waitingForColor,
    pendingDraw: state.pendingDraw,
    winner: state.winner,
    players: state.players,
    myId: playerId,
    opponentId: opponent,
    unoSaid: state.unoSaid,
    direction: state.direction,
    turnDeadline: state.turnDeadline
  };
}

function broadcast(roomCode, state) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const pid of state.players) {
    io.to(pid).emit('updateState', stateForPlayer(state, pid));
  }
}

function clearTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.turnTimer) return;
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
}

function startTurnTimer(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const state = room.state;
  if (!state.currentTurn || state.winner) return;

  clearTurnTimer(roomCode);

  const now = Date.now();
  state.turnDeadline = now + TURN_DURATION_MS;
  const currentPlayer = state.currentTurn;

  room.turnTimer = setTimeout(() => {
    const r = rooms[roomCode];
    if (!r) return;
    const s = r.state;
    if (s.winner) return;
    if (s.currentTurn !== currentPlayer) return;
    if (s.waitingForRule || s.waitingForColor) return;

    const pid = s.currentTurn;

    // Автоматичний добір карти при таймауті
    if (s.pendingDraw > 0) {
      drawCards(s, pid, s.pendingDraw);
      s.pendingDraw = 0;
      advanceTurn(s);
      broadcast(roomCode, s);
      startTurnTimer(roomCode);
      return;
    }

    drawCards(s, pid, 1);
    advanceTurn(s);
    broadcast(roomCode, s);
    startTurnTimer(roomCode);
  }, TURN_DURATION_MS);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // ── Створити кімнату ──
  socket.on('createRoom', ({ name }) => {
    const code = generateCode();
    const state = createGameState();
    state.players.push(socket.id);
    state.hands[socket.id] = [];
    rooms[code] = { state, names: { [socket.id]: name || 'Гравець 1' }, turnTimer: null };
    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code });
    console.log('Room created:', code);
  });

  // ── Приєднатись до кімнати ──
  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { msg: 'Кімнату не знайдено' });
    if (room.state.players.length >= 2) return socket.emit('error', { msg: 'Кімната вже повна' });

    room.state.players.push(socket.id);
    room.state.hands[socket.id] = [];
    room.names[socket.id] = name || 'Гравець 2';
    socket.join(code);
    socket.roomCode = code;

    // Обидва гравці — починаємо
    dealCards(room.state);
    room.state.currentTurn = room.state.players[0];

    // Повідомляємо обох імена
    io.to(code).emit('gameStart', {
      names: room.names,
      players: room.state.players
    });

    broadcast(code, room.state);
    startTurnTimer(code);
    console.log('Game started in room:', code);
  });

  // ── Зіграти карту ──
  socket.on('playCard', ({ cardIndex }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (state.winner) return;
    if (state.currentTurn !== socket.id) return socket.emit('error', { msg: 'Не ваш хід' });
    if (state.waitingForRule || state.waitingForColor) return;

    const hand = state.hands[socket.id];
    if (cardIndex < 0 || cardIndex >= hand.length) return;
    const card = hand[cardIndex];
    const top = topCard(state);

    // Перевірка на +2/+4 stacking
    if (state.pendingDraw > 0) {
      const canCounter = (card.value === '+2' && top.value === '+2') ||
                         (card.value === 'wild+4');
      if (!canCounter) return socket.emit('error', { msg: 'Треба взяти карти або відбити +2/+4' });
    }

    if (!canPlay(card, top, state)) {
      return socket.emit('error', { msg: 'Цю карту не можна зіграти' });
    }

    // Прибираємо карту з руки
    hand.splice(cardIndex, 1);
    state.discardPile.push(card);

    // UNO check
    if (hand.length === 1) {
      // якщо не сказав УНО — штраф пізніше при наступному ході
    }
    if (hand.length === 0) {
      state.winner = socket.id;
      clearTurnTimer(code);
      broadcast(code, state);
      return;
    }

    // Обробка ефектів
    if (card.value === '+2') {
      state.pendingDraw += 2;
      advanceTurn(state);
      // Наступний гравець має відбити або взяти
      applyPendingDraw(state, code);
      return;
    }

    if (card.value === 'wild+4') {
      state.pendingDraw += 4;
      state.waitingForColor = socket.id;
      broadcast(code, state);
      return;
    }

    if (card.value === 'wild') {
      state.waitingForColor = socket.id;
      broadcast(code, state);
      return;
    }

    if (card.value === 'newrule') {
      state.waitingForRule = true;
      state.waitingForColor = socket.id; // також обере колір після правила
      broadcast(code, state);
      return;
    }

    if (card.value === 'reverse') {
      state.direction *= -1;
      advanceTurn(state);
      broadcast(code, state);
      startTurnTimer(code);
      return;
    }

    if (card.value === 'skip') {
      advanceTurn(state, true);
      broadcast(code, state);
      startTurnTimer(code);
      return;
    }

    advanceTurn(state);
    broadcast(code, state);
    startTurnTimer(code);
  });

  function applyPendingDraw(state, code) {
    const nextPlayer = state.currentTurn;
    const hand = state.hands[nextPlayer];
    const top = topCard(state);
    // Перевіряємо чи є у наступного карти для відбиття
    const hasCounter = hand.some(c =>
      (top.value === '+2' && c.value === '+2') ||
      (c.value === 'wild+4')
    );
    if (!hasCounter) {
      // Автоматично даємо карти і передаємо хід
      drawCards(state, nextPlayer, state.pendingDraw);
      state.pendingDraw = 0;
      advanceTurn(state);
    }
    broadcast(code, state);
    startTurnTimer(code);
  }

  // ── Взяти карту з колоди ──
  socket.on('drawCard', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (state.winner) return;
    if (state.currentTurn !== socket.id) return socket.emit('error', { msg: 'Не ваш хід' });
    if (state.waitingForRule || state.waitingForColor) return;

    // Якщо є накопичений штраф — гравець вирішив взяти
    if (state.pendingDraw > 0) {
      drawCards(state, socket.id, state.pendingDraw);
      state.pendingDraw = 0;
      advanceTurn(state);
      broadcast(code, state);
      startTurnTimer(code);
      return;
    }

    drawCards(state, socket.id, 1);
    // Якщо щойно взята карта підходить — можна одразу зіграти (фронт вирішить)
    advanceTurn(state);
    broadcast(code, state);
    startTurnTimer(code);
  });

  // ── Обрати колір (після wild / wild+4 / newrule) ──
  socket.on('chooseColor', ({ color }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (state.waitingForColor !== socket.id) return;

    const top = topCard(state);
    top.chosenColor = color;
    state.waitingForColor = null;

    if (top.value === 'wild+4' && state.pendingDraw > 0) {
      advanceTurn(state);
      applyPendingDraw(state, code);
      return;
    }

    advanceTurn(state);
    broadcast(code, state);
    startTurnTimer(code);
  });

  // ── Встановити нове правило ──
  socket.on('setCustomRule', ({ rule, color }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (!state.waitingForRule) return;

    state.activeRule = rule.trim().substring(0, 200);
    state.waitingForRule = false;

    const top = topCard(state);
    top.chosenColor = color;
    state.waitingForColor = null;

    advanceTurn(state);
    broadcast(code, state);
    startTurnTimer(code);
  });

  // ── Сказати УНО ──
  socket.on('sayUno', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (state.hands[socket.id]?.length === 1) {
      state.unoSaid[socket.id] = true;
      io.to(code).emit('unoCalled', { playerId: socket.id, names: room.names });
    }
  });

  // ── Спіймати на УНО (суперник не сказав) ──
  socket.on('catchUno', ({ targetId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const state = room.state;

    if (
      state.hands[targetId]?.length === 1 &&
      !state.unoSaid[targetId]
    ) {
      drawCards(state, targetId, 2);
      io.to(code).emit('unoCaught', { targetId, names: room.names });
      broadcast(code, state);
    }
  });

  // ── Перепідключення після зміни сторінки ──
  socket.on('rejoinGame', ({ code, oldId }) => {
    const room = rooms[code];
    if (!room) return;

    const state = room.state;
    const pIndex = state.players.indexOf(oldId);

    if (pIndex !== -1) {
      // Замінюємо старий ID на новий
      state.players[pIndex] = socket.id;

      state.hands[socket.id] = state.hands[oldId];
      delete state.hands[oldId];

      room.names[socket.id] = room.names[oldId];
      delete room.names[oldId];

      if (state.currentTurn === oldId) state.currentTurn = socket.id;
      if (state.waitingForColor === oldId) state.waitingForColor = socket.id;
      if (state.winner === oldId) state.winner = socket.id;

      if (state.unoSaid[oldId] !== undefined) {
        state.unoSaid[socket.id] = state.unoSaid[oldId];
        delete state.unoSaid[oldId];
      }

      socket.roomCode = code;
      socket.join(code);

      // Оновлюємо стан обом гравцям
      broadcast(code, state);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    // Даємо 8 секунд на завантаження сторінки game.html
    setTimeout(() => {
      const room = rooms[code];
      // Якщо кімната ще існує і гравець так і не перепідключився (його старий ID все ще там)
      if (room && room.state.players.includes(socket.id)) {
        io.to(code).emit('opponentLeft');
        clearTurnTimer(code);
        delete rooms[code];
        console.log('Room', code, 'closed due to disconnect');
      }
    }, 8000);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
