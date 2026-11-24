#!/usr/bin/env node
/**
 * Mock Airplane Ludo backend (testing aid ONLY).
 *
 * A line-by-line JavaScript port of the Kotlin backend's Main.kt so the web UI can be tested
 * without running the Kotlin server. It mirrors the same WebSocket route, packet shapes, game
 * rules and even the strict JSON decoding (unknown keys => the player is dropped, exactly like
 * kotlinx.serialization does on the real server).
 *
 *   npm install
 *   node mock-server.js                 # WebSocket backend on :10000  (ws://localhost:10000/ludo/{room})
 *   node mock-server.js --serve-web     # ...and also serve ../web on :8080 so you need no Docker at all
 *
 * Env: PORT (10000), WEB_PORT (8080), DICE="1:0,2:3,..." forces dice (d1:d2 pairs, cycled) for demos/tests.
 * The REAL backend remains the source of truth - use this only for quick local UI checks.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const SERVE_WEB = process.argv.includes('--serve-web');
const FORCED = (process.env.DICE || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number));
let forcedIdx = 0;

/* ------------------------------ paths (from GridPathCords.kt) ------------------------------ */
// Generated from the same file as the web client so both always agree.
const pathsSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'paths.js'), 'utf8');
const grab = (name) => JSON.parse(pathsSrc.match(new RegExp(`export const ${name} = (\\[.*?\\]);`, 's'))[1]);
const redPath = grab('redPath').map(([x, y]) => ({ x, y }));
const bluePath = grab('bluePath').map(([x, y]) => ({ x, y }));
const safe = grab('safe').map(([x, y]) => ({ x, y }));
const eqC = (a, b) => a.x === b.x && a.y === b.y;
const isSafe = (c) => safe.some((s) => eqC(s, c));

/* ------------------------------ strict decoding (kotlinx.serialization) ------------------------------ */
const bad = (m) => { throw new Error('SerializationException: ' + m); };
const only = (o, allowed, what) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`Encountered an unknown key '${k}' in ${what}`); };
const need = (o, req, what) => { for (const k of req) if (!(k in o)) bad(`Field '${k}' is required for ${what}`); };
const isInt = (v) => Number.isInteger(v);
const decodePlayer = (p) => {
  if (p === null || typeof p !== 'object') bad('Player');
  only(p, ['id', 'name', 'team', 'moveTokens', 'turnsLeft', 'playerGameState'], 'Player');
  need(p, ['id', 'name', 'team', 'moveTokens', 'turnsLeft', 'playerGameState'], 'Player');
  if (!isInt(p.id) || typeof p.name !== 'string' || !['RED', 'BLUE'].includes(p.team) || typeof p.moveTokens !== 'boolean' ||
      !isInt(p.turnsLeft) || !['Waiting', 'Rolling', 'Moving'].includes(p.playerGameState)) bad('Player value');
  return p;
};
const decodeRoom = (r) => {
  if (r === null || typeof r !== 'object') bad('Room');
  only(r, ['id', 'hostId', 'players', 'baseTokenCount', 'game', 'inGame'], 'Room');
  need(r, ['id', 'hostId', 'baseTokenCount', 'inGame'], 'Room');
  if (!isInt(r.id) || !isInt(r.hostId) || !isInt(r.baseTokenCount) || typeof r.inGame !== 'boolean') bad('Room value');
  if (r.players) r.players.forEach(decodePlayer);
  return r;
};
function decodePacket(text) {
  const p = JSON.parse(text);
  if (p === null || typeof p !== 'object' || Array.isArray(p)) bad('GamePackets');
  only(p, ['lobbyAction', 'gameAction', 'player', 'room', 'game', 'selectedValue', 'moveTokenId'], 'GamePackets');
  if (p.lobbyAction != null && !['PlayerAck', 'RoomUpdate', 'Kick', 'SwapTeam', 'ChangeTokenCount', 'RoomInGame'].includes(p.lobbyAction)) bad('LobbyAction');
  if (p.gameAction != null && !['StartGame', 'EndGame', 'RollDice', 'MoveToken', 'SpawnToken', 'GameUpdate', 'AnimateTokenMovement', 'LeaveGame'].includes(p.gameAction)) bad('GameAction');
  if (p.player != null) decodePlayer(p.player);
  if (p.room != null) decodeRoom(p.room);
  if (p.selectedValue != null && !isInt(p.selectedValue)) bad('selectedValue');
  if (p.moveTokenId != null && !isInt(p.moveTokenId)) bad('moveTokenId');
  return p;
}

