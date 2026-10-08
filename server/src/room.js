// CLAIM — logica unei camere online (independentă de transport).
import * as E from './engine.js';

const envInt = (k, d) => { const v = +(globalThis.process && process.env && process.env[k]); return v > 0 ? v : d; };
export const CFG = {
  TURN_MS: envInt('CLAIM_TURN_MS', 45000),          // timp de gândire pentru un om
  BOT_MS: envInt('CLAIM_BOT_MS', 2300),             // pauza unui bot (lasă animația clienților să se termine)
  GRACE_MS: envInt('CLAIM_RECONNECT_MS', 60000),    // cât așteptăm un jucător deconectat la tura lui
  RESULT_MS: envInt('CLAIM_RESULT_MS', 30000),      // ecranul de rezultat
  EMPTY_MS: envInt('CLAIM_EMPTY_MS', 10 * 60000),   // camera fără niciun om conectat se închide
};
const BOT_NAMES = ['LUNA', 'MATEI', 'NOVA', 'ARIA', 'LEO', 'IRIS', 'TUDOR', 'MARA'];
export const EMOTE_COUNT = 12;
const clean = s => String(s || '').replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 14);

export class RoomCore {
  /** io: { now(), rng(), save(), destroy(), schedule(ts|null), conns(): [{send(obj), meta, close(code,reason)}], report() } */
  constructor(io, code) { this.io = io; this.code = code; this.G = null; this.meta = { code, isPublic: false, bots: true, roomName: '', deadline: 0, kind: null, key: '' }; }
  snapshot() { return { G: this.G, meta: this.meta }; }
  load(d) { if (d && d.G) { this.G = d.G; this.meta = { ...this.meta, ...d.meta, key: '' }; for (const s of this.G.seats) if (s.human) { s.connected = false; s.discAt = this.io.now(); } } }
  seatOf(conn) { const t = conn.meta && conn.meta.token; return this.G && t ? this.G.seats.findIndex(s => s.token === t) : -1; }
  humansOnline() { return this.G ? this.G.seats.filter(s => s.human && s.connected).length : 0; }
  info() {
    const G = this.G; if (!G) return null;
    const humans = G.seats.filter(s => s.human).length, botsSeats = G.seats.filter(s => !s.human).length;
    const free = G.phase === 'lobby' ? G.n - G.seats.length : botsSeats;
    return { code: this.code, name: this.meta.roomName || this.code, isPublic: this.meta.isPublic, phase: G.phase, players: humans, online: this.humansOnline(), n: G.n, free: Math.max(0, free), target: G.target };
  }

  // ---------- intrare ----------
  hello(conn, m) {
    const name = clean(m.name) || 'PLAYER', token = String(m.token || '');
    if (!/^[A-Za-z0-9_-]{8,48}$/.test(token)) return this.reject(conn, 'bad');
    const now = this.io.now();
    if (!this.G) {
      if (m.mode !== 'create') return this.reject(conn, 'notfound');
      const o = m.opts || {};
      this.G = E.newGame({ n: clampN(o.n), target: E.TARGETS.includes(+o.target) ? +o.target : 300, diff: E.DIFFS.includes(o.diff) ? o.diff : 'MEDIU' });
      this.meta.isPublic = !!o.public; this.meta.bots = o.bots !== false; this.meta.roomName = clean(o.roomName) || ''; this.meta.createdAt = now;
    }
    const G = this.G; let seat = G.seats.findIndex(s => s.token === token);
    if (seat >= 0) { const s = G.seats[seat]; const was = s.connected; s.connected = true; s.discAt = 0; s.away = 0; s.name = s.name || name; if (s.human) s.bot = false; if (!was && G.phase !== 'lobby') G.message = `${s.name} s-a reconectat.`; }
    else if (G.phase === 'lobby') {
      if (G.seats.length >= G.n) return this.reject(conn, 'full');
      G.seats.push({ name: this.uniqueName(name), token, human: true, connected: true, bot: false, ready: false }); seat = G.seats.length - 1;
    } else {
      seat = G.seats.findIndex(s => !s.human);
      if (seat < 0) return this.reject(conn, 'full');
      const old = G.seats[seat];
      G.seats[seat] = { name: this.uniqueName(name), token, human: true, connected: true, bot: false, away: 0, ready: true };
      G.message = `${G.seats[seat].name} a preluat locul lui ${old.name}.`;
    }
    conn.meta = { token, rl: [] };
    this.fixHost(); this.change([]);
  }
  uniqueName(n) { const used = new Set(this.G.seats.map(s => s.name)); let x = n, k = 2; while (used.has(x)) x = `${n.slice(0, 11)} ${k++}`; return x; }
  reject(conn, code) { try { conn.send({ t: 'error', code }); conn.close(4000, code); } catch (e) {} }
  fixHost() { const G = this.G; let h = G.seats.findIndex(s => s.host && s.human && s.connected); if (h < 0) h = G.seats.findIndex(s => s.human && s.connected); G.seats.forEach((s, i) => (s.host = i === h)); }

