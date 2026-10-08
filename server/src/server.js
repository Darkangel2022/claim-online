// CLAIM Online — server Node.js (HTTP + WebSocket). Pornire: node src/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { RoomCore } from './room.js';

const require = createRequire(import.meta.url);
let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); } catch { ({ WebSocketServer } = require(process.env.CLAIM_WS_PATH || '/opt/npm-tools/node_modules/ws')); }

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const PUBLIC = path.resolve(process.env.CLAIM_PUBLIC || path.join(__dir, '../../public'));
const DATA = process.env.CLAIM_DATA || path.join(__dir, '../data');
const SNAP = path.join(DATA, 'rooms.json');
const MAX_ROOMS = +process.env.CLAIM_MAX_ROOMS || 500;

// amestecare criptografic sigură
const rng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const rooms = new Map(); // code -> {core, conns:Set, timer}
let dirty = false;

function newCode() { for (let i = 0; i < 1000; i++) { const c = 'CLAIM-' + String(crypto.randomInt(1000, 10000)); if (!rooms.has(c)) return c; } return 'CLAIM-' + crypto.randomInt(10000, 100000); }
function normCode(c) { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (/^\d{4,5}$/.test(c)) c = 'CLAIM' + c; const m = /^CLAIM(\d{4,5})$/.exec(c); return m ? 'CLAIM-' + m[1] : null; }

function getRoom(code, create) {
  let r = rooms.get(code); if (r || !create) return r;
  r = { conns: new Set(), timer: null };
  const io = {
    now: () => Date.now(), rng,
    save: () => { dirty = true; },
    destroy: () => { clearTimeout(r.timer); for (const c of r.conns) try { c.close(1000, 'closed'); } catch {} rooms.delete(code); dirty = true; },
    schedule: ts => { clearTimeout(r.timer); r.timer = null; if (ts) r.timer = setTimeout(() => { try { r.core.alarm(); } catch (e) { console.error(e); } }, Math.max(0, ts - Date.now())); },
    conns: () => [...r.conns], report: () => {},
  };
  r.core = new RoomCore(io, code); rooms.set(code, r); return r;
}

// ---- persistență: starea camerelor supraviețuiește unei reporniri ----
function loadSnapshot() { try { const d = JSON.parse(fs.readFileSync(SNAP, 'utf8')); for (const [code, s] of Object.entries(d)) { const r = getRoom(code, true); r.core.load(s); r.core.plan(); r.core.schedule(); } console.log(`restaurat ${rooms.size} camere`); } catch {} }
setInterval(() => { if (!dirty) return; dirty = false; try { fs.mkdirSync(DATA, { recursive: true }); const o = {}; for (const [c, r] of rooms) if (r.core.G) o[c] = r.core.snapshot(); fs.writeFileSync(SNAP + '.tmp', JSON.stringify(o)); fs.renameSync(SNAP + '.tmp', SNAP); } catch (e) { console.error('snapshot', e.message); } }, 3000).unref();

// ---- HTTP ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.apk': 'application/vnd.android.package-archive', '.exe': 'application/octet-stream', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8' };
function json(res, code, o) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
  if (u.pathname === '/api/new') { if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'busy' }); return json(res, 200, { code: newCode() }); }
  if (u.pathname === '/api/rooms') {
    const list = [...rooms.values()].map(r => r.core.info()).filter(x => x && x.isPublic && x.online > 0).sort((a, b) => (b.free > 0) - (a.free > 0) || b.online - a.online).slice(0, 50);
    return json(res, 200, { rooms: list });
  }
  if (u.pathname === '/api/room') { const c = normCode(u.searchParams.get('code')); const r = c && rooms.get(c); return json(res, 200, { exists: !!(r && r.core.G), info: r && r.core.info() }); }
  if (u.pathname === '/config.js') {
    // setările de monetizare vin din variabilele de mediu (panoul Render) — fără modificări de cod
    const ads = { every: +process.env.CLAIM_ADS_EVERY || 3, adsenseClient: process.env.CLAIM_ADSENSE_CLIENT || '', donateUrl: process.env.CLAIM_DONATE_URL || '' };
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(`window.CLAIM_SERVER="";\nwindow.CLAIM_ADS=${JSON.stringify(ads)};\n`);
  }
  if (u.pathname === '/ads.txt') {
    const pub = (process.env.CLAIM_ADSENSE_CLIENT || '').replace(/^ca-/, '');
    res.writeHead(pub ? 200 : 404, { 'content-type': 'text/plain' });
    return res.end(pub ? `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n` : '');
  }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f), noCache = ['.html', '.webmanifest', '.js'].includes(ext);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': noCache ? 'no-cache' : 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(f).pipe(res);
  });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const code = normCode(u.searchParams.get('room'));
  if (!code) { ws.close(4000, 'badcode'); return; }
  const mode = u.searchParams.get('mode');
  const existing = rooms.get(code);
  if (!existing && mode !== 'create') { try { ws.send(JSON.stringify({ t: 'error', code: 'notfound' })); } catch {} ws.close(4000, 'notfound'); return; }
  if (!existing && rooms.size >= MAX_ROOMS) { ws.close(4000, 'busy'); return; }
  const r = getRoom(code, true);
  const conn = { meta: {}, send: o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }, close: (c, why) => ws.close(c, why) };
  r.conns.add(conn); ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', buf => { let m; try { m = JSON.parse(buf); } catch { return; } try { r.core.message(conn, m); } catch (e) { console.error(e); } });
  ws.on('close', () => { r.conns.delete(conn); try { r.core.closed(conn); } catch (e) { console.error(e); } if (!r.core.G && !r.conns.size) rooms.delete(code); });
});
// detectează conexiunile moarte (telefon blocat, rețea pierdută)
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 15000).unref();

loadSnapshot();
server.listen(PORT, () => console.log(`CLAIM Online: http://localhost:${PORT}  (fișiere: ${PUBLIC})`));