/* ------------------------------ model ------------------------------ */
const rooms = new Map(); // roomId -> { roomData, sessions: [{player, ws}] }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOUBLES = [1, 5, 6, 12];
const LAST = redPath.length - 1;

const newTokens = (team, n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, team, position: -1, cords: { x: -1, y: -1 } }));
const pathFor = (team) => (team === 'RED' ? redPath : bluePath);
function tokenMove(t, steps, homeEnabled) {
  if (homeEnabled || t.position + steps <= 59) t.position += steps;
  else { const prev = t.position; t.position = 12; t.position += steps - (60 - prev); }
  const c = pathFor(t.team)[t.position];
  if (!c) throw new Error('IndexOutOfBoundsException'); // same failure the Kotlin server would hit
  t.cords = c;
}
const tokenKill = (t) => { t.position = -1; t.cords = { x: -1, y: -1 }; };

// kotlinx.serialization with default Json(): null properties that have a default are omitted
function encodePacket(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) o[k] = v;
  return JSON.stringify(o, (k, v) => (k === 'game' && v === null ? undefined : v));
}
const encRoom = (r) => r; // Room.game null is dropped by encodePacket's replacer
function sendTo(ws, pkt) { try { if (ws.readyState === 1) ws.send(encodePacket(pkt)); } catch (e) { /* ignore */ } }
function toAll(roomId, pkt) { const r = rooms.get(roomId); if (r) r.sessions.forEach((s) => sendTo(s.ws, pkt)); }
const broadcastRoomState = (id) => { const r = rooms.get(id); if (r) toAll(id, { lobbyAction: 'RoomUpdate', room: encRoom(r.roomData) }); };

function getNextPlayer(roomId, currentPlayer = null) {
  const room = rooms.get(roomId); if (!room) return null;
  const players = room.roomData.players; if (!players.length) return null;
  const game = room.roomData.game;
  let next = null;
  const rotate = (team, prevKey) => {
    const list = players.filter((p) => p.team === team);
    if (list.length) {
      const prev = game && game[prevKey];
      if (!prev) next = list[0];
      else for (let i = 0; i < list.length; i++) if (list[i].id === prev.id) { next = list[(i + 1) % list.length]; break; }
    }
    if (!next) next = list[0] || players[0];
  };
  if (!currentPlayer) next = players.find((p) => p.team === 'RED') || players[0];
  else if (currentPlayer.team === 'RED') rotate('BLUE', 'prevBluePlayer');
  else rotate('RED', 'prevRedPlayer');
  const target = { ...next, playerGameState: 'Rolling', turnsLeft: 1 };
  for (const p of players) {
    if (p.id === target.id) { p.playerGameState = 'Rolling'; p.turnsLeft += 1; }
    if (currentPlayer && p.id === currentPlayer.id) { p.playerGameState = 'Waiting'; p.turnsLeft = 0; }
  }
  room.roomData = { ...room.roomData, players };
  if (room.roomData.game) {
    const g = room.roomData.game;
    room.roomData = { ...room.roomData, game: { ...g, currentPlayer: target, diceDenomination: {},
      prevRedPlayer: target.team === 'RED' ? target : g.prevRedPlayer,
      prevBluePlayer: target.team === 'BLUE' ? target : g.prevBluePlayer } };
  }
  return target;
}

function canMoveToken(roomId, denom, team) {
  const room = rooms.get(roomId); if (!room) return false;
  const g = room.roomData.game;
  const tokens = team === 'RED' ? g.redTokens : g.blueTokens;
  const homeEnabled = team === 'RED' ? g.redHomeEnabled : g.blueHomeEnabled;
  let atBase = team === 'RED' ? g.redBaseCount : g.blueBaseCount;
  const steps = [];
  const BIG = 999999999;
  for (const t of tokens) {
    if (t.position === -1) {
      if (g.currentPlayer.playerGameState === 'Moving' && atBase !== 0 && (denom[1] || denom[5])) { atBase--; steps.push(homeEnabled ? LAST : BIG); }
      if (g.currentPlayer.playerGameState === 'Rolling' && atBase !== 0) { atBase--; steps.push(homeEnabled ? LAST : BIG); }
    } else steps.push(homeEnabled ? LAST - t.position : BIG);
  }
  const keys = Object.keys(denom).map(Number).sort((a, b) => b - a);
  if (!steps.length || !keys.length) return false;
  for (const k of keys) {
    for (let i = 0; i < denom[k]; i++) {
      let ok = false;
      for (let j = 0; j < steps.length; j++) if (steps[j] >= k) { steps[j] -= k; ok = true; break; }
      if (!ok) return false;
    }
  }
  return true;
}

