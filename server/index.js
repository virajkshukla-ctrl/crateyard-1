// Crateyard game server: accounts, friends, stats and real-time matches over WebSocket.
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import { makeStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const MAX_PLAYERS = 6, TEAM_MAX = 3, TICK_MS = 50;
const TARGET = n => (n <= 1 ? 5 : n === 2 ? 8 : 10);

const store = makeStore();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));

// The store apps load the game from their own origin, so the API answers any origin.
// Auth uses a bearer token, never cookies, so this is safe.
app.use('/api', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- helpers ----------
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60_000).unref();
async function newSession(userId) { const token = crypto.randomBytes(32).toString('hex'); await store.createSession(userId, sha(token)); return token; }
async function auth(req, res, next) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '');
  const user = m && await store.sessionUser(sha(m[1]));
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user; req.tokenHash = sha(m[1]); next();
}
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
function checkPassword(p) { return typeof p === 'string' && p.length >= 4 && Buffer.byteLength(p) <= 72; }

// ---------- accounts ----------
app.post('/api/signup', wrap(async (req, res) => {
  if (limited('signup:' + req.ip, 10, 600_000)) return res.status(429).json({ error: 'Too many new accounts from here. Try again later.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME.test(username)) return res.status(400).json({ error: 'Usernames are 3 to 16 letters, numbers or underscores.' });
  if (!checkPassword(password)) return res.status(400).json({ error: 'Passwords need at least 4 characters.' });
  let user;
  try { user = await store.createUser(username, await bcrypt.hash(password, 10)); }
  catch (e) { if (e.code === 'taken') return res.status(409).json({ error: 'That username is taken. Pick another one.' }); throw e; }
  res.json({ token: await newSession(user.id), user });
}));
app.post('/api/login', wrap(async (req, res) => {
  if (limited('login:' + req.ip, 30, 600_000)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  const { username, password } = req.body || {};
  const row = typeof username === 'string' && await store.userByName(username);
  if (!row || typeof password !== 'string' || !(await bcrypt.compare(password, row.pass_hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  const user = await store.userById(row.id);
  res.json({ token: await newSession(user.id), user });
}));
app.post('/api/logout', auth, wrap(async (req, res) => { await store.deleteSession(req.tokenHash); res.json({ ok: true }); }));
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.delete('/api/me', auth, wrap(async (req, res) => {
  const hash = await store.passHash(req.user.id);
  if (!(await bcrypt.compare(String(req.body?.password || ''), hash))) return res.status(401).json({ error: 'That password is not right.' });
  const c = online.get(req.user.id); if (c) { leaveMatch(c); c.ws.close(4001, 'deleted'); }
  await store.deleteUser(req.user.id);
  res.json({ ok: true });
}));

// ---------- friends ----------
app.get('/api/friends', auth, wrap(async (req, res) => res.json({ friends: await friendsView(req.user.id) })));
app.post('/api/friends', auth, wrap(async (req, res) => {
  const name = String(req.body?.username || '');
  const f = USERNAME.test(name) && await store.userByName(name);
  if (!f) return res.status(404).json({ error: 'No player with that username.' });
  if (f.id === req.user.id) return res.status(400).json({ error: 'That is you.' });
  await store.addFriend(req.user.id, f.id);
  res.json({ friends: await friendsView(req.user.id) });
}));
app.delete('/api/friends/:username', auth, wrap(async (req, res) => {
  const f = await store.userByName(req.params.username);
  if (f) await store.removeFriend(req.user.id, f.id);
  res.json({ friends: await friendsView(req.user.id) });
}));
async function friendsView(uid) {
  return (await store.friendList(uid)).map(f => {
    const c = online.get(f.id);
    return { username: f.username, online: !!c, inMatch: c?.match ? (c.match.public ? 'public' : c.match.code) : null, mob: !!c?.mob };
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, store: store.kind, online: online.size, matches: matches.size }));

// ---------- static game ----------
app.get('/vendor/three.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/three/build/three.min.js'), { maxAge: '30d' }));
app.use(express.static(path.join(ROOT, 'client'), { extensions: ['html'] }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Try again in a moment.' }); });

// ---------- real-time matches ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
const online = new Map();   // userId -> connection
const matches = new Map();  // code -> match
const CODECH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const send = (c, o) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const others = (m, c, o) => { const s = JSON.stringify(o); for (const p of m.players.values()) if (p !== c && p.ws.readyState === 1) p.ws.send(s); };
const everyone = (m, o) => { const s = JSON.stringify(o); for (const p of m.players.values()) if (p.ws.readyState === 1) p.ws.send(s); };

function newCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CODECH[crypto.randomInt(CODECH.length)]; } while (matches.has(c)); return c; }
function makeMatch(isPublic) { const m = { code: newCode(), public: isPublic, players: new Map(), round: 0, over: false }; matches.set(m.code, m); return m; }
function teamSize(m, t) { let n = 0; for (const p of m.players.values()) if (p.team === t) n++; return n; }
function score(m, t) { let s = 0; for (const p of m.players.values()) if (p.team === t) s += p.k; return s; }
function target(m) { return TARGET(Math.max(teamSize(m, 'A'), teamSize(m, 'B'))); }

function joinMatch(c, m) {
  if (c.match === m) return send(c, { t: 'joined', code: m.code, public: m.public, team: c.team, round: m.round });
  if (m.players.size >= MAX_PLAYERS) return send(c, { t: 'err', msg: 'That match is full.' });
  leaveMatch(c);
  c.team = teamSize(m, 'A') <= teamSize(m, 'B') ? 'A' : 'B';
  c.k = 0; c.d = 0; c.st = null; c.match = m;
  m.players.set(c.id, c);
  send(c, { t: 'joined', code: m.code, public: m.public, team: c.team, round: m.round });
}
function leaveMatch(c) {
  const m = c.match; if (!m) return;
  m.players.delete(c.id); c.match = null;
  send(c, { t: 'left' });
  if (!m.players.size) matches.delete(m.code);
}
function quickPlay(c) {
  let best = null;
  for (const m of matches.values()) if (m.public && !m.over && m.players.size < MAX_PLAYERS && (!best || m.players.size > best.players.size)) best = m;
  joinMatch(c, best || makeMatch(true));
}
async function finish(m, winner) {
  m.over = true;
  everyone(m, { t: 'end', winner, score: { A: score(m, 'A'), B: score(m, 'B') } });
  for (const p of m.players.values()) store.recordMatch(p.id, { win: p.team === winner, kills: p.k, deaths: p.d }).catch(e => console.error(e));
}

wss.on('connection', async (ws, req) => {
  let user = null;
  try { const token = new URL(req.url, 'http://x').searchParams.get('token') || ''; if (/^[a-f0-9]{64}$/.test(token)) user = await store.sessionUser(sha(token)); } catch {}
  if (!user) return ws.close(4001, 'auth');
  const prev = online.get(user.id);
  if (prev) { leaveMatch(prev); prev.ws.close(4002, 'replaced'); }
  const c = { ws, id: user.id, name: user.username, match: null, team: 'A', st: null, k: 0, d: 0, mob: false, budget: 0, budgetAt: Date.now() };
  online.set(user.id, c);
  send(c, { t: 'welcome', id: c.id, name: c.name });
  ws.on('message', raw => {
    const now = Date.now(); if (now - c.budgetAt > 1000) { c.budget = 0; c.budgetAt = now; }
    if (++c.budget > 90) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg && typeof msg.t === 'string') handle(c, msg).catch(e => console.error(e));
  });
  ws.on('close', () => { if (online.get(c.id) === c) online.delete(c.id); leaveMatch(c); });
});

async function handle(c, msg) {
  const m = c.match;
  switch (msg.t) {
    case 'quick': return quickPlay(c);
    case 'create': return joinMatch(c, makeMatch(false));
    case 'join': {
      const code = String(msg.code || '').toUpperCase();
      const target = matches.get(code);
      if (!target) return send(c, { t: 'err', msg: 'No match with that code. Check it and try again.' });
      return joinMatch(c, target);
    }
    case 'leave': return leaveMatch(c);
    case 'mob': c.mob = !!msg.mob; return;
    case 'team': {
      const t = msg.team === 'B' ? 'B' : 'A';
      if (m && t !== c.team && teamSize(m, t) < TEAM_MAX && !c.k && !c.d) { c.team = t; send(c, { t: 'team', team: t }); }
      return;
    }
    case 'state':
      if (!m) return;
      c.mob = !!msg.mob;
      c.st = { x: num(msg.x, -30, 30), y: num(msg.y, 0, 10), z: num(msg.z, -30, 30), yw: num(msg.yw, -1e4, 1e4), al: !!msg.al, w: num(msg.w, 0, 4) | 0 };
      return;
    case 'shot':
      if (m) others(m, c, { t: 'shot', from: c.id, x: num(msg.x, -60, 60), y: num(msg.y, -5, 40), z: num(msg.z, -60, 60), w: num(msg.w, 0, 4) | 0 });
      return;
    case 'hit': {
      if (!m || m.over) return;
      const to = m.players.get(Number(msg.to));
      if (!to || to.team === c.team || !c.st?.al || !to.st?.al) return;
      send(to, { t: 'hit', from: c.id, dm: num(msg.dm, 0, 999), w: String(msg.w || '').slice(0, 24), hs: !!msg.hs });
      return;
    }
    case 'died': {
      if (!m || m.over) return;
      c.d++;
      const killer = m.players.get(Number(msg.by));
      const valid = killer && killer.team !== c.team;
      if (valid) killer.k++;
      everyone(m, { t: 'kill', by: valid ? killer.id : null, victim: c.id, w: String(msg.w || '').slice(0, 24), hs: !!msg.hs });
      const tg = target(m);
      if (valid && score(m, killer.team) >= tg) await finish(m, killer.team);
      return;
    }
    case 'again':
      if (m && m.over) { m.over = false; m.round++; for (const p of m.players.values()) { p.k = 0; p.d = 0; } everyone(m, { t: 'round', round: m.round }); }
      return;
    case 'invite': {
      const to = String(msg.to || '');
      if (!m || !USERNAME.test(to)) return;
      const f = await store.userByName(to);
      const fc = f && online.get(f.id);
      if (!fc) return send(c, { t: 'err', msg: `${to} is not online right now.` });
      if (!(await store.isFriend(c.id, f.id))) return send(c, { t: 'err', msg: 'Add them as a friend first.' });
      send(fc, { t: 'invite', from: c.name, code: m.code });
      return send(c, { t: 'info', msg: `Invite sent to ${f.username}.` });
    }
    case 'friends': return send(c, { t: 'friends', friends: await friendsView(c.id) });
  }
}

setInterval(() => {
  for (const m of matches.values()) {
    const players = [];
    for (const p of m.players.values()) players.push({ id: p.id, n: p.name, tm: p.team, mob: p.mob, k: p.k, d: p.d, ...(p.st || { al: false }) });
    everyone(m, { t: 'snap', round: m.round, over: m.over, target: target(m), score: { A: score(m, 'A'), B: score(m, 'B') }, code: m.public ? null : m.code, players });
  }
}, TICK_MS);

await store.init();
server.listen(PORT, () => console.log(`[crateyard] listening on http://localhost:${PORT} (store: ${store.kind})`));
