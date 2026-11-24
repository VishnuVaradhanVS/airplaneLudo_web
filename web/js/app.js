// Airplane Ludo - web client.
// Speaks the same WebSocket protocol as the Android app (see backend Main.kt / GamePackets.kt).
import { redBase, blueBase, redPath, bluePath, safe, ROWS, COLS } from './paths.js';
import * as G from './game.js';
import { Connection } from './net.js';
import { AudioManager } from './audio.js';

/* ====================================================================== */
/* helpers                                                                */
/* ====================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2.25c-3.01 0-9 1.51-9 4.5V21h18v-2.25c0-2.99-5.99-4.5-9-4.5z"/></svg>',
  exit: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
};
const svg = (key) => { const s = document.createElement('span'); s.innerHTML = ICONS[key]; return s.firstChild; };

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.classList.remove('show', 'alert');
  void el.offsetWidth; // restart the pop-in animation
  const parts = [];
  if (kind === 'alert') {
    const icon = h('span', { class: 't-icon' });
    icon.innerHTML = ICONS.person;
    parts.push(icon);
  }
  parts.push(h('span', {}, msg));
  el.replaceChildren(...parts);
  if (kind === 'alert') el.classList.add('alert');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'alert' ? 4200 : 2600);
}

/* ====================================================================== */
/* config                                                                 */
/* ====================================================================== */
const isLocalHostname = (n) =>
  n === 'localhost' || n === '[::1]' || /^127\./.test(n) || /\.local$/.test(n) ||
  /^10\./.test(n) || /^192\.168\./.test(n) || /^172\.(1[6-9]|2\d|3[01])\./.test(n);

function backendBase() {
  let url = (window.APP_CONFIG && window.APP_CONFIG.BACKEND_WS_URL) || 'wss://airplaneludo-backend.onrender.com/ludo';
  const override = new URLSearchParams(location.search).get('server');
  if (override && isLocalHostname(location.hostname)) url = override; // dev convenience only
  if (url.startsWith('/')) url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + url;
  return url.replace(/\/+$/, '');
}
const BACKEND = backendBase();

