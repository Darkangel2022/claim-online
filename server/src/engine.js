// CLAIM — motorul de joc autoritar (rulează pe server). Fără dependențe, fără platformă.
export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14];
export const TARGETS = [300, 500, 1000];
export const DIFFS = ['USOR', 'MEDIU', 'GREU'];
export const MAX_PLAYERS = 6;

export const cardKey = c => (c ? `${c.r}-${c.s}` : '');
export const makeDeck = () => { const d = []; for (let s = 0; s < 4; s++) for (const r of RANKS) d.push({ r, s }); return d; };
export function shuffle(a, rng) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export const pointsCard = (G, c) => (G.trump && c.r === G.trump.r ? 0 : c.r);
export const pointsHand = (G, h) => h.reduce((a, c) => a + pointsCard(G, c), 0);
const exposed = G => (G.discard.length ? G.discard[G.discard.length - 1] : null);
const allPlayed = G => G.played.slice(0, G.n).every(Boolean);
const idx = G => Array.from({ length: G.n }, (_, i) => i);
const rankName = r => (r === 1 ? 'A' : r === 12 ? 'J' : r === 13 ? 'Q' : r === 14 ? 'K' : String(r));
const SUITS = ['♠', '♥', '♦', '♣'];
export const cardName = c => rankName(c.r) + SUITS[c.s];

export function newGame({ n = 4, target = 300, diff = 'MEDIU' } = {}) {
  return {
    n, target, diff, phase: 'lobby', seats: [],
    score: Array(MAX_PLAYERS).fill(0), general: Array(MAX_PLAYERS).fill(0),
    roundStarter: 0, setNo: 0, roundNo: 0,
    trump: null, hands: [], stock: [], discard: [], pending: [], turn: 0, stage: 'discard',
    played: [], known: [], lastMove: [], lastMover: -1, stockTotal: 0, result: null, message: '',
  };
}

export function startSet(G, rng) {
  G.score = Array(MAX_PLAYERS).fill(0); G.roundStarter = 0; G.setNo++; G.setAwarded = false;
  startRound(G, rng);
}

export function startRound(G, rng) {
  const deck = shuffle(makeDeck(), rng);
  G.hands = Array.from({ length: G.n }, () => []);
  G.discard = []; G.pending = []; G.result = null;
  G.played = Array(G.n).fill(false); G.known = Array.from({ length: G.n }, () => []);
  G.lastMove = Array(G.n).fill(null); G.lastMover = -1;
  G.trump = deck.pop();
  for (let p = 0; p < G.n; p++) for (let k = 0; k < 5; k++) G.hands[p].push(deck.pop());
  G.discard.push(deck.pop()); G.stock = deck; G.stockTotal = deck.length;
  G.turn = G.roundStarter; G.stage = 'discard'; G.phase = 'play'; G.roundNo++;
  G.message = `Începe ${G.seats[G.turn].name}. Prima rotație se joacă fără CLAIM.`;
}

function reshuffle(G, rng) {
  if (G.stock.length > 0 || G.discard.length <= 1) return 0;
  const keep = G.discard.pop(); const rec = G.discard.splice(0);
  G.stock = shuffle(rec, rng); G.discard = [keep]; G.stockTotal = G.stock.length;
  return G.stock.length;
}
function forgetKnown(G, p, cards) { const ks = new Set(cards.map(cardKey)); G.known[p] = G.known[p].filter(c => !ks.has(cardKey(c))); }

// ---- acțiuni ----
export function discard(G, p, rank) {
  if (G.phase !== 'play' || G.turn !== p || G.stage !== 'discard') return 'Nu e momentul să arunci.';
  const h = G.hands[p]; const out = h.filter(c => c.r === rank).slice(0, 4);
  if (!out.length) return 'Nu ai cărți de valoarea asta.';
  G.hands[p] = h.filter(c => !out.includes(c)); forgetKnown(G, p, out);
  G.pending = out; G.stage = 'draw';
  return null;
}

