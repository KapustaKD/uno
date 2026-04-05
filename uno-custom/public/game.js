// ─── Socket + State ───────────────────────────────────────────────────────────

const socket = io();

let myId = null;
let gameState = null;
let playerNames = {};
let selectedCardIndex = null;

// ─── Connect & Re-join ────────────────────────────────────────────────────────

socket.on('connect', () => {
  // Після підключення відновлюємо ім'я з sessionStorage (якщо є)
  const storedNames = sessionStorage.getItem('names');
  const storedPlayers = sessionStorage.getItem('players');
  if (storedNames) playerNames = JSON.parse(storedNames);
  if (storedPlayers) {
    // myId буде встановлено з першого updateState
  }
});

// ─── Socket Events ────────────────────────────────────────────────────────────

socket.on('updateState', (state) => {
  // Перший updateState встановлює myId
  if (!myId) {
    myId = state.myId;
  }

  // Оновлюємо імена якщо є
  if (!playerNames[state.myId]) {
    const stored = sessionStorage.getItem('names');
    if (stored) playerNames = JSON.parse(stored);
  }

  gameState = state;
  render(state);
});

socket.on('gameStart', ({ names, players }) => {
  playerNames = names;
  sessionStorage.setItem('names', JSON.stringify(names));
  sessionStorage.setItem('players', JSON.stringify(players));
});

socket.on('unoCalled', ({ playerId, names }) => {
  const name = names[playerId] || 'Гравець';
  showToast(`🗣️ ${name}: УНО!`, 2000);
});

socket.on('unoCaught', ({ targetId, names }) => {
  const name = names[targetId] || 'Гравець';
  showToast(`😱 ${name} спійманий без УНО! +2 карти`, 2500);
});

socket.on('opponentLeft', () => {
  hideAllOverlays();
  document.getElementById('opponent-left').classList.remove('hidden');
});

socket.on('error', ({ msg }) => {
  showToast(`⚠️ ${msg}`, 2000);
});

// ─── Render ───────────────────────────────────────────────────────────────────

function render(state) {
  if (!state) return;

  // Winner check
  if (state.winner) {
    showGameOver(state.winner === myId);
    return;
  }

  // Rule banner
  const ruleBanner = document.getElementById('rule-banner');
  const ruleText = document.getElementById('rule-text');
  if (state.activeRule) {
    ruleText.textContent = state.activeRule;
    ruleBanner.classList.remove('hidden');
  } else {
    ruleBanner.classList.add('hidden');
  }

  // Opponent info
  const oppName = getOpponentName(state);
  document.getElementById('opponent-name').textContent = oppName;
  const oppCount = state.opponentCardCount;
  document.getElementById('opponent-count').textContent =
    `${oppCount} ${cardWord(oppCount)}`;

  // Opponent card backs
  renderOpponentCards(state.opponentCardCount);

  // Turn indicators
  const isMyTurn = state.currentTurn === myId;
  document.getElementById('opponent-turn-indicator').classList.toggle('active', !isMyTurn);

  const status = document.getElementById('turn-status');
  if (state.waitingForRule) {
    if (state.waitingForColor === myId) {
      status.textContent = '✍️ Введіть нове правило';
      status.className = 'turn-status my-turn';
    } else {
      status.textContent = '⏳ Суперник придумує правило...';
      status.className = 'turn-status';
    }
  } else if (state.pendingDraw > 0 && state.currentTurn === myId) {
    status.textContent = `💀 Візьміть ${state.pendingDraw} карти або відбийте!`;
    status.className = 'turn-status my-turn';
  } else {
    status.textContent = isMyTurn ? '✅ Ваш хід' : `⏳ Хід суперника`;
    status.className = isMyTurn ? 'turn-status my-turn' : 'turn-status';
  }

  // Discard pile
  renderDiscardCard(state.discardTop);

  // Deck count
  document.getElementById('deck-count').textContent = `${state.deckCount} карт`;

  // Direction
  const dirIcon = document.getElementById('direction-icon');
  dirIcon.classList.toggle('reversed', state.direction === -1);

  // My hand
  renderHand(state);

  // UNO button pulse
  const unoBtn = document.getElementById('uno-btn');
  if (state.myHand && state.myHand.length === 1 && !state.unoSaid?.[myId]) {
    unoBtn.classList.add('pulsing');
  } else {
    unoBtn.classList.remove('pulsing');
  }

  // Overlays
  handleOverlays(state);
}