function countLastCellToken(roomId) {
  const room = rooms.get(roomId); if (!room) return -1;
  const g = room.roomData.game; const cp = g.currentPlayer;
  const tokens = cp.team === 'RED' ? g.redTokens : g.blueTokens;
  const home = cp.team === 'RED' ? g.redHomeCount : g.blueHomeCount;
  const n = tokens.filter((t) => t.position !== -1 && t.cords.x === 3 && t.cords.y === 6).length;
  return home + n === tokens.length ? n : -1;
}

async function rollDice(roomId) {
  const room = rooms.get(roomId); if (!room || !room.roomData.game) return;
  const dice = { d1: 0, d2: 0, sum: 0 };
  if (FORCED.length) { [dice.d1, dice.d2] = FORCED[forcedIdx++ % FORCED.length]; }
  else { dice.d1 = Math.floor(Math.random() * 4); dice.d2 = Math.floor(Math.random() * 4); }
  dice.sum = dice.d1 + dice.d2; if (dice.sum === 0) dice.sum = 12;
  const currentPlayer = room.roomData.game.currentPlayer;
  const ms = room.sessions.find((s) => s.player.id === (currentPlayer && currentPlayer.id));
  if (ms) {
    if (dice.sum === 1 && currentPlayer.moveTokens === false) { ms.player.moveTokens = true; currentPlayer.moveTokens = true; }
    const dbl = DOUBLES.includes(dice.sum);
    if (!dbl) { ms.player.turnsLeft -= 1; currentPlayer.turnsLeft -= 1; }
    if (currentPlayer.turnsLeft === 0) { ms.player.playerGameState = 'Moving'; currentPlayer.playerGameState = 'Moving'; }
    const last = countLastCellToken(roomId);
    if (last !== -1 && dice.sum === 1 && ((room.roomData.game.diceDenomination[1] || 0) + 1) === last) {
      ms.player.playerGameState = 'Moving'; currentPlayer.playerGameState = 'Moving';
    }
    room.roomData = { ...room.roomData, players: room.sessions.map((s) => s.player) };
  }
  const denom = room.roomData.game.diceDenomination;
  denom[dice.sum] = (denom[dice.sum] || 0) + 1;
  room.roomData = { ...room.roomData, game: { ...room.roomData.game, diceValue: dice, diceDenomination: denom } };
  broadcastRoomState(roomId);
  const endTurn = async () => { await sleep(800); getNextPlayer(roomId, currentPlayer); broadcastRoomState(roomId); };
  if (!currentPlayer.moveTokens && currentPlayer.turnsLeft === 0) return endTurn();
  if (!canMoveToken(roomId, denom, currentPlayer.team)) return endTurn();
  const g = room.roomData.game;
  if (g && currentPlayer.turnsLeft === 0 && !(denom[1] || denom[5])) {
    const t = g.currentPlayer.team;
    const done = t === 'RED' ? g.redHomeCount + g.redBaseCount === g.redTokens.length : g.blueHomeCount + g.blueBaseCount === g.blueTokens.length;
    if (done) { await sleep(800); getNextPlayer(roomId, g.currentPlayer); broadcastRoomState(roomId); }
  }
}

async function spawnToken(roomId, value) {
  const room = rooms.get(roomId); if (!room || value == null) return;
  const g = room.roomData.game; if (!g) return;
  if (g.currentPlayer && g.currentPlayer.moveTokens === false) return;
  const team = g.currentPlayer && g.currentPlayer.team;
  if ((team === 'RED' ? g.redBaseCount : g.blueBaseCount) === 0) return;
  const denom = g.diceDenomination;
  if (!(value in denom)) return;
  denom[value] -= 1; if (denom[value] === 0) delete denom[value];
  const tokens = team === 'RED' ? g.redTokens : g.blueTokens;
  if (team === 'RED') g.redBaseCount -= 1; else g.blueBaseCount -= 1;
  const t = tokens.find((x) => x.position === -1);
  if (t) { t.position = 0; t.cords = pathFor(team)[0]; }
  if (Object.keys(denom).length === 0 && g.currentPlayer.playerGameState !== 'Rolling') g.currentPlayer = getNextPlayer(roomId);
  toAll(roomId, { gameAction: 'SpawnToken' });
  broadcastRoomState(roomId);
}