  closed(conn) {
    if (!this.G || !conn.meta || !conn.meta.token) return;
    const t = conn.meta.token;
    if (this.io.conns().some(c => c !== conn && c.meta && c.meta.token === t)) return;
    const i = this.G.seats.findIndex(s => s.token === t); if (i < 0) return;
    const s = this.G.seats[i];
    if (this.G.phase === 'lobby') this.G.seats.splice(i, 1);
    else { s.connected = false; s.discAt = this.io.now(); this.G.message = `${s.name} s-a deconectat — așteptăm reconectarea (${Math.round(CFG.GRACE_MS / 1000)} s).`; }
    this.fixHost(); this.change([], conn);
  }

  // ---------- mesaje ----------
  message(conn, m) {
    if (!m || typeof m !== 'object') return;
    const now = this.io.now(), rl = conn.meta.rl || (conn.meta.rl = []);
    while (rl.length && now - rl[0] > 10000) rl.shift(); rl.push(now); if (rl.length > 100) { if (!conn.meta.rlWarned) { conn.meta.rlWarned = true; conn.send({ t: 'toast', code: 'slow' }); } return; } conn.meta.rlWarned = false;
    if (m.t === 'hello') return this.hello(conn, m);
    if (m.t === 'ping') return conn.send({ t: 'pong', now });
    if (!this.G) return;
    const G = this.G, p = this.seatOf(conn); if (p < 0) return;
    const s = G.seats[p], rng = this.io.rng, err = code => conn.send({ t: 'toast', code });
    // protecție la mesaje duplicate/întârziate: acțiunile de joc poartă numărul de stare văzut de client
    const stale = m.v != null && m.v !== (this.meta.mv || 0);
    switch (m.t) {
      case 'opts': if (G.phase !== 'lobby' || !s.host) return;
        if (m.n != null) G.n = Math.max(clampN(m.n), G.seats.length);
        if (E.TARGETS.includes(+m.target)) G.target = +m.target;
        if (E.DIFFS.includes(m.diff)) G.diff = m.diff;
        if (m.bots != null) this.meta.bots = !!m.bots;
        if (m.public != null) this.meta.isPublic = !!m.public;
        return this.change([]);
      case 'ready': s.ready = m.ready !== false;
        if (G.phase === 'result' && G.seats.every(x => !x.human || !x.connected || x.ready)) { E.nextRound(G, rng); this.bump(); return this.change([{ k: 'round' }]); }
        return this.change([]);
      case 'start': {
        if (G.phase !== 'lobby' || !s.host) return;
        const humans = G.seats.filter(x => x.connected);
        if (!this.meta.bots && humans.length < 2) return err('need2');
        if (humans.some(x => !x.host && !x.ready)) return err('notready');
        return this.start();
      }
      case 'discard': { if (stale) { if (process.env.CLAIM_DEBUG) console.error('STALE discard', p, 'client', m.v, 'server', this.meta.mv, 'phase', G.phase, 'turn', G.turn, 'stage', G.stage); return err('stale'); } s.away = 0; const e = E.discard(G, p, +m.rank); if (e) return err('badmove'); this.bump(); return this.change([]); }
      case 'draw': { if (stale) return err('stale'); s.away = 0; const r = E.draw(G, p, m.from === 'exposed' ? 'exposed' : 'stock', rng); if (r.err) return err('badmove'); this.bump(); return this.change([r.ev]); }
      case 'claim': { if (stale) return err('stale'); s.away = 0; const r = E.claim(G, p); if (r.err) return err('noclaim'); this.meta.resultAt = now; this.bump(); return this.change([r.ev]); }
      case 'emote': { const id = +m.id; if (!(id >= 0 && id < EMOTE_COUNT)) return; if (now - (conn.meta.lastEmote || 0) < 1200) return; conn.meta.lastEmote = now; return this.broadcast({ t: 'emote', seat: p, id }); }
      case 'leave':
        if (G.phase === 'lobby') G.seats.splice(p, 1);
        else { const nm = s.name; G.seats[p] = { name: BOT_NAMES.find(b => !G.seats.some(x => x.name === b)) || 'BOT', bot: true, human: false, connected: true }; G.message = `${nm} a părăsit masa — un bot îi ia locul.`; }
        conn.meta.token = null; this.fixHost(); this.change([], conn); try { conn.send({ t: 'left' }); conn.close(1000, 'left'); } catch (e) {} return;
    }
  }