export function draw(G, p, from, rng) {
  if (G.phase !== 'play' || G.turn !== p || G.stage !== 'draw') return { err: 'Nu e momentul să tragi.' };
  let c = null, fromExposed = false, reshuffled = 0;
  const prevTop = exposed(G);
  if (from === 'exposed' && G.discard.length) { c = G.discard.pop(); fromExposed = true; }
  else {
    if (!G.stock.length) reshuffled = reshuffle(G, rng);
    if (G.stock.length) c = G.stock.pop();
    else if (G.discard.length) { c = G.discard.pop(); fromExposed = true; }
  }
  if (c) { G.hands[p].push(c); if (fromExposed) G.known[p].push(c); }
  const out = G.pending; G.discard.push(...out); G.pending = [];
  if (G.stock.length === 0) reshuffled = reshuffle(G, rng) || reshuffled;
  G.played[p] = true; G.lastMove[p] = { out, took: fromExposed ? c : null }; G.lastMover = p;
  G.message = reshuffled ? `Teanc reamestecat: ${reshuffled} cărți. Jocul continuă.`
    : `${G.seats[p].name} a aruncat ${out.map(cardName).join(' ')} și a luat ${fromExposed ? cardName(c) : 'din teanc'}.`;
  G.turn = (G.turn + 1) % G.n; G.stage = 'discard';
  return { ev: { k: 'move', p, out, took: fromExposed ? c : null, prevTop } };
}

export function canClaim(G, p) { return G.phase === 'play' && G.turn === p && G.stage === 'discard' && allPlayed(G); }

export function claim(G, p) {
  if (!canClaim(G, p)) return { err: 'CLAIM se poate spune la tura ta, după prima rotație completă.' };
  return { ev: { k: 'claim', p }, end: endRound(G, p) };
}

export function endRound(G, who) {
  const cp = pointsHand(G, G.hands[who]); let catcher = -1;
  for (const i of idx(G)) { if (i === who) continue; const v = pointsHand(G, G.hands[i]); if (v <= cp && (catcher < 0 || v < pointsHand(G, G.hands[catcher]))) catcher = i; }
  const add = Array(G.n).fill(0), handPts = idx(G).map(i => pointsHand(G, G.hands[i]));
  if (catcher < 0) { for (const i of idx(G)) if (i !== who) add[i] = handPts[i]; G.message = `${G.seats[who].name} a spus CLAIM corect.`; }
  else { add[who] = 50; for (const i of idx(G)) if (i !== who && i !== catcher) add[i] = handPts[i]; G.message = `${G.seats[who].name} a fost prins de ${G.seats[catcher].name}! +50.`; }
  for (const i of idx(G)) G.score[i] += add[i];
  const setEnd = G.score.slice(0, G.n).some(v => v >= G.target);
  if (setEnd && !G.setAwarded) { const order = orderByScore(G), aw = [5, 3, 2, 1, 0, 0]; order.forEach((p, i) => (G.general[p] += aw[i] || 0)); G.setAwarded = true; }
  G.phase = 'result';
  G.result = { who, catcher, add, handPts, setEnd, hands: G.hands.map(h => [...h]) };
  for (const s of G.seats) s.ready = false;
  return G.result;
}

export const orderByScore = G => idx(G).sort((a, b) => G.score[a] - G.score[b] || a - b);

export function nextRound(G, rng) {
  if (G.phase !== 'result') return;
  if (G.result && G.result.setEnd) { G.score = Array(MAX_PLAYERS).fill(0); G.roundStarter = 0; G.setAwarded = false; G.setNo++; }
  else G.roundStarter = (G.roundStarter + 1) % G.n;
  startRound(G, rng);
}