function renderOpponentCards(count) {
  const container = document.getElementById('opponent-cards-display');
  container.innerHTML = '';
  const show = Math.min(count, 12);
  for (let i = 0; i < show; i++) {
    const d = document.createElement('div');
    d.className = 'card-back-small';
    container.appendChild(d);
  }
}

function renderDiscardCard(card) {
  if (!card) return;
  const el = document.getElementById('discard-top');
  const effectiveColor = card.chosenColor || card.color;
  el.dataset.color = effectiveColor;

  const inner = el.querySelector('.card-inner');
  inner.innerHTML = '';

  // Oval decoration
  const oval = document.createElement('div');
  oval.className = 'card-oval';
  inner.appendChild(oval);

  const val = document.createElement('div');
  val.className = 'card-value';
  val.textContent = cardLabel(card.value);
  if (cardLabel(card.value).length > 3) val.classList.add('small');
  inner.appendChild(val);

  // Corner labels
  const tl = document.createElement('div');
  tl.className = 'card-corner tl';
  tl.textContent = cardLabel(card.value);
  inner.appendChild(tl);

  const br = document.createElement('div');
  br.className = 'card-corner br';
  br.textContent = cardLabel(card.value);
  inner.appendChild(br);
}

function renderHand(state) {
  const container = document.getElementById('my-hand');
  container.innerHTML = '';
  selectedCardIndex = null;

  if (!state.myHand) return;

  const isMyTurn = state.currentTurn === myId;
  const canAct = isMyTurn && !state.waitingForRule && !state.waitingForColor && !state.winner;

  state.myHand.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'hand-card card';
    el.dataset.color = card.color;
    el.dataset.index = i;

    const inner = document.createElement('div');
    inner.className = 'card-inner';

    const oval = document.createElement('div');
    oval.className = 'card-oval';
    inner.appendChild(oval);

    const val = document.createElement('div');
    val.className = 'card-value';
    val.textContent = cardLabel(card.value);
    if (cardLabel(card.value).length > 3) val.classList.add('small');
    inner.appendChild(val);

    const tl = document.createElement('div');
    tl.className = 'card-corner tl';
    tl.textContent = cardLabel(card.value);
    inner.appendChild(tl);

    const br = document.createElement('div');
    br.className = 'card-corner br';
    br.textContent = cardLabel(card.value);
    inner.appendChild(br);

    el.appendChild(inner);

    if (canAct) {
      const playable = isPlayable(card, state);
      if (playable) {
        el.classList.add('playable');
      } else {
        el.classList.add('not-playable');
      }
      el.addEventListener('click', () => onCardClick(i, card, playable));
    } else {
      el.classList.add('not-playable');
    }

    container.appendChild(el);
  });
}

function handleOverlays(state) {
  // Rule picker — тільки для того, хто кинув карту
  if (state.waitingForRule && state.waitingForColor === myId) {
    document.getElementById('rule-picker').classList.remove('hidden');
    document.getElementById('waiting-rule').classList.add('hidden');
    document.getElementById('color-picker').classList.add('hidden');
  } else if (state.waitingForRule && state.waitingForColor !== myId) {
    document.getElementById('waiting-rule').classList.remove('hidden');
    document.getElementById('rule-picker').classList.add('hidden');
    document.getElementById('color-picker').classList.add('hidden');
  } else if (state.waitingForColor === myId && !state.waitingForRule) {
    document.getElementById('color-picker').classList.remove('hidden');
    document.getElementById('rule-picker').classList.add('hidden');
    document.getElementById('waiting-rule').classList.add('hidden');
  } else {
    document.getElementById('color-picker').classList.add('hidden');
    document.getElementById('rule-picker').classList.add('hidden');
    document.getElementById('waiting-rule').classList.add('hidden');
  }
}

// ─── Card Interactions ────────────────────────────────────────────────────────