  start() {
    const G = this.G; G.seats = G.seats.filter(s => s.connected);
    if (!G.seats.length) return;
    if (this.meta.bots) {
      G.n = Math.max(G.n, G.seats.length, 2);
      const used = new Set(G.seats.map(s => s.name));
      for (const nm of BOT_NAMES) { if (G.seats.length >= G.n) break; if (!used.has(nm)) G.seats.push({ name: nm, bot: true, human: false, connected: true }); }
    } else G.n = G.seats.length;
    for (const s of G.seats) s.ready = false;
    E.startSet(G, this.io.rng); this.bump(); this.change([{ k: 'round' }]);
  }

  // ---------- timp ----------
  alarm() {
    const G = this.G, now = this.io.now(); if (!G) return this.io.destroy();
    if (this.meta.kind === 'empty') { if (now >= this.meta.deadline - 50) return this.io.destroy(); return this.schedule(); }
    if (!this.meta.deadline || now < this.meta.deadline - 50) return this.schedule();
    const rng = this.io.rng; let ev = [];
    switch (this.meta.kind) {
      case 'auto': { const s = G.seats[G.turn]; ev = E.autoAct(G, G.turn, rng, !s.human); if (s.human && !s.connected) G.message = `${s.name} nu s-a reconectat la timp — calculatorul mută în locul lui până revine.`; break; }
      case 'turn': { const s = G.seats[G.turn]; s.away = (s.away || 0) + 1; ev = E.autoAct(G, G.turn, rng, false); G.message = `${s.name} n-a mutat la timp — mutare automată.`; break; }
      case 'result': E.nextRound(G, rng); ev = [{ k: 'round' }]; break;
    }
    if (ev.some(e => e && e.k === 'claim')) this.meta.resultAt = now;
    this.bump(); this.change(ev.filter(Boolean));
  }

  /* Reguli de continuare (documentate):
     - om conectat: are TURN_MS pentru mutare; la expirare se face o mutare automată simplă (fără CLAIM).
     - om deconectat: tura lui așteaptă până la GRACE_MS de la deconectare; apoi calculatorul mută pentru el
       (fără CLAIM) până se reconectează și își reia locul cu aceleași cărți și scor.
     - după 2 expirări la rând, jucătorul e considerat absent și mută calculatorul rapid până acționează din nou.
     - camera fără niciun om conectat se închide după EMPTY_MS. */
  plan() {
    const G = this.G, now = this.io.now(), m = this.meta;
    if (!this.humansOnline()) { if (m.kind !== 'empty') { m.kind = 'empty'; m.key = 'empty'; m.deadline = now + CFG.EMPTY_MS; } return; }
    let kind = null, key = 'idle', dl = 0;
    if (G.phase === 'play') {
      const s = G.seats[G.turn];
      if (!s.human || (s.away || 0) >= 2) { kind = 'auto'; dl = now + (G.stage === 'draw' ? 700 : CFG.BOT_MS); }
      else if (!s.connected) { kind = 'auto'; dl = Math.max(now + CFG.BOT_MS, (s.discAt || now) + CFG.GRACE_MS); }
      else { kind = 'turn'; dl = now + CFG.TURN_MS; }
      key = `${G.roundNo}:${G.turn}:${G.stage}:${kind}:${s.connected}`;
    } else if (G.phase === 'result') { kind = 'result'; key = `res:${G.roundNo}`; dl = (m.resultAt || now) + CFG.RESULT_MS; }
    if (key !== m.key) { m.key = key; m.kind = kind; m.deadline = dl; }
  }
  bump() { this.meta.mv = (this.meta.mv || 0) + 1; } // numărul mutării de joc (protecție la mesaje întârziate/duplicate)
  schedule() { this.io.schedule(this.meta.kind && this.meta.deadline ? this.meta.deadline : null); }

  change(ev, except = null) {
    this.meta.v = (this.meta.v || 0) + 1; this.meta.lastActive = this.io.now();
    this.plan(); this.io.save(); this.schedule(); this.sendAll(ev, except); this.io.report();
  }
  sendAll(ev, except) {
    const m = this.meta;
    for (const c of this.io.conns()) {
      if (c === except || !c.meta || !c.meta.token) continue;
      const seat = this.seatOf(c); if (seat < 0) continue;
      c.send({ t: 'update', v: m.v, mv: m.mv || 0, ev, s: E.viewFor(this.G, seat), you: seat, code: this.code, room: { isPublic: m.isPublic, bots: m.bots, name: m.roomName }, deadline: m.kind === 'turn' || m.kind === 'result' ? m.deadline : (m.kind === 'auto' && this.G.seats[this.G.turn] && this.G.seats[this.G.turn].human && !this.G.seats[this.G.turn].connected ? m.deadline : 0), now: this.io.now() });
    }
  }
  broadcast(o) { for (const c of this.io.conns()) if (c.meta && c.meta.token) c.send(o); }
}
function clampN(n) { n = +n; return n >= 2 && n <= 6 ? Math.floor(n) : 4; }