// ---- boți corecți: doar informație publică ----
function view(G, p) {
  const seen = new Set(); const add = c => c && seen.add(cardKey(c));
  G.hands[p].forEach(add); add(G.trump); G.discard.forEach(add); G.pending.forEach(add);
  for (const i of idx(G)) if (i !== p) G.known[i].forEach(add);
  const pool = makeDeck().filter(c => !seen.has(cardKey(c)));
  const pts = pool.map(c => pointsCard(G, c)); const n = pts.length || 1;
  const avg = pts.length ? pts.reduce((a, b) => a + b, 0) / n : 6;
  const sd = Math.sqrt(pts.reduce((a, b) => a + (b - avg) ** 2, 0) / n) || 3;
  return { pool, avg, sd };
}
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - q : q; }
function claimSafety(G, p) {
  const mine = pointsHand(G, G.hands[p]), v = view(G, p); let prob = 1;
  for (const i of idx(G)) {
    if (i === p) continue; const k = G.known[i], unk = Math.max(0, G.hands[i].length - k.length), kp = pointsHand(G, k);
    if (unk === 0) { if (kp <= mine) return 0; continue; }
    if (kp > mine) continue;
    prob *= normCdf((kp + unk * v.avg - mine - 0.5) / Math.max(Math.sqrt(unk) * v.sd, 0.8));
  }
  return prob;
}
function shouldClaim(G, p, rng) {
  const mine = pointsHand(G, G.hands[p]), safe = claimSafety(G, p);
  if (G.diff === 'USOR') return mine <= 9 && safe > 0.35 && rng() < 0.6;
  if (G.diff === 'MEDIU') return safe >= 0.62 || (safe >= 0.5 && rng() < 0.35);
  return safe >= (G.target - G.score[p] <= 55 ? 0.82 : 0.7);
}
const maxGroup = (G, h) => { const g = {}; for (const c of h) g[c.r] = (g[c.r] || 0) + pointsCard(G, c); return Math.max(0, ...Object.values(g)); };
function chooseMove(G, p, rng) {
  const h = G.hands[p], ex = exposed(G), ranks = [...new Set(h.map(c => c.r))];
  if (G.diff === 'USOR') {
    const nt = ranks.filter(r => !G.trump || r !== G.trump.r).sort((a, b) => b - a);
    let rank = (nt.length ? nt : ranks)[0];
    if (rng() < 0.25 && nt.length > 1) rank = nt[1 + Math.floor(rng() * (nt.length - 1))];
    return { rank, from: ex && pointsCard(G, ex) <= 2 && rng() < 0.5 ? 'exposed' : 'stock' };
  }
  const v = view(G, p), lam = G.diff === 'GREU' ? 0.55 : 0.25, ev = hand => pointsHand(G, hand) - lam * maxGroup(G, hand);
  const pool = v.pool.length ? v.pool : makeDeck(); let best = null;
  for (const r of ranks) {
    const grp = h.filter(c => c.r === r).slice(0, 4), rest = h.filter(c => !grp.includes(c)), opts = [];
    if (ex) opts.push(['exposed', ev([...rest, ex])]);
    opts.push(['stock', pool.reduce((a, c) => a + ev([...rest, c]), 0) / pool.length]);
    for (const [from, s0] of opts) {
      let s = s0;
      if (G.diff === 'GREU') { const gv = pointsCard(G, grp[grp.length - 1]); if (gv <= 3) s += (4 - gv) * 0.35; }
      if (G.diff === 'MEDIU') s += rng() * 2.2;
      if (!best || s < best.s) best = { rank: r, from, s };
    }
  }
  return best;
}

// Mutare automată: bot, jucător deconectat sau timp expirat. `smart` = folosește AI-ul.
export function autoAct(G, p, rng, smart = true) {
  if (G.phase !== 'play' || G.turn !== p) return [];
  if (G.stage === 'draw') return [draw(G, p, 'stock', rng).ev];
  if (smart && allPlayed(G) && shouldClaim(G, p, rng)) { const r = claim(G, p); return [r.ev]; }
  let mv;
  if (smart) mv = chooseMove(G, p, rng);
  else { const h = G.hands[p]; const nt = [...new Set(h.map(c => c.r))].filter(r => !G.trump || r !== G.trump.r).sort((a, b) => b - a); mv = { rank: nt.length ? nt[0] : h[0].r, from: 'stock' }; }
  discard(G, p, mv.rank);
  return [draw(G, p, mv.from, rng).ev];
}

// Ce vede un jucător: doar mâna lui. La rezultat se dezvăluie toate mâinile.
export function viewFor(G, seat) {
  const pub = G.phase === 'result';
  return {
    n: G.n, target: G.target, diff: G.diff, phase: G.phase, setNo: G.setNo, roundNo: G.roundNo,
    seats: G.seats.map((s, i) => ({ name: s.name, bot: !!s.bot, human: !!s.human, connected: !!s.connected, away: (s.away || 0) >= 2, ready: !!s.ready, host: !!s.host, cards: G.hands[i] ? G.hands[i].length : 0 })),
    score: G.score.slice(0, G.n), general: G.general.slice(0, G.n),
    trump: G.trump, exposed: exposed(G), stockCount: G.stock.length, stockTotal: G.stockTotal,
    turn: G.turn, stage: G.stage, played: G.played, known: G.known, lastMove: G.lastMove, lastMover: G.lastMover,
    hand: seat >= 0 && G.hands[seat] ? G.hands[seat] : [], pending: seat === G.turn ? G.pending : [],
    message: G.message, result: pub ? G.result : null,
  };
}