function onCardClick(index, card, playable) {
  if (!playable) {
    showToast('Цю карту не можна зіграти', 1500);
    return;
  }

  // Highlight selected
  document.querySelectorAll('.hand-card').forEach(el => el.classList.remove('selected'));
  const els = document.querySelectorAll('.hand-card');
  if (els[index]) els[index].classList.add('selected');

  // Маленька затримка для анімації
  setTimeout(() => {
    socket.emit('playCard', { cardIndex: index });
  }, 120);
}

function drawCard() {
  if (!gameState) return;
  if (gameState.currentTurn !== myId) {
    showToast('Зараз не ваш хід', 1500);
    return;
  }
  if (gameState.waitingForRule || gameState.waitingForColor) return;
  socket.emit('drawCard');
}

function sayUno() {
  socket.emit('sayUno');
  // Catch opponent?
  if (
    gameState &&
    gameState.opponentCardCount === 1 &&
    !gameState.unoSaid?.[gameState.opponentId]
  ) {
    socket.emit('catchUno', { targetId: gameState.opponentId });
  }
}

// ─── Color & Rule Overlays ────────────────────────────────────────────────────

function chooseColor(color) {
  socket.emit('chooseColor', { color });
  document.getElementById('color-picker').classList.add('hidden');
}

function submitRule(color) {
  const ruleInput = document.getElementById('rule-input');
  const rule = ruleInput.value.trim();
  if (!rule) {
    ruleInput.focus();
    showToast('Введіть правило!', 1500);
    return;
  }
  socket.emit('setCustomRule', { rule, color });
  ruleInput.value = '';
  document.getElementById('char-count').textContent = '0';
  document.getElementById('rule-picker').classList.add('hidden');
}

// Char counter
const ruleInput = document.getElementById('rule-input');
if (ruleInput) {
  ruleInput.addEventListener('input', () => {
    document.getElementById('char-count').textContent = ruleInput.value.length;
  });
}

// ─── Game Over ────────────────────────────────────────────────────────────────

function showGameOver(iWon) {
  hideAllOverlays();
  const overlay = document.getElementById('game-over');
  document.getElementById('win-icon').textContent = iWon ? '🏆' : '😔';
  document.getElementById('win-text').textContent = iWon ? 'Ви перемогли!' : 'Ви програли...';
  overlay.classList.remove('hidden');
}

function hideAllOverlays() {
  ['color-picker','rule-picker','waiting-rule','game-over','opponent-left']
    .forEach(id => document.getElementById(id).classList.add('hidden'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPlayable(card, state) {
  if (!state.discardTop) return false;
  if (card.type === 'wild' || card.type === 'newrule') return true;
  if (card.value === 'wild+4') return true;

  // Stacking rules
  if (state.pendingDraw > 0) {
    const top = state.discardTop;
    return (card.value === '+2' && top.value === '+2') || card.value === 'wild+4';
  }

  const effectiveColor = state.discardTop.chosenColor || state.discardTop.color;
  return card.color === effectiveColor || card.value === state.discardTop.value;
}

function cardLabel(value) {
  const map = {
    'wild': '🌈',
    'wild+4': '+4',
    'newrule': '📜',
    'reverse': '↺',
    'skip': '⊘',
    '+2': '+2',
  };
  return map[value] ?? value;
}

function cardWord(n) {
  if (n === 1) return 'карта';
  if (n >= 2 && n <= 4) return 'карти';
  return 'карт';
}

function getOpponentName(state) {
  const oppId = state.opponentId;
  if (playerNames[oppId]) return playerNames[oppId];
  return 'Суперник';
}

function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ─── Pending draw banner (insert into DOM if needed) ─────────────────────────

// Додаємо банер між status і hand
const statusEl = document.getElementById('turn-status');
const pendingBanner = document.createElement('div');
pendingBanner.className = 'pending-draw-banner';
pendingBanner.id = 'pending-draw-banner';
statusEl.after(pendingBanner);

// Патчимо render щоб показував банер
const _origRender = render;
// (вже вбудовано в основний render вище)

// Слідкуємо за pendingDraw в стані
socket.on('updateState', (state) => {
  const banner = document.getElementById('pending-draw-banner');
  if (banner) {
    if (state.pendingDraw > 0 && state.currentTurn === myId) {
      banner.textContent = `💥 На вас летить +${state.pendingDraw}! Відбийте картою або натисніть на колоду`;
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
  }
});