async function moveToken(roomId, tokenId, steps) {
  const room = rooms.get(roomId); if (!room || tokenId == null || steps == null) return;
  const g = room.roomData.game;
  const team = g.currentPlayer && g.currentPlayer.team;
  const denom = g.diceDenomination;
  const homeEnabled = team === 'RED' ? g.redHomeEnabled : g.blueHomeEnabled;
  if (!(steps in denom)) return;
  denom[steps] -= 1; if (denom[steps] === 0) delete denom[steps];
  const mine = team === 'RED' ? g.redTokens : g.blueTokens;
  const theirs = team === 'RED' ? g.blueTokens : g.redTokens;
  const mt = mine.find((t) => t.id === tokenId);
  if (mt) {
    tokenMove(mt, steps, homeEnabled);
    if (mt.position >= LAST) { if (team === 'RED') g.redHomeCount++; else g.blueHomeCount++; tokenKill(mt); }
    if (mt.position !== -1 && !isSafe(mt.cords)) {
      for (const t of theirs) {
        if (t.position !== -1 && eqC(t.cords, mt.cords)) {
          if (team === 'RED') { g.redHomeEnabled = true; g.blueBaseCount++; } else { g.blueHomeEnabled = true; g.redBaseCount++; }
          g.currentPlayer.turnsLeft += 1; g.currentPlayer.playerGameState = 'Rolling';
          tokenKill(t);
        }
      }
    }
  }
  if (room.roomData.baseTokenCount === g.redHomeCount || room.roomData.baseTokenCount === g.blueHomeCount) { return gameOver(roomId); }
  if (Object.keys(g.diceDenomination).length === 0 && g.currentPlayer.playerGameState !== 'Rolling' && g.currentPlayer.turnsLeft === 0) {
    g.currentPlayer = getNextPlayer(roomId, g.currentPlayer);
  } else {
    const t = g.currentPlayer.team;
    const done = t === 'RED' ? g.redHomeCount + g.redBaseCount === g.redTokens.length : g.blueHomeCount + g.blueBaseCount === g.blueTokens.length;
    if (done) g.currentPlayer = getNextPlayer(roomId, g.currentPlayer);
  }
  const cp = room.roomData.game.currentPlayer;
  if (cp && cp.playerGameState === 'Moving' && !canMoveToken(roomId, denom, cp.team)) {
    await sleep(800);
    room.roomData.game.diceDenomination = {};
    getNextPlayer(roomId, cp);
    broadcastRoomState(roomId);
    return;
  }
  broadcastRoomState(roomId);
}

function gameOver(roomId) {
  const room = rooms.get(roomId); if (!room) return;
  room.roomData = { ...room.roomData, inGame: false };
  toAll(roomId, { gameAction: 'EndGame' });
}

function startGame(roomId) {
  const room = rooms.get(roomId); if (!room) return;
  const n = room.roomData.baseTokenCount;
  const players = room.roomData.players;
  const game = {
    currentPlayer: getNextPlayer(roomId),
    redTokens: newTokens('RED', n), blueTokens: newTokens('BLUE', n),
    redHomeEnabled: false, blueHomeEnabled: false, redBaseCount: n, blueBaseCount: n, redHomeCount: 0, blueHomeCount: 0,
    diceValue: { d1: 0, d2: 0 }, diceDenomination: {},
    prevRedPlayer: players.find((p) => p.team === 'RED'), prevBluePlayer: [...players].reverse().find((p) => p.team === 'BLUE'),
  };
  room.roomData = { ...room.roomData, game, inGame: true };
  broadcastRoomState(roomId);
  toAll(roomId, { gameAction: 'StartGame' });
}

