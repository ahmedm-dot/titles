// Chat Tracker — local / self-hosted Node server.
// Polls Rocket.Chat on a timer and serves the board. Zero dependencies (Node 20.12+).
// For hosting on Cloudflare, see worker.js and wrangler.toml instead.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readConfig, missingConfig, emptyState, pollOnce, prune, rebuild, applyPatch, manualCard, publicState, checkBasicAuth,
} from './lib/tracker.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* .env is optional when vars come from the shell */
}

const cfg = readConfig(process.env);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

const missing = missingConfig(cfg);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && cfg.password.length < 8) {
  console.error('Refusing to listen on a public address without BOARD_PASSWORD (8+ characters).');
  process.exit(1);
}

// ---------- persistence (single JSON file) ----------
const DATA_FILE = path.join(ROOT, 'data', 'state.json');
let state;
try {
  state = { ...emptyState(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch {
  state = emptyState();
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(`${DATA_FILE}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${DATA_FILE}.tmp`, DATA_FILE);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const hadMe = !!state.me;
    await pollOnce(state, cfg);
    prune(state);
    if (!hadMe && state.me) console.log(`Signed in as @${state.me.username}`);
    if (state.error) console.error('Sync failed:', state.error);
    save();
  } finally {
    polling = false;
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (!checkBasicAuth(req.headers.authorization, cfg.password)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Chat Tracker"' });
    return res.end('Password required');
  }
  const url = new URL(req.url, 'http://localhost');
  const [, api, resource, id] = url.pathname.split('/');

  try {
    if (api === 'api') {
      if (resource === 'state' && req.method === 'GET') return json(res, 200, publicState(state, cfg));

      if (resource === 'poll' && req.method === 'POST') {
        await poll();
        return json(res, 200, publicState(state, cfg));
      }

      if (resource === 'rebuild' && req.method === 'POST') {
        rebuild(state);
        await poll();
        return json(res, 200, publicState(state, cfg));
      }
      if (resource === 'bulk' && req.method === 'POST') {
        const { ids = [], status } = await readBody(req);
        const cards = state.cards.filter((c) => ids.includes(c.id));
        cards.forEach((c) => applyPatch(c, { status }));
        save();
        return json(res, 200, { updated: cards.length });
      }
      if (resource === 'cards') {
        if (req.method === 'POST' && !id) {
          const body = await readBody(req);
          if (!body.title) return json(res, 400, { error: 'title required' });
          const card = manualCard(body, state.me);
          state.cards.push(card);
          save();
          return json(res, 201, card);
        }
        const card = state.cards.find((c) => c.id === id);
        if (!card) return json(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          applyPatch(card, await readBody(req));
          save();
          return json(res, 200, card);
        }
        if (req.method === 'DELETE') {
          state.cards = state.cards.filter((c) => c.id !== id);
          save();
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'unknown endpoint' });
    }

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

server.listen(port, host, () => {
  console.log(`Chat Tracker → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Polling ${cfg.url} every ${cfg.pollSeconds}s`);
  poll();
  setInterval(poll, cfg.pollSeconds * 1000);
});