/** Render's free tier sleeps when idle. A plain HTTP hit wakes it while the user is still typing their name. */
function warmUpBackend() {
  try {
    const u = new URL(BACKEND.replace(/^ws/, 'http'));
    fetch(u.origin + '/', { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ====================================================================== */
/* state                                                                  */
/* ====================================================================== */
const audio = new AudioManager();

const S = {
  screen: 'dashboard',
  name: localStorage.getItem('ludo.name') || '',
  roomId: null,
  conn: null,
  connStatus: { state: 'idle', attempt: 0, max: 0 },
  ack: false,
  roomInGame: false,
  player: null,          // me, as last reported by the server
  host: null,
  room: null,
  redPlayers: [], bluePlayers: [],
  baseTokenCount: 6,
  optionsFor: null,      // lobby: player id whose SWAP/KICK row is open
  // game
  currentPlayer: null,
  tokens: { RED: [], BLUE: [] },
  homeEnabled: { RED: false, BLUE: false },
  baseCount: { RED: 0, BLUE: 0 },
  homeCount: { RED: 0, BLUE: 0 },
  dice: [0, 0], shuffle: [0, 0], rolling: false,
  pool: {}, pendingPool: null, serverPoolTotal: 0,
  selected: 0,
  canRoll: false, canMove: false,
  tokenInMotion: false, processing: false,
  flash: null, moveLock: false, rollLock: false,
  gameOver: false, winner: null,
};
if (new URLSearchParams(location.search).has('debug')) window.__ludo = { S, audio, renderGame };

const meIsCurrent = () => !!(S.player && S.currentPlayer && S.player.id === S.currentPlayer.id);
const myTeam = () => S.player && S.player.team;

/* ====================================================================== */
/* navigation                                                             */
/* ====================================================================== */
function showScreen(name) {
  S.screen = name;
  for (const id of ['dashboard', 'lobby', 'game']) $('#screen-' + id).hidden = id !== name;
  document.body.style.background = name === 'game' ? '#000' : '';
  audio.wantMusic(name !== 'game');
  window.scrollTo(0, 0);
  renderAll();
}

function resetSession() {
  S.roomId = null; S.ack = false; S.roomInGame = false; S.player = null; S.host = null; S.room = null;
  S.redPlayers = []; S.bluePlayers = []; S.optionsFor = null;
  S.currentPlayer = null; S.tokens = { RED: [], BLUE: [] };
  S.homeEnabled = { RED: false, BLUE: false }; S.baseCount = { RED: 0, BLUE: 0 }; S.homeCount = { RED: 0, BLUE: 0 };
  S.dice = [0, 0]; S.pool = {}; S.pendingPool = null; S.serverPoolTotal = 0; S.selected = 0;
  S.canRoll = false; S.canMove = false; S.tokenInMotion = false; S.rolling = false; S.processing = false;
  S.gameOver = false; S.winner = null; S.flash = null;
  queue.length = 0;
  closeModal();
}

function leaveRoom() {
  if (S.conn) { S.conn.close(); S.conn = null; }
  resetSession();
  showScreen('dashboard');
}

/* ====================================================================== */
/* connecting                                                             */
/* ====================================================================== */
function startConnect(roomId) {
  audio.click();
  if (S.conn) { S.conn.close(); S.conn = null; }
  resetSession();
  S.roomId = roomId;
  S.connStatus = { state: 'connecting', attempt: 1, max: 8 };
  S.conn = new Connection({
    baseUrl: BACKEND,
    onPacket: onPacket,
    onStatus: (st) => { S.connStatus = st; if (S.screen === 'lobby') renderLobby(); },
    onClose: onConnectionClosed,
  });
  S.conn.connect(roomId, S.name.trim());
  showScreen('lobby');
}

function onConnectionClosed(info) {
  S.conn = null;
  let msg;
  if (info.code === 1008) msg = S.roomInGame ? 'Room already in game' : 'You were kicked from the room by the host';
  else if (info.code === 1001) msg = 'Room has been closed by the host';
  else if (!info.wasOpen) msg = 'Could not reach the game server. Please check your connection and try again.';
  else msg = 'Check the network connection';
  queue.length = 0;
  showModal({ title: 'INFO', message: msg, tone: 'white', actions: [{ label: 'OK', onClick: () => { resetSession(); showScreen('dashboard'); } }], dismissible: false });
}

/* ====================================================================== */
/* incoming packets (processed strictly in order, like the Android app)   */
/* ====================================================================== */
const queue = [];
let draining = false;

function onPacket(pkt) {
  queue.push(pkt);
  if (!draining) drain();
}

async function drain() {
  draining = true;
  S.processing = true;
  try {
    while (queue.length) {
      const pkt = queue.shift();
      try { await handlePacket(pkt); } catch (e) { console.error('packet error', e, pkt); }
    }
  } finally {
    draining = false;
    S.processing = false;
    renderAll();
  }
}

async function handlePacket(p) {
  switch (p.lobbyAction) {
    case 'RoomUpdate': updateRoomState(p.room); break;
    case 'PlayerAck': updatePlayerState(p.player); S.ack = true; renderAll(); break;
    case 'RoomInGame': S.roomInGame = true; break;
    default: break;
  }
  switch (p.gameAction) {
    case 'StartGame': onStartGame(); break;
    case 'AnimateTokenMovement': await animateTokenMovement(p.moveTokenId, S.currentPlayer ? S.currentPlayer.team : G.RED, p.selectedValue); break;
    case 'SpawnToken': audio.spawn(); break;
    case 'EndGame': onEndGame(); break;
    case 'LeaveGame': onPlayerLeft(p.player); break;
    default: break;
  }
}

function updatePlayerState(p) {
  if (!p) return;
  S.player = p;
  S.canRoll = p.playerGameState === 'Rolling';
  S.canMove = p.playerGameState === 'Moving';
}

function updateRoomState(room) {
  if (!room) return;
  S.room = room;
  S.ack = true;
  S.baseTokenCount = room.baseTokenCount;
  const players = room.players || [];
  S.host = players.find((p) => p.id === room.hostId) || null;
  const me = S.player && players.find((p) => p.id === S.player.id);
  if (me) updatePlayerState(me);
  if (room.game) updateGameState(room.game);
  S.redPlayers = players.filter((p) => p.team === 'RED');
  S.bluePlayers = players.filter((p) => p.team === 'BLUE');
  renderAll();
}

function updateGameState(game) {
  if (S.player && game.currentPlayer && S.player.id === game.currentPlayer.id) updatePlayerState(game.currentPlayer);
  S.currentPlayer = (S.room && S.room.game && S.room.game.currentPlayer) || game.currentPlayer || null;
  S.tokens = { RED: G.normalizeTokens(game.redTokens), BLUE: G.normalizeTokens(game.blueTokens) };
  S.homeEnabled = { RED: !!game.redHomeEnabled, BLUE: !!game.blueHomeEnabled };
  S.baseCount = { RED: game.redBaseCount, BLUE: game.blueBaseCount };
  S.homeCount = { RED: game.redHomeCount, BLUE: game.blueHomeCount };
  S.dice = [game.diceValue.d1, game.diceValue.d2];

  // The server never says "a roll happened"; the pool simply grows by one entry when it does.
  const newPool = G.normalizePool(game.diceDenomination);
  const total = G.poolTotal(newPool);
  const rolled = total > S.serverPoolTotal;
  S.serverPoolTotal = total;
  if (rolled) {
    startRollAnimation();
    schedulePool(newPool, 800); // reveal the pool after the dice settle (Android uses the same 800 ms)
  } else {
    applyPool(newPool);
  }
}

let poolTimer = null;
function schedulePool(pool, ms) {
  S.pendingPool = pool;
  clearTimeout(poolTimer);
  poolTimer = setTimeout(() => { const p = S.pendingPool; S.pendingPool = null; if (p) applyPool(p); }, ms);
}
function applyPool(pool) {
  clearTimeout(poolTimer);
  S.pendingPool = null;
  S.pool = pool;
  if (S.selected && !pool[S.selected]) S.selected = 0;
  if (S.screen === 'game') renderGame();
}

function onStartGame() {
  S.gameOver = false; S.winner = null; S.selected = 0; S.rolling = false; S.flash = null;
  closeModal();
  showScreen('game');
  buildGame();
  renderGame();
}

function onEndGame() {
  const base = S.baseTokenCount;
  let winner = S.currentPlayer ? S.currentPlayer.team : G.RED;
  if (S.homeCount.RED >= base) winner = G.RED; else if (S.homeCount.BLUE >= base) winner = G.BLUE;
  S.gameOver = true; S.winner = winner;
  showModal({
    title: 'GAME OVER',
    message: winner === G.RED ? 'RED TEAM WON' : 'BLUE TEAM WON',
    tone: winner === G.RED ? 'red' : 'blue',
    actions: [{ label: 'EXIT', onClick: () => { closeModal(); S.gameOver = false; showScreen('lobby'); } }],
    dismissible: false,
  });
}

function onPlayerLeft(player) {
  const nm = (player && player.name) || 'A player';
  if (S.screen === 'game') {
    showModal({ title: 'INFO', message: `${nm} left the game`, tone: 'white', actions: [{ label: 'OK', onClick: closeModal }] });
  } else if (!player || !S.player || player.id !== S.player.id) {
    toast(`${nm} left the room`, 'alert');
  }
}

/* ====================================================================== */
/* sending                                                                */
/* ====================================================================== */
const send = (pkt) => !!(S.conn && S.conn.send(pkt));

function swapTeam(player) { audio.click(); send({ lobbyAction: 'SwapTeam', player }); }
function kickPlayer(player) { audio.click(); send({ lobbyAction: 'Kick', player }); }
function changeTokenCount(n) {
  if (!S.host || !S.player || S.host.id !== S.player.id || !S.room) return;
  audio.click();
  S.baseTokenCount = n;
  renderLobby();
  send({ lobbyAction: 'ChangeTokenCount', room: { id: S.room.id, hostId: S.room.hostId, baseTokenCount: n, inGame: false } });
}
function startMatch() { audio.click(); send({ gameAction: 'StartGame' }); }

function onDiceClick() {
  if (!S.canRoll || S.rolling || S.processing || S.rollLock || S.gameOver) return;
  S.rollLock = true;
  setTimeout(() => { S.rollLock = false; }, 700);
  send({ gameAction: 'RollDice' });
}

function selectValue(v) {
  if (!S.canMove || S.processing) return;
  audio.click();
  S.selected = v;
  renderGame();
}

function trySpawn(team) {
  if (!S.canMove || !meIsCurrent() || myTeam() !== team) return;
  if (S.selected !== 1 && S.selected !== 5) return;
  if (S.baseCount[team] <= 0 || S.processing) return;
  send({ gameAction: 'SpawnToken', selectedValue: S.selected });
}

function onBoardCell(x, y) {
  if (!S.canMove || !meIsCurrent() || S.selected === 0 || S.tokenInMotion || S.processing || S.moveLock) return;
  const team = myTeam();
  const here = S.tokens[team].filter((t) => t.position >= 0 && G.sameCords(G.cordsOf(team, t.position), [x, y]));
  if (!here.length) return;
  const tok = here[here.length - 1];
  if (tok.position + S.selected > G.LAST_POS) return;
  S.moveLock = true;
  setTimeout(() => { S.moveLock = false; }, 700);
  send({ gameAction: 'AnimateTokenMovement', selectedValue: S.selected, moveTokenId: tok.id });
  send({ gameAction: 'MoveToken', selectedValue: S.selected, moveTokenId: tok.id });
}

/* ====================================================================== */
/* animations (mirrors GameViewModel.animateTokenMovement)                */
/* ====================================================================== */
async function animateTokenMovement(tokenId, team, step) {
  if (!step) return;
  if (S.pool[step]) { S.pool[step] -= 1; if (!S.pool[step]) delete S.pool[step]; }
  const mine = S.tokens[team];
  const idx = mine.findIndex((t) => t.id === tokenId);
  if (idx !== -1) {
    S.tokenInMotion = true;
    for (let i = 0; i < step; i++) {
      audio.token();
      mine[idx] = G.stepForward(mine[idx], S.homeEnabled[team]);
      renderGame();
      await G.sleep(400);
    }
    S.tokenInMotion = false;

    if (mine[idx].position >= G.LAST_POS) {            // reached home
      S.homeCount[team] += 1;
      audio.home();
      flashHome(team);
      mine[idx] = { ...mine[idx], position: -1 };
    }
    const landed = mine[idx].position >= 0 ? G.cordsOf(team, mine[idx].position) : null;
    if (landed && !G.isSafeCell(landed)) {              // capture
      const opp = G.otherTeam(team);
      const theirs = S.tokens[opp];
      for (let i = 0; i < theirs.length; i++) {
        if (theirs[i].position < 0 || !G.sameCords(G.cordsOf(opp, theirs[i].position), landed)) continue;
        S.homeEnabled[team] = true;
        audio.kill();
        while (theirs[i].position > -1) {               // captured token walks back to its base
          theirs[i] = G.stepBackward(theirs[i]);
          renderGame();
          await G.sleep(50);
        }
        S.baseCount[opp] += 1;
      }
    }
  }
  S.tokenInMotion = false;
  S.selected = 0;
  renderGame();
}

let flashTimer = null;
function flashHome(team) {
  clearInterval(flashTimer);
  let n = 0;
  flashTimer = setInterval(() => {
    S.flash = n % 2 === 0 ? team : null;
    renderBoardFlash();
    if (++n >= 6) { clearInterval(flashTimer); S.flash = null; renderBoardFlash(); }
  }, 300);
}

let rollTimer = null;
function startRollAnimation() {
  clearInterval(rollTimer);
  S.rolling = true;
  audio.dice();
  const t0 = performance.now();
  document.querySelectorAll('#dice .die').forEach((el) => {
    if (el.animate) el.animate([{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(720deg)' }], { duration: 800, easing: 'ease-in-out' });
  });
  rollTimer = setInterval(() => {
    S.shuffle = [Math.floor(Math.random() * 4), Math.floor(Math.random() * 4)];
    if (performance.now() - t0 >= 800) { clearInterval(rollTimer); S.rolling = false; }
    renderDice();
  }, 60);
}

/* ====================================================================== */
/* modal                                                                  */
/* ====================================================================== */
function showModal({ title, message, tone = 'white', actions = [], dismissible = false }) {
  const root = $('#modal');
  const dlg = h('div', { class: `dialog ${tone === 'white' ? '' : tone}`, role: 'dialog', 'aria-modal': 'true' },
    dismissible ? h('button', { class: 'icon-btn close', 'aria-label': 'Close', onclick: () => { audio.click(); closeModal(); } }, '\u00d7') : null,
    h('h2', { class: 'dialog-title' }, title),
    h('p', { class: `dialog-msg ${tone === 'white' ? '' : tone}` }, message),
    h('div', { class: 'stack' }, actions.map((a) => h('button', { class: 'btn btn-white wide', onclick: () => { audio.click(); a.onClick(); } }, a.label))));
  root.replaceChildren(dlg);
  root.hidden = false;
}
function closeModal() { const r = $('#modal'); r.hidden = true; r.replaceChildren(); }

function showExitModal() {
  showModal({
    title: 'ALERT', message: 'LEAVE GAME ?', tone: myTeam() === 'RED' ? 'red' : 'blue', dismissible: true,
    actions: [{ label: 'EXIT', onClick: leaveRoom }],
  });
}

/* ====================================================================== */
/* dashboard + join + rules                                               */
/* ====================================================================== */
function initDashboard() {
  const nameInput = $('#name-input');
  nameInput.value = S.name;
  nameInput.addEventListener('input', () => { S.name = nameInput.value; localStorage.setItem('ludo.name', S.name); });

  $('#btn-create').addEventListener('click', () => {
    warmUpBackend();
    startConnect(Math.floor(Math.random() * 9000) + 1000);
  });
  $('#btn-join').addEventListener('click', () => { audio.click(); warmUpBackend(); openJoin(); });
  $('#join-close').addEventListener('click', () => { audio.click(); $('#join-dialog').hidden = true; });
  $('#join-go').addEventListener('click', doJoin);
  $('#room-input').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $('#room-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('#btn-rules').addEventListener('click', () => { audio.click(); openRules(); });
  $('#rules-close').addEventListener('click', () => { audio.click(); $('#rules').hidden = true; pauseRuleVideos(); });
  const musicBtn = $('#btn-music');
  const paintMusic = () => { musicBtn.classList.toggle('on', audio.musicEnabled); musicBtn.setAttribute('aria-pressed', String(audio.musicEnabled)); };
  paintMusic();
  musicBtn.addEventListener('click', () => { audio.setMusicEnabled(!audio.musicEnabled); audio.click(); paintMusic(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#join-dialog').hidden) $('#join-dialog').hidden = true;
    else if (!$('#rules').hidden) { $('#rules').hidden = true; pauseRuleVideos(); }
  });
}

function openJoin(prefill) {
  const input = $('#room-input');
  if (prefill) input.value = prefill;
  $('#join-dialog').hidden = false;
  setTimeout(() => input.focus(), 50);
}

function doJoin() {
  const raw = $('#room-input').value.trim();
  const n = Number(raw);
  if (!/^\d{1,9}$/.test(raw) || n < 1) { toast('Enter a valid room code'); return; }
  $('#join-dialog').hidden = true;
  startConnect(n);
}

const RULES = [
  ['h', 'TEAM SETUP'],
  ['p', 'The game consists of 2 teams (RED and BLUE). The players join either team with turns alternating between RED and BLUE in a loop (Red1 -> Blue1 -> Red2 -> Blue2 -> .... -> Red1).'],
  ['v', 'lobby'],
  ['p', 'Each team starts with 4 or 6 or 8 or 12 tokens in their base.'],
  ['v', 'tokencount'],
  ['h', 'OBJECTIVE'],
  ['p', 'Be the first team to move all your tokens from the base to the home destination.'],
  ['v', 'hometoken'],
  ['h', 'DICE MECHANICS'],
  ['p', 'Rolled using two 4-sided dice (0,1,2,3), the sum of the 2 dice is obtained as the resultant value for the turn. Rolling (0,0) results in a total value of 12. Rolling 1 or 5 or 6 or 12 provides additional turn. The rolling values are accumulated in a pool until the turn is terminated by a 2 or 3 or 4.'],
  ['v', 'movement'],
  ['h', 'GAME MECHANICS'],
  ['p', 'Initially each player must roll a 1 to enable their contribution for moving the tokens. Tokens at base can be spawned using 1 or 5.'],
  ['v', 'spawntoken'],
  ['p', 'Based on the accumulated pool of dice values, players can strategically move the tokens to reach home.'],
  ['v', 'movement'],
  ['p', "Each team must capture atleast one of the opponent team's token to enable the path to home. Capturing an opponent's token awards 1 additional bonus turn per capture for that round. Multiple tokens on the same tile can also be captured."],
  ['v', 'capturetoken'],
  ['p', 'Tokens in safe cells on the map cannot be captured.'],
  ['v', 'safe'],
  ['p', 'Tokens are allowed to enter the path towards home only after a capture.'],
  ['v', 'homepath'],
  ['p', 'If path to home is not enabled, tokens when moved are forced to loop the path.'],
  ['v', 'looppath'],
  ['p', 'Rolling an invalid pool of values causes the current turn to terminate.'],
];
let rulesBuilt = false;
let videoObserver = null;
function openRules() {
  const body = $('#rules-body');
  if (!rulesBuilt) {
    rulesBuilt = true;
    for (const [type, val] of RULES) {
      if (type === 'h') body.append(h('h3', {}, val));
      else if (type === 'p') body.append(h('p', {}, val));
      else body.append(h('video', { 'data-src': `assets/video/${val}.mp4`, muted: true, loop: true, playsinline: true, preload: 'none', 'aria-hidden': 'true' }));
    }
    videoObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const v = en.target;
        if (en.isIntersecting) {
          if (!v.src) v.src = v.dataset.src;
          v.muted = true;
          const p = v.play(); if (p && p.catch) p.catch(() => {});
        } else v.pause();
      }
    }, { root: body, threshold: 0.4 });
    body.querySelectorAll('video').forEach((v) => videoObserver.observe(v));
  }
  $('#rules').hidden = false;
  body.scrollTop = 0;
}
function pauseRuleVideos() { document.querySelectorAll('#rules video').forEach((v) => v.pause()); }

/* ====================================================================== */
/* lobby                                                                  */
/* ====================================================================== */
function inviteLink() {
  return `${location.origin}${location.pathname}?room=${S.roomId}`;
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (e) { window.prompt('Copy this:', text); }
}

function playerTile(p) {
  const isMe = S.player && p.id === S.player.id;
  const iAmHost = S.host && S.player && S.host.id === S.player.id;
  const clickable = iAmHost && !isMe;
  const tile = h('div', {
    class: `player ${isMe ? 'me' : ''} ${clickable ? 'clickable' : ''}`,
    onclick: clickable ? () => { audio.click(); S.optionsFor = S.optionsFor === p.id ? null : p.id; renderLobby(); } : null,
  });
  const swapArrow = isMe ? h('button', { class: 'swap-btn', 'aria-label': 'Swap team', onclick: (e) => { e.stopPropagation(); swapTeam(S.player); } }, p.team === 'RED' ? '\u00bb' : '\u00ab') : null;
  tile.append(h('div', { class: 'line' },
    p.team === 'BLUE' ? swapArrow : null,
    h('span', { class: 'pname', title: p.name }, p.name),
    p.team === 'RED' ? swapArrow : null));
  if (clickable && S.optionsFor === p.id) {
    tile.append(h('div', { class: 'opts' },
      h('button', { class: 'o-swap', onclick: (e) => { e.stopPropagation(); S.optionsFor = null; swapTeam(p); } }, 'SWAP'),
      h('button', { class: 'o-kick', onclick: (e) => { e.stopPropagation(); S.optionsFor = null; kickPlayer(p); } }, 'KICK')));
  }
  return tile;
}

function renderLobby() {
  const root = $('#screen-lobby');
  if (S.screen !== 'lobby') return;

  if (!S.ack) {
    const st = S.connStatus;
    const waking = st.state === 'waking';
    root.replaceChildren(h('div', { class: 'lobby connecting' },
      h('div', { class: 'lobby-top' }, h('button', { class: 'pill', onclick: () => { audio.click(); leaveRoom(); } }, 'CANCEL'), h('h1', { class: 'lobby-title' }, `ROOM ${S.roomId}`)),
      h('div', { class: 'panel' },
        h('div', { class: 'spinner' }),
        h('h2', { class: 'grad-text' }, waking ? 'WAKING UP THE SERVER' : 'CONNECTING'),
        h('p', { class: 'note' }, waking
          ? `The free server sleeps when idle and can take up to a minute to start. Attempt ${Math.min(st.attempt, st.max)} of ${st.max}...`
          : 'Joining the room...'))));
    return;
  }

  const iAmHost = !!(S.host && S.player && S.host.id === S.player.id);
  const canStart = iAmHost && S.redPlayers.length > 0 && S.bluePlayers.length > 0;
  const teamCol = (cls, label, list) => h('section', { class: `team ${cls}` },
    h('h3', {}, label),
    list.map(playerTile));

  root.replaceChildren(h('div', { class: 'lobby' },
    h('div', { class: 'lobby-top' },
      h('button', { class: 'pill', onclick: () => { audio.click(); leaveRoom(); } }, 'EXIT'),
      h('h1', { class: 'lobby-title grad-text' }, S.host ? `${S.host.name}'s ROOM` : '')),
    h('div', { class: 'room-code' },
      h('span', { class: 'label' }, 'ROOM CODE'),
      h('span', { class: 'code' }, String(S.roomId)),
      h('div', { class: 'actions' },
        h('button', { class: 'pill', onclick: () => { audio.click(); copyText(String(S.roomId), 'Room code copied'); } }, 'COPY CODE'),
        h('button', { class: 'pill', onclick: () => { audio.click(); copyText(inviteLink(), 'Invite link copied'); } }, 'COPY LINK'))),
    h('div', { class: 'teams' }, teamCol('red', 'RED TEAM', S.redPlayers), teamCol('blue', 'BLUE TEAM', S.bluePlayers)),
    h('div', { class: 'tokens-picker' },
      h('div', { class: 'tp-head' }, h('span', { class: 'tp-label' }, 'TOKEN COUNT'), h('span', { class: 'tp-count' }, String(S.baseTokenCount))),
      h('div', { class: 'tc-grid' }, [4, 6, 8, 12].map((n) =>
        h('button', { class: `tc ${S.baseTokenCount === n ? 'sel' : ''}`, disabled: !iAmHost, 'aria-label': `${n} tokens`, onclick: () => changeTokenCount(n) },
          h('div', { class: 'dots', style: `--cols:${n === 6 ? 3 : 4}` }, Array.from({ length: n }, () => h('span', { class: 'dot' }))),
          `${n} Tokens`)))),
    h('button', { class: `btn btn-white anim-text start wide ${iAmHost ? '' : 'waiting'}`, disabled: !canStart, onclick: startMatch }, iAmHost ? 'START MATCH' : 'WAITING'),
    iAmHost && !canStart ? h('p', { class: 'note lobby-note' }, 'Both teams need at least one player. Share the room code with friends.') : null));
}

/* ====================================================================== */
/* game screen                                                            */
/* ====================================================================== */
const cellEls = new Map();   // "x,y" -> element (path cells)
const baseEls = {};          // team -> {homeCell, homeNum, baseCell, baseNum, homeCell2, baseCell2}
const cellSig = new Map();
let ui = {};

function buildGame() {
  const root = $('#screen-game');
  cellEls.clear(); cellSig.clear();

  const pathKeys = new Set([...redPath, ...bluePath].map(([x, y]) => G.cellKey(x, y)));
  const redBaseKeys = new Map(redBase.map(([x, y]) => [G.cellKey(x, y), [x, y]]));
  const blueBaseKeys = new Map(blueBase.map(([x, y]) => [G.cellKey(x, y), [x, y]]));

  const board = h('div', { class: 'board', id: 'board' });
  baseEls.RED = {}; baseEls.BLUE = {};
  for (let x = 0; x < ROWS; x++) {
    for (let y = 0; y < COLS; y++) {
      const k = G.cellKey(x, y);
      let el;
      if (pathKeys.has(k)) {
        el = h('div', { class: 'cell path', 'data-x': x, 'data-y': y, onclick: () => onBoardCell(x, y) });
        if (G.SAFE.has(k)) el.classList.add('safe');
        if (x === redPath[0][0] && y === redPath[0][1]) el.classList.add('start-red');
        if (x === bluePath[0][0] && y === bluePath[0][1]) el.classList.add('start-blue');
        if (x === 2 && y === 6) { el.classList.add('home-cell'); el.append(h('span', { class: 'homeicon', id: 'goal-icon' }, svg('home'))); }
        cellEls.set(k, el);
      } else if (redBaseKeys.has(k) || blueBaseKeys.has(k)) {
        const team = redBaseKeys.has(k) ? 'RED' : 'BLUE';
        const cls = team.toLowerCase();
        el = h('div', { class: `cell base ${cls}` });
        const first = y === (team === 'RED' ? 2 : 9);
        const isHomeCol = x === 14;
        const slot = baseEls[team];
        if (isHomeCol && first) { el.append(svg('home')); slot.homeCell = el; }
        else if (isHomeCol) { const n = h('span', { class: 'num' }, '0'); el.append(n); slot.homeNum = n; slot.homeCell2 = el; }
        else if (first) { el.append(svg('add')); slot.spawn = el; el.addEventListener('click', () => trySpawn(team)); }
        else { const n = h('span', { class: 'num' }, '0'); el.append(n); slot.baseNum = n; }
      } else {
        el = h('div', { class: 'cell' });
      }
      board.append(el);
    }
  }

  ui.turn = h('div', { class: 'turn', id: 'turn' });
  ui.pool = h('div', { class: 'pool', id: 'pool' });
  ui.die1 = h('div', { class: 'die' }); ui.die2 = h('div', { class: 'die' });
  ui.dice = h('div', { class: 'dice', id: 'dice', onclick: onDiceClick, role: 'button', 'aria-label': 'Roll dice' }, ui.die1, ui.die2);
  ui.board = board;

  root.replaceChildren(h('div', { class: 'game' },
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn exit-btn', 'aria-label': 'Leave game', onclick: () => { audio.click(); showExitModal(); } }, svg('exit')),
      ui.turn, h('div')),
    h('div', { class: 'game-body' },
      h('div', { class: 'board-wrap' }, board),
      h('div', { class: 'controls' }, ui.pool, ui.dice))));

  if (window.ResizeObserver) {
    new ResizeObserver(() => { root.style.setProperty('--cell', `${board.clientWidth / COLS}px`); }).observe(board);
  }
  root.style.setProperty('--cell', `${board.clientWidth / COLS}px`);
}

function renderGame() {
  if (S.screen !== 'game' || !ui.board) return;
  // title
  const cur = S.currentPlayer;
  ui.turn.textContent = cur ? `${cur.name}'s TURN` : 'AIRPLANE LUDO';
  ui.turn.className = `turn ${cur && cur.team === 'BLUE' ? 'blue' : 'red'}`;
  // goal icon tint (Android tints it with the local player's team)
  const goal = $('#goal-icon');
  if (goal) goal.className = `homeicon ${myTeam() === 'RED' ? 'red' : 'blue'}`;

  renderBases();
  renderBoard();
  renderPool();
  renderDice();
}

function renderBases() {
  for (const team of ['RED', 'BLUE']) {
    const b = baseEls[team];
    const locked = !S.homeEnabled[team];
    b.homeCell.classList.toggle('locked', locked);
    b.homeCell2.classList.toggle('locked', locked);
    b.homeNum.textContent = S.homeCount[team];
    b.baseNum.textContent = S.baseCount[team];
    const canSpawn = S.canMove && meIsCurrent() && myTeam() === team && (S.selected === 1 || S.selected === 5) && S.baseCount[team] > 0 && !S.processing;
    b.spawn.classList.toggle('spawnable', canSpawn);
  }
}

function renderBoardFlash() {
  if (!ui.board) return;
  ui.board.classList.toggle('flash-red', S.flash === 'RED');
  ui.board.classList.toggle('flash-blue', S.flash === 'BLUE');
}

function renderBoard() {
  // gather tokens per cell
  const byCell = new Map();
  for (const team of ['RED', 'BLUE']) {
    for (const t of S.tokens[team]) {
      const c = G.cordsOf(team, t.position);
      if (!c) continue;
      const k = G.cellKey(c[0], c[1]);
      if (!byCell.has(k)) byCell.set(k, { RED: 0, BLUE: 0 });
      byCell.get(k)[team] += 1;
    }
  }
  const selecting = S.canMove && S.selected !== 0 && meIsCurrent() && !S.tokenInMotion;
  const mt = myTeam();
  for (const [k, el] of cellEls) {
    const info = byCell.get(k) || { RED: 0, BLUE: 0 };
    const pulse = selecting && info[mt] > 0 ? (mt === 'RED' ? 'pulse-red' : 'pulse-blue') : '';
    const sig = `${info.RED}|${info.BLUE}|${pulse}`;
    if (cellSig.get(k) === sig) continue;
    cellSig.set(k, sig);
    el.classList.remove('pulse-red', 'pulse-blue');
    if (pulse) el.classList.add(pulse);
    el.querySelectorAll('.tok').forEach((n) => n.remove());
    const mk = (team, n, half) => h('div', { class: `tok ${team.toLowerCase()} ${half ? 'half' : ''}` }, n > 1 ? h('span', { class: 'cnt' }, n) : null);
    if (info.RED && info.BLUE) { el.append(mk('RED', info.RED, true), mk('BLUE', info.BLUE, true)); }
    else if (info.RED) el.append(mk('RED', info.RED, false));
    else if (info.BLUE) el.append(mk('BLUE', info.BLUE, false));
  }
}

function renderPool() {
  const team = S.currentPlayer && S.currentPlayer.team === 'BLUE' ? 'blue' : 'red';
  const entries = Object.entries(S.pool).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  const sig = `${team}|${S.canMove}|${S.selected}|${JSON.stringify(entries)}`;
  if (ui.poolSig === sig) return;
  ui.poolSig = sig;
  ui.pool.replaceChildren(...entries.map(([val, cnt]) =>
    h('button', {
      class: `chip ${team} ${S.selected === val ? 'sel' : ''}`, disabled: !S.canMove, 'aria-label': `Use value ${val}`,
      onclick: () => selectValue(val),
    }, String(val), cnt > 1 ? h('span', { class: 'badge' }, cnt) : null)));
}

function renderDice() {
  if (!ui.dice) return;
  const team = S.currentPlayer && S.currentPlayer.team === 'BLUE' ? 'blue' : 'red';
  const vals = S.rolling ? S.shuffle : S.dice;
  const paint = (el, v) => {
    el.className = `die ${team} ${S.canRoll && !S.rolling && !S.gameOver ? 'can-roll' : ''}`;
    el.replaceChildren(...Array.from({ length: v }, () => h('span', { class: 'pip' })));
  };
  paint(ui.die1, vals[0]); paint(ui.die2, vals[1]);
}

/* ====================================================================== */
/* render dispatcher                                                      */
/* ====================================================================== */
function renderAll() {
  if (S.screen === 'lobby') renderLobby();
  else if (S.screen === 'game') renderGame();
}

/* ====================================================================== */
/* animated background (floating tokens, like the Android dashboard)      */
/* ====================================================================== */
function initBackground() {
  const canvas = $('#bg');
  const ctx = canvas.getContext('2d');
  const tokens = [
    [0.05, 0.20, 1.1, true, 80, 0.5], [0.35, 0.10, 0.7, false, 120, 1.9], [0.65, 0.35, 1.4, true, 60, 3.1], [0.15, 0.75, 0.9, false, 100, 0.8],
    [0.80, 0.85, 1.2, true, 130, 2.3], [0.50, 0.65, 0.6, false, 75, 1.4], [0.90, 0.30, 1.5, true, 95, 0.2], [0.25, 0.50, 0.8, false, 110, 2.7],
  ].map(([x, y, speed, red, amp, phase], id) => ({ id, x, y, speed, red, amp, phase }));
  let w = 0, h2 = 0, dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h2 = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h2 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h2);
    if (S.screen !== 'game' && !document.hidden) {
      const clock = ((t / 1000) * 40) % 1200;
      for (const k of tokens) {
        let x = (w * k.x + clock * 1.5 * k.speed) % (w + 240) - 120;
        if (x < -120) x = w + 120;
        const wave = Math.sin(x * 0.004 + k.phase) + Math.cos(x * 0.009 + k.id * 3.5) * 0.25;
        const y = h2 * k.y + wave * k.amp;
        const color = k.red ? '255,102,102' : '102,102,255';
        const pulse = Math.sin(clock * 0.07 + k.id) * 4;
        const core = 16;
        const circle = (r, a) => { ctx.beginPath(); ctx.fillStyle = `rgba(${color},${a})`; ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
        circle(38 + pulse, 0.12); circle(core * 1.45, 0.22); circle(core, 0.7);
        ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.arc(x - core * 0.3, y - core * 0.3, core * 0.32, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!reduce) requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

/* ====================================================================== */
/* boot                                                                   */
/* ====================================================================== */
function boot() {
  initBackground();
  initDashboard();
  // First user gesture unlocks audio (browser autoplay policy).
  const unlock = () => {
    audio.unlock();
    if (audio.isMusicPlaying() || !audio.musicEnabled) {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, unlock);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock);
  audio.wantMusic(true); // music is ON by default; browsers only allow sound after the first tap/click, so it starts then
  warmUpBackend();
  window.addEventListener('beforeunload', (e) => {
    if (S.conn && S.screen === 'game' && !S.gameOver) { e.preventDefault(); e.returnValue = ''; }
  });
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^\d{1,9}$/.test(room)) openJoin(room);
  showScreen('dashboard');
}
boot();
