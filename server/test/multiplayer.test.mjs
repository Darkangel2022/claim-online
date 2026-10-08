// Test de integrare: server real + clienți WebSocket independenți.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let WebSocket; try { WebSocket = require('ws'); } catch { WebSocket = require('/opt/npm-tools/node_modules/ws'); }

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = c => `${c.r}-${c.s}`;

test.before(async () => {
  srv = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT, CLAIM_DATA: '/tmp/claim-test-' + PORT, CLAIM_TURN_MS: '4000', CLAIM_BOT_MS: '60', CLAIM_RESULT_MS: '60000', CLAIM_RECONNECT_MS: '1500' }, stdio: ['ignore', 'pipe', 'inherit'] });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch {} await sleep(100); }
  throw new Error('server did not start');
});
test.after(() => srv && srv.kill());

class Client {
  constructor(name, token) { this.name = name; this.token = token || ('tok_' + name + '_' + Math.random().toString(36).slice(2, 10)); this.msgs = []; this.last = null; this.toasts = []; this.errors = []; }
  connect(code, mode, opts) {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?room=${code}&mode=${mode}`);
      this.ws.on('open', () => { this.ws.send(JSON.stringify({ t: 'hello', name: this.name, token: this.token, mode, opts })); });
      this.ws.on('message', d => { const m = JSON.parse(d); this.msgs.push(m); if (m.t === 'update') { this.last = m; if (this.waiter && this.waiter()) { } } if (m.t === 'toast') this.toasts.push(m.code); if (m.t === 'error') this.errors.push(m.code); });
      this.ws.on('close', () => (this.closed = true));
      const t0 = Date.now(); const iv = setInterval(() => { if (this.last) { clearInterval(iv); res(this); } else if (this.errors.length || this.closed) { clearInterval(iv); res(this); } else if (Date.now() - t0 > 5000) { clearInterval(iv); rej(new Error('no state')); } }, 20);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  get s() { return this.last && this.last.s; }
  async until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.last && fn(this.s, this.last)) return true; await sleep(15); } throw new Error(`${this.name}: timeout waiting [${label}] | toasts=${this.toasts.slice(-5)} phase=${this.s&&this.s.phase} turn=${this.s&&this.s.turn} you=${this.last&&this.last.you} stage=${this.s&&this.s.stage} v=${this.last&&this.last.v} hand=${this.s&&JSON.stringify(this.s.hand)} msg=${this.s&&this.s.message}`); }
  close() { try { this.ws.close(); } catch {} }
}
async function newRoom() { const r = await fetch(BASE + '/api/new'); return (await r.json()).code; }

test('cameră privată: creare → cod → 3 jucători → READY → start → set complet până la scorul țintă', { timeout: 240000 }, async () => {
  const code = await newRoom(); assert.match(code, /^CLAIM-\d{4}$/);
  const A = await new Client('ANA').connect(code, 'create', { n: 3, target: 300, bots: false });
  const B = await new Client('BOGDAN').connect(code, 'join');
  const C = await new Client('CRISTI').connect(code, 'join');
  const P = [A, B, C];
  await A.until(s => s.seats.length === 3);
  assert.equal(A.s.seats[0].host, true);
  A.send({ t: 'start' }); await sleep(150); assert.ok(A.toasts.includes('notready'), 'gazda nu poate porni până nu sunt toți READY');
  B.send({ t: 'ready' }); C.send({ t: 'ready' }); await A.until(s => s.seats.every(x => x.host || x.ready));
  A.send({ t: 'start' });
  await Promise.all(P.map(c => c.until(s => s.phase === 'play')));

  // atacuri: mutare în afara turei, mutare dublă
  const notTurn = P.find(c => c.s.turn !== c.last.you);
  notTurn.send({ t: 'discard', rank: notTurn.s.hand[0].r, v: notTurn.last.mv }); await sleep(100);
  assert.ok(notTurn.toasts.includes('badmove'), 'mutare în afara turei respinsă');

  let rounds = 0, moves = 0, setEnded = false, privacyChecks = 0, reshuffleSeen = false;
  const t0 = Date.now();
  while (!setEnded && Date.now() - t0 < 200000) {
    const cur = P.find(c => c.s && c.s.phase === 'play' && c.s.turn === c.last.you);
    const any = P[0].s;
    if (any.phase === 'result') {
      const r = any.result; rounds++;
      // toate dispozitivele văd același scor
      for (const c of P) await c.until(s => s.phase === 'result' && s.roundNo === any.roundNo, 8000, 'resultsync');
      const sc = P.map(c => { const s = c.s; return s.score.join(','); }); assert.equal(new Set(sc).size, 1, 'scoruri sincronizate');
      if (r.setEnd) { setEnded = true; break; }
      const rn = any.roundNo; P.forEach(c => c.send({ t: 'ready' }));
      await Promise.all(P.map(c => c.until(s => s.roundNo > rn && s.phase === 'play', 8000, 'nextround')));
      continue;
    }
    if (!cur) { await sleep(10); continue; }
    const s = cur.s, v = cur.last.v, mv = cur.last.mv;
    // confidențialitate: ce primește fiecare client conține doar mâna lui
    for (const c of P) { const st = c.s; if (st.phase !== 'play') continue; const mine = new Set(st.hand.map(key)); for (const o of P) if (o !== c && o.s.phase === 'play' && o.s.roundNo === st.roundNo) for (const card of o.s.hand) if (!mine.has(key(card))) { assert.ok(!JSON.stringify(st.hand).includes(`"r":${card.r},"s":${card.s}}`)); } privacyChecks++; assert.ok(!('stock' in st) && !('hands' in st)); }
    const allPlayed = s.played.every(Boolean);
    const myPts = s.hand.reduce((a, c) => a + (s.trump && c.r === s.trump.r ? 0 : c.r), 0);
    if (allPlayed && myPts <= 7) { cur.send({ t: 'claim', v: mv }); await cur.until((st, m) => m.v > v, 8000, 'claim'); continue; }
    const rank = Math.max(...s.hand.map(c => c.r));
    cur.send({ t: 'discard', rank, v: mv }); await cur.until((st, m) => m.v > v && st.stage === 'draw', 8000, 'discard');
    const v2 = cur.last.v, mv2 = cur.last.mv; cur.send({ t: 'draw', v: mv2 - 1, from: 'stock' }); await sleep(30); // mesaj întârziat (v vechi) → respins
    assert.ok(cur.toasts.includes('stale'), 'mesaj întârziat respins');
    const before = cur.s.stockCount;
    cur.send({ t: 'draw', from: s.exposed && (s.exposed.r <= 3) ? 'exposed' : 'stock', v: mv2 }); await cur.until((st, m) => m.v > v2, 8000, 'draw');
    if (cur.s.stockTotal && cur.s.stockCount > before) reshuffleSeen = true;
    moves++; await sleep(130); // ritm realist (un om nu mută de 30 de ori pe secundă)
  }
  assert.ok(setEnded, 'setul s-a terminat'); assert.ok(rounds >= 1); assert.ok(privacyChecks > 50);
  const fin = P[0].s; assert.ok(fin.score.some(x => x >= 300)); assert.equal(fin.general.reduce((a, b) => a + b, 0), 5 + 3 + 2);
  // set nou
  const rn = fin.roundNo; P.forEach(c => c.send({ t: 'ready' }));
  await Promise.all(P.map(c => c.until(s => s.roundNo > rn && s.phase === 'play' && s.score.every(x => x === 0))));
  console.log(`  set complet: ${rounds} runde, ${moves} mutări, ${privacyChecks} verificări de confidențialitate, reamestecare văzută: ${reshuffleSeen}`);
  P.forEach(c => c.close());
});

test('reconectare: jucătorul revine cu aceleași cărți și scor; gazda deconectată → gazdă nouă', { timeout: 30000 }, async () => {
  const code = await newRoom();
  const A = await new Client('HOST').connect(code, 'create', { n: 4, target: 300, bots: true, diff: 'GREU' });
  const B = await new Client('BOB').connect(code, 'join');
  B.send({ t: 'ready' }); await A.until(s => s.seats.every(x => x.host || x.ready));
  A.send({ t: 'start' }); await B.until(s => s.phase === 'play');
  assert.equal(B.s.seats.filter(x => x.bot).length, 2, 'locurile libere completate cu boți');
  const handBefore = B.s.hand.map(key).sort().join(), tok = B.token, seat = B.last.you;
  B.close(); await A.until(s => !s.seats[seat].connected);
  const B2 = await new Client('BOB', tok).connect(code, 'join');
  assert.equal(B2.last.you, seat, 'același loc');
  // cărțile pot fi schimbate doar dacă între timp a mutat calculatorul pentru el
  if (!B2.s.lastMove[seat]) assert.equal(B2.s.hand.map(key).sort().join(), handBefore, 'aceleași cărți');
  assert.ok(B2.s.seats[seat].connected);
  // gazda pleacă → BOB devine gazdă
  A.close(); await B2.until(s => s.seats[seat].host === true);
  // jocul continuă (boții mută, BOB mută la tura lui)
  const rn = B2.s.roundNo, v0 = B2.last.v; await B2.until((s, m) => m.v > v0 + 3, 15000);
  B2.close();
});

test('JOIN cu cod greșit → eroare clară; camera plină → refuz', { timeout: 15000 }, async () => {
  const X = await new Client('X').connect('CLAIM-0001', 'join'); assert.ok(X.errors.includes('notfound'));
  const code = await newRoom();
  const A = await new Client('A').connect(code, 'create', { n: 2, bots: false });
  const B = await new Client('B').connect(code, 'join');
  const C = await new Client('C').connect(code, 'join'); assert.ok(C.errors.includes('full'));
  const r = await (await fetch(BASE + '/api/room?code=' + code)).json(); assert.equal(r.exists, true);
  A.close(); B.close();
});

test('camere publice: apar în listă cu nume, jucători, locuri și stare', { timeout: 15000 }, async () => {
  const code = await newRoom();
  const A = await new Client('PUB').connect(code, 'create', { n: 4, public: true, roomName: 'Seara CLAIM' });
  const list = await (await fetch(BASE + '/api/rooms')).json();
  const r = list.rooms.find(x => x.code === code); assert.ok(r); assert.equal(r.name, 'Seara CLAIM'); assert.equal(r.free, 3); assert.equal(r.phase, 'lobby');
  const priv = await newRoom(); const P = await new Client('PRIV').connect(priv, 'create', { n: 4 });
  const list2 = await (await fetch(BASE + '/api/rooms')).json(); assert.ok(!list2.rooms.some(x => x.code === priv), 'camerele private nu apar');
  A.close(); P.close();
});

test('online: teancul se termină fără CLAIM → cărțile aruncate se reamestecă în teanc și jocul continuă', { timeout: 60000 }, async () => {
  const code = await newRoom();
  const A = await new Client('A1').connect(code, 'create', { n: 2, bots: false });
  const B = await new Client('B1').connect(code, 'join');
  B.send({ t: 'ready' }); await A.until(s => s.seats.every(x => x.host || x.ready)); A.send({ t: 'start' });
  const P = [A, B]; await Promise.all(P.map(c => c.until(s => s.phase === 'play')));
  const total0 = A.s.stockTotal; let reshuffled = false, sawEmpty = false;
  for (let k = 0; k < 200 && !reshuffled; k++) {
    const cur = P.find(c => c.s.turn === c.last.you && c.s.phase === 'play'); if (!cur) { await sleep(10); continue; }
    const v = cur.last.v; cur.send({ t: 'discard', rank: Math.max(...cur.s.hand.map(c => c.r)), v: cur.last.mv }); await cur.until((s, m) => m.v > v);
    const v2 = cur.last.v; if (cur.s.stockCount === 1) sawEmpty = true;
    cur.send({ t: 'draw', from: 'stock', v: cur.last.mv }); await cur.until((s, m) => m.v > v2);
    if (cur.s.stockTotal !== total0) { reshuffled = true; assert.ok(cur.s.stockCount > 0, 'teanc nou'); assert.ok(cur.s.exposed, 'cartea expusă rămâne'); assert.equal(cur.s.phase, 'play', 'jocul continuă'); assert.match(cur.s.message, /reamestecat/); }
  }
  assert.ok(sawEmpty && reshuffled, 'teancul s-a terminat și a fost refăcut');
  A.close(); B.close();
});