/* ------------------------------ connection handling ------------------------------ */
function onConnection(ws, req) {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/ludo\/([^/]+)$/);
  const roomId = m ? parseInt(m[1], 10) : NaN;
  if (!m || !Number.isInteger(roomId) || !/^-?\d+$/.test(m[1])) { ws.close(1003, 'Invalid Room ID'); return; }
  const existing = rooms.get(roomId);
  if (existing && existing.roomData.inGame) {
    sendTo(ws, { lobbyAction: 'RoomInGame' });
    ws.close(1008, 'Game already in progress');
    return;
  }
  let playerId = Date.now() % 10000;
  if (existing) while (existing.sessions.some((s) => s.player.id === playerId)) playerId = (playerId + 1) % 10000; // avoid test flakes
  const name = url.searchParams.get('name') || `Player_${playerId}`;
  const player = { id: playerId, name, team: 'RED', moveTokens: false, turnsLeft: 0, playerGameState: 'Waiting' };
  const session = { player, ws };
  if (!rooms.has(roomId)) rooms.set(roomId, { roomData: { id: roomId, hostId: playerId, players: [], baseTokenCount: 6, game: null, inGame: false }, sessions: [] });
  const room = rooms.get(roomId);
  player.team = room.sessions.length % 2 === 0 ? 'RED' : 'BLUE';
  room.sessions.push(session);
  room.roomData = { ...room.roomData, players: room.sessions.map((s) => s.player) };
  sendTo(ws, { lobbyAction: 'PlayerAck', player });
  broadcastRoomState(roomId);
  console.log(`[room ${roomId}] ${name} joined (${player.team}), ${room.sessions.length} player(s)`);

  let chain = Promise.resolve();
  ws.on('message', (data) => {
    chain = chain.then(async () => {
      try {
        const p = decodePacket(data.toString());
        switch (p.lobbyAction) {
          case 'SwapTeam': {
            const s = room.sessions.find((x) => x.player.id === (p.player && p.player.id));
            if (s) { s.player.team = s.player.team === 'RED' ? 'BLUE' : 'RED'; room.roomData = { ...room.roomData, players: room.sessions.map((x) => x.player) }; broadcastRoomState(roomId); }
            break;
          }
          case 'Kick': {
            const s = room.sessions.find((x) => x.player.id === (p.player && p.player.id));
            if (s) {
              room.sessions.splice(room.sessions.indexOf(s), 1);
              room.roomData = { ...room.roomData, players: room.sessions.map((x) => x.player) };
              try { s.ws.close(1008, 'You have been kicked by the host.'); } catch (e) { /* ignore */ }
              broadcastRoomState(roomId);
            }
            break;
          }
          case 'ChangeTokenCount':
            if (p.room && p.room.baseTokenCount != null) { room.roomData = { ...room.roomData, baseTokenCount: p.room.baseTokenCount }; broadcastRoomState(roomId); }
            break;
          default: break;
        }
        switch (p.gameAction) {
          case 'StartGame': startGame(roomId); break;
          case 'RollDice': await rollDice(roomId); break;
          case 'SpawnToken': await spawnToken(roomId, p.selectedValue); break;
          case 'MoveToken': await moveToken(roomId, p.moveTokenId, p.selectedValue); break;
          case 'AnimateTokenMovement':
            toAll(roomId, { gameAction: 'AnimateTokenMovement', room: room.roomData, selectedValue: p.selectedValue, moveTokenId: p.moveTokenId });
            break;
          default: break;
        }
      } catch (e) {
        console.log(`[room ${roomId}] ${name} dropped: ${e.message}`);
        try { ws.terminate(); } catch (e2) { /* ignore */ }
      }
    });
  });
  ws.on('close', () => {
    const r = rooms.get(roomId); if (!r) return;
    const leaving = r.roomData.players.find((p) => p.id === playerId);
    if (leaving) toAll(roomId, { gameAction: 'LeaveGame', player: leaving });
    r.sessions = r.sessions.filter((s) => s.player.id !== playerId);
    console.log(`[room ${roomId}] ${name} left, ${r.sessions.length} player(s) remain`);
    if (!r.sessions.length) { rooms.delete(roomId); return; }
    r.roomData = { ...r.roomData, players: r.sessions.map((s) => s.player) };
    if (leaving && leaving.id === r.roomData.hostId) r.roomData = { ...r.roomData, hostId: r.roomData.players[0].id };
    const g = r.roomData.game;
    if (leaving && g && g.currentPlayer && leaving.id === g.currentPlayer.id) {
      const nxt = getNextPlayer(roomId, leaving);
      r.roomData = { ...r.roomData, game: { ...r.roomData.game, currentPlayer: nxt } };
    }
    broadcastRoomState(roomId);
  });
}

/* ------------------------------ http (+ optional static web) ------------------------------ */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function staticHandler(root) {
  return (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  };
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', onConnection);
const wsHttp = http.createServer((req, res) => { res.writeHead(404); res.end('Airplane Ludo mock backend'); });
wsHttp.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
wsHttp.listen(PORT, '0.0.0.0', () => console.log(`Mock backend: ws://localhost:${PORT}/ludo/{roomId}?name=...`));

if (SERVE_WEB) {
  const webRoot = path.join(__dirname, '..', 'web');
  const cfg = `window.APP_CONFIG = { BACKEND_WS_URL: "ws://" + location.hostname + ":${PORT}/ludo" };`;
  const handler = staticHandler(webRoot);
  http.createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(cfg); return; }
    handler(req, res);
  }).listen(WEB_PORT, '0.0.0.0', () => console.log(`Web UI:       http://localhost:${WEB_PORT}  (talks to the mock backend)`));
}
