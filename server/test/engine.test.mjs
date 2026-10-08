import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

function seeded(s) { return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
function integrity(G) {
  const all = [G.trump, ...G.hands.flat(), ...G.stock, ...G.discard, ...G.pending].filter(Boolean);
  const keys = new Set(all.map(E.cardKey));
  assert.equal(all.length, 52, 'exact 52 de cărți');
  assert.equal(keys.size, 52, 'fără duplicate');
  for (const r of E.RANKS) assert.equal(all.filter(c => c.r === r).length, 4, `4 cărți de ${r}`);
}
function game(n, diff = 'GREU', seed = 1, target = 300) {
  const G = E.newGame({ n, target, diff });
  for (let i = 0; i < n; i++) G.seats.push({ name: 'P' + i, bot: true, human: false });
  return G;
}

test('împărțire: 5 cărți fiecăruia, atu + 1 expusă, restul teanc (2–6 jucători)', () => {
  for (let n = 2; n <= 6; n++) {
    const G = game(n); E.startSet(G, seeded(n));
    assert.ok(G.hands.every(h => h.length === 5)); assert.equal(G.discard.length, 1);
    assert.equal(G.stock.length, 52 - 5 * n - 2); assert.ok(G.trump); integrity(G);
  }
});

test('validare mutări: în afara turei, rang inexistent, CLAIM în prima rotație', () => {
  const G = game(3); E.startSet(G, seeded(7));
  assert.ok(E.discard(G, 1, G.hands[1][0].r), 'jucătorul 1 nu e la tură');
  const missing = E.RANKS.find(r => !G.hands[0].some(c => c.r === r));
  assert.ok(E.discard(G, 0, missing), 'rang absent');
  assert.ok(E.draw(G, 0, 'stock', seeded(1)).err, 'nu poate trage înainte să arunce');
  assert.ok(E.claim(G, 0).err, 'fără CLAIM în prima rotație');
  assert.equal(E.discard(G, 0, G.hands[0][0].r), null);
  assert.ok(E.discard(G, 0, G.hands[0][0].r), 'nu poate arunca de două ori');
  integrity(G);
});

test('aruncă toate cărțile de aceeași valoare (max 4) și ia cartea expusă', () => {
  const G = game(2); E.startSet(G, seeded(3));
  G.hands[0] = [{ r: 7, s: 0 }, { r: 7, s: 1 }, ...G.hands[0].filter(c => c.r !== 7)].slice(0, 5);
  // refacem integritatea pachetului: scoatem din celelalte zone cărțile mutate
  const ks = new Set(G.hands[0].map(E.cardKey));
  G.stock = G.stock.filter(c => !ks.has(E.cardKey(c))); G.discard = G.discard.filter(c => !ks.has(E.cardKey(c))); G.hands[1] = G.hands[1].filter(c => !ks.has(E.cardKey(c)));
  if (G.trump && ks.has(E.cardKey(G.trump))) G.trump = G.stock.pop();
  const top = G.discard[G.discard.length - 1];
  E.discard(G, 0, 7); const r = E.draw(G, 0, 'exposed', seeded(2));
  assert.deepEqual(r.ev.out.map(c => c.r), [7, 7]); assert.deepEqual(r.ev.took, top);
  assert.ok(G.hands[0].some(c => E.cardKey(c) === E.cardKey(top))); assert.ok(G.known[0].some(c => E.cardKey(c) === E.cardKey(top)));
});

test('scor CLAIM: corect → ceilalți adaugă mâna; prins → +50, cel care prinde 0', () => {
  const G = game(3); E.startSet(G, seeded(5)); G.trump = { r: 13, s: 0 };
  G.hands = [[{ r: 1, s: 0 }], [{ r: 5, s: 0 }], [{ r: 9, s: 0 }]];
  let res = E.endRound(G, 0); assert.equal(res.catcher, -1); assert.deepEqual(G.score.slice(0, 3), [0, 5, 9]);
  G.phase = 'play'; G.hands = [[{ r: 6, s: 1 }], [{ r: 6, s: 2 }], [{ r: 9, s: 1 }]];
  res = E.endRound(G, 0); assert.equal(res.catcher, 1, 'egalitatea prinde'); assert.deepEqual(G.score.slice(0, 3), [50, 5, 18]);
  G.phase = 'play'; G.hands = [[{ r: 13, s: 1 }, { r: 2, s: 1 }], [{ r: 3, s: 2 }], [{ r: 9, s: 2 }]];
  res = E.endRound(G, 0); assert.equal(res.catcher, -1, 'ATU-ul valorează 0'); assert.equal(res.handPts[0], 2);
});

test('teancul se termină → cărțile aruncate se reamestecă, cartea expusă rămâne', () => {
  const G = game(2); E.startSet(G, seeded(11)); const rng = seeded(4); let reshuffles = 0;
  for (let k = 0; k < 400 && G.phase === 'play'; k++) {
    const before = G.stockTotal;
    const p = G.turn; E.discard(G, p, Math.max(...G.hands[p].map(c => c.r))); const r = E.draw(G, p, 'stock', rng);
    if (G.stockTotal !== before) reshuffles++;
    integrity(G); assert.ok(G.discard.length >= 1);
  }
  assert.ok(reshuffles >= 1, 'a avut loc cel puțin o reamestecare');
});

for (let n = 2; n <= 6; n++) test(`set complet cu ${n} jucători (boți GREU/MEDIU/UȘOR) până la scorul țintă, pachet verificat la fiecare mutare`, () => {
  for (const diff of E.DIFFS) {
    const G = game(n, diff, n, 300); const rng = seeded(100 + n); E.startSet(G, rng); let rounds = 0, moves = 0;
    while (true) {
      if (G.phase === 'result') { rounds++; if (G.result.setEnd) break; E.nextRound(G, rng); continue; }
      E.autoAct(G, G.turn, rng, true); moves++; integrity(G);
      assert.ok(moves < 200000, 'fără buclă infinită');
    }
    assert.ok(G.score.slice(0, n).some(v => v >= 300)); assert.ok(rounds > 0);
    const gen = G.general.slice(0, n).reduce((a, b) => a + b, 0); assert.equal(gen, [5, 3, 2, 1, 0, 0].slice(0, n).reduce((a, b) => a + b, 0));
  }
});

test('viewFor: un jucător nu vede cărțile altuia și nici teancul', () => {
  const G = game(4); E.startSet(G, seeded(9));
  const v = E.viewFor(G, 2), s = JSON.stringify(v);
  assert.equal(v.hand.length, 5); assert.ok(!('stock' in v)); assert.ok(!('hands' in v));
  for (const i of [0, 1, 3]) for (const c of G.hands[i]) if (!G.hands[2].some(x => E.cardKey(x) === E.cardKey(c)) && !(G.trump && E.cardKey(G.trump) === E.cardKey(c))) assert.ok(!s.includes(`{"r":${c.r},"s":${c.s}}`) || G.discard.some(d => E.cardKey(d) === E.cardKey(c)), 'nicio carte a adversarului');
  assert.equal(v.result, null);
});
