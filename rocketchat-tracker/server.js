// Rocket.Chat Tracker — polls your Rocket.Chat account and turns mentions, DMs,
// followed threads and keyword hits into cards on a simple web board.
// Zero dependencies: Node 20.12+ (built-in fetch, http, loadEnvFile).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketChat, sleep } from './lib/rocketchat.js';
import { classify, makeTitle } from './lib/classify.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env is optional when vars come from the shell */
}

const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const cfg = {
  url: process.env.RC_URL,
  userId: process.env.RC_USER_ID,
  token: process.env.RC_TOKEN,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  pollSeconds: Math.max(Number(process.env.POLL_SECONDS || 60), 15),
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 48),
  watchKeywords: list(process.env.WATCH_KEYWORDS),
  mutedRooms: list(process.env.MUTED_ROOMS).map((r) => r.replace(/^#/, '')),
  groupMentions: process.env.INCLUDE_GROUP_MENTIONS !== 'false',
  password: process.env.BOARD_PASSWORD || '',
};

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
if (!LOCAL_HOSTS.includes(cfg.host) && cfg.password.length < 8) {
  console.error('Refusing to listen on a public address without BOARD_PASSWORD (8+ characters).');
  process.exit(1);
}

for (const k of ['url', 'userId', 'token']) {
  if (!cfg[k]) {
    console.error(`Missing RC_${k === 'userId' ? 'USER_ID' : k.toUpperCase()} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const rc = new RocketChat(cfg);

// ---------- persistence (single JSON file) ----------
const DATA_FILE = path.join(ROOT, 'data', 'state.json');
const state = loadState();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { me: null, cards: [], roomCursors: {}, lastPoll: null };
  }
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

// ---------- live updates to the browser (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

// ---------- polling ----------
const toISO = (d) => (d?.$date ? new Date(d.$date) : new Date(d)).toISOString();
const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
const GROUP_WINDOW_MS = 30 * 60 * 1000;
let polling = false;
let lastError = null;

async function poll() {
  if (polling) return;
  polling = true;
  const startedAt = new Date().toISOString();
  const fresh = [];
  try {
    if (!state.me) {
      const me = await rc.me();
      state.me = { _id: me._id, username: me.username, name: me.name };
      console.log(`Signed in as @${me.username}`);
    }
    const lookback = new Date(Date.now() - cfg.lookbackHours * 3600e3).toISOString();

    const [subsRes, roomsRes] = await Promise.all([
      rc.subscriptions(),
      rc.rooms(state.lastPoll || undefined),
    ]);
    const subs = new Map((subsRes.update || []).map((s) => [s.rid, s]));
    const rooms = (roomsRes.update || []).filter((r) => subs.has(r._id) && r.lm);

    for (const room of rooms) {
      const cursor = state.roomCursors[room._id] || lookback;
      if (toISO(room.lm) <= cursor) continue;
      const sub = subs.get(room._id);
      room.name = room.name || sub.name;
      room.displayName = room.t === 'd' ? sub.fname || sub.name : room.fname || room.name;

      const messages = await fetchSince(room, cursor);
      for (const msg of messages) handleMessage(msg, room, sub, fresh);
      if (messages.length) state.roomCursors[room._id] = toISO(messages.at(-1).ts);
      await sleep(150); // stay well under REST rate limits
    }

    wakeSnoozed(fresh);
    state.lastPoll = startedAt;
    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error('Poll failed:', err.message);
  } finally {
    polling = false;
    save();
    broadcast('state', publicState());
    const alerts = fresh.filter((c) => c.priority === 'high' || c.woke);
    if (alerts.length) broadcast('alert', alerts.map(({ id, title, roomName, sender, type, woke }) => ({ id, title, roomName, sender, type, woke })));
  }
}

async function fetchSince(room, oldest) {
  // History comes newest-first; page backwards with `latest` until we reach `oldest`.
  const out = [];
  let latest;
  for (let page = 0; page < 10; page++) {
    const { messages = [] } = await rc.history(room, oldest, latest);
    out.push(...messages);
    if (messages.length < 100) break;
    latest = toISO(messages.at(-1).ts);
  }
  const seen = new Set();
  return out
    .filter((m) => !seen.has(m._id) && seen.add(m._id))
    .sort((a, b) => toISO(a.ts).localeCompare(toISO(b.ts)));
}

function handleMessage(msg, room, sub, fresh) {
  const me = state.me;
  const ts = toISO(msg.ts);

  // My own reply → mark matching open cards as replied (and auto-close simple ones).
  if (msg.u?._id === me._id) {
    for (const card of state.cards) {
      if (card.roomId !== room._id || card.status === 'done' || card.lastTs >= ts) continue;
      const sameThread = msg.tmid
        ? card.tmid === msg.tmid || card.msgIds.includes(msg.tmid)
        : !card.tmid;
      if (!sameThread) continue;
      card.replied = true;
      if (card.status === 'inbox' && (card.type === 'fyi' || card.type === 'question')) {
        card.status = 'done';
        card.autoClosed = true;
      }
      card.updatedAt = new Date().toISOString();
    }
    return;
  }

  if (state.cards.some((c) => c.msgIds.includes(msg._id))) return;
  const result = classify(msg, {
    me,
    room,
    sub,
    watchKeywords: cfg.watchKeywords,
    mutedRooms: cfg.mutedRooms,
  });
  if (!result) return;
  if (!cfg.groupMentions && result.reasons.length === 1 && result.reasons[0] === 'group') return;

  const entry = { id: msg._id, text: msg.msg, ts, link: rc.messageLink(room, msg._id) };

  // Group bursts: same sender, same room/thread, still in Inbox, within 30 min.
  const existing = state.cards.find(
    (c) =>
      c.status === 'inbox' &&
      c.roomId === room._id &&
      (c.tmid || null) === (msg.tmid || null) &&
      c.sender.username === msg.u.username &&
      Date.parse(ts) - Date.parse(c.lastTs) < GROUP_WINDOW_MS
  );
  if (existing) {
    existing.messages.push(entry);
    existing.msgIds.push(msg._id);
    existing.lastTs = ts;
    existing.reasons = [...new Set([...existing.reasons, ...result.reasons])];
    existing.urgent ||= result.urgent;
    if (PRIORITY_RANK[result.priority] > PRIORITY_RANK[existing.priority]) existing.priority = result.priority;
    if (existing.type === 'fyi' || existing.type === 'question') existing.type = result.type;
    existing.updatedAt = new Date().toISOString();
    if (result.priority === 'high') fresh.push(existing);
    return;
  }

  const card = {
    id: `rc_${msg._id}`,
    source: 'rocketchat',
    msgIds: [msg._id],
    roomId: room._id,
    roomName: room.displayName,
    roomType: room.t,
    tmid: msg.tmid || null,
    sender: { username: msg.u.username, name: msg.u.name || msg.u.username },
    title: makeTitle(msg.msg),
    messages: [entry],
    link: entry.link,
    ...result,
    status: 'inbox',
    replied: false,
    snoozedUntil: null,
    notes: '',
    createdAt: ts,
    lastTs: ts,
    updatedAt: new Date().toISOString(),
  };
  state.cards.push(card);
  fresh.push(card);
}

function wakeSnoozed(fresh) {
  const now = new Date().toISOString();
  for (const card of state.cards) {
    if (card.snoozedUntil && card.snoozedUntil <= now) {
      card.snoozedUntil = null;
      card.status = card.status === 'done' ? 'done' : 'inbox';
      card.woke = true;
      fresh.push(card);
    }
  }
}

function publicState() {
  return {
    me: state.me,
    cards: state.cards,
    lastPoll: state.lastPoll,
    polling,
    error: lastError,
    rcUrl: rc.url,
    pollSeconds: cfg.pollSeconds,
  };
}

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const EDITABLE = ['status', 'priority', 'type', 'notes', 'title', 'snoozedUntil', 'due'];
const STATUSES = ['inbox', 'todo', 'doing', 'waiting', 'done'];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Basic auth when hosted publicly: any username, password = BOARD_PASSWORD.
function authorized(req) {
  if (!cfg.password) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(cfg.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Chat Tracker"' });
    return res.end('Password required');
  }
  const url = new URL(req.url, 'http://localhost');
  const [, api, resource, id] = url.pathname.split('/');

  try {
    if (api === 'api') {
      if (resource === 'state' && req.method === 'GET') return json(res, 200, publicState());

      if (resource === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (resource === 'poll' && req.method === 'POST') {
        poll();
        return json(res, 202, { ok: true });
      }

      if (resource === 'cards') {
        if (req.method === 'POST' && !id) {
          const body = await readBody(req);
          if (!body.title) return json(res, 400, { error: 'title required' });
          const now = new Date().toISOString();
          const card = {
            id: `manual_${Date.now().toString(36)}`,
            source: 'manual',
            msgIds: [],
            messages: [],
            title: String(body.title).slice(0, 200),
            notes: String(body.notes || ''),
            type: body.type || 'task',
            priority: body.priority || 'medium',
            reasons: ['manual'],
            status: STATUSES.includes(body.status) ? body.status : 'todo',
            sender: { username: state.me?.username || 'me', name: 'Me' },
            roomName: '',
            createdAt: now,
            lastTs: now,
            updatedAt: now,
          };
          state.cards.push(card);
          save();
          broadcast('state', publicState());
          return json(res, 201, card);
        }

        const card = state.cards.find((c) => c.id === id);
        if (!card) return json(res, 404, { error: 'not found' });

        if (req.method === 'PATCH') {
          const body = await readBody(req);
          for (const k of EDITABLE) if (k in body) card[k] = body[k];
          if (!STATUSES.includes(card.status)) card.status = 'inbox';
          card.woke = false;
          card.updatedAt = new Date().toISOString();
          save();
          broadcast('state', publicState());
          return json(res, 200, card);
        }
        if (req.method === 'DELETE') {
          state.cards = state.cards.filter((c) => c.id !== id);
          save();
          broadcast('state', publicState());
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'unknown endpoint' });
    }

    // static files
    const file = path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(path.join(ROOT, 'public'))) return json(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

// keep SSE connections alive through proxies
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

server.listen(cfg.port, cfg.host, () => {
  console.log(`Rocket.Chat Tracker → http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  console.log(`Polling ${rc.url} every ${cfg.pollSeconds}s`);
  poll();
  setInterval(poll, cfg.pollSeconds * 1000);
});
