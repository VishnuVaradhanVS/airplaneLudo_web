// Pure helpers shared by the UI. No DOM access here.
import { redPath, bluePath, safe } from './paths.js';

export const RED = 'RED';
export const BLUE = 'BLUE';
export const LAST_POS = redPath.length - 1; // 79 = final "home" cell (2,6)
export const LOOP_END = 60;                  // position 60 wraps back to 12 while home path is locked
export const LOOP_START = 12;

export const pathOf = (team) => (team === RED ? redPath : bluePath);
export const otherTeam = (team) => (team === RED ? BLUE : RED);
export const cellKey = (x, y) => `${x},${y}`;
export const SAFE = new Set(safe.map(([x, y]) => cellKey(x, y)));

export function cordsOf(team, position) {
  if (position < 0 || position > LAST_POS) return null;
  return pathOf(team)[position];
}

/** Server sends diceDenomination as {"5":1,"2":2} (string keys). Convert to {5:1,2:2}. */
export function normalizePool(obj) {
  const out = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(k);
    if (Number.isFinite(n) && v > 0) out[n] = v;
  }
  return out;
}

export const poolTotal = (pool) => Object.values(pool).reduce((a, b) => a + b, 0);
export const poolEquals = (a, b) => JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b));
const sortObj = (o) => Object.keys(o).sort((a, b) => a - b).map((k) => [k, o[k]]);

export function diceSum(d1, d2) {
  const s = d1 + d2;
  return s === 0 ? 12 : s;
}

/** One animated step of a token (mirrors Token.incrementPosition + the client-side loop rule). */
export function stepForward(token, homeEnabled) {
  let position = Math.min(token.position + 1, LAST_POS);
  if (position === LOOP_END && !homeEnabled) position = LOOP_START;
  return { ...token, position };
}

export function stepBackward(token) {
  return { ...token, position: token.position - 1 };
}

export function normalizeTokens(list) {
  return (list || []).map((t) => ({ id: t.id, team: t.team, position: t.position }));
}

export const isSafeCell = (cords) => !!cords && SAFE.has(cellKey(cords[0], cords[1]));
export const sameCords = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
