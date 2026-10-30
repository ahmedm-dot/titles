// Standalone job-title suggestion service.
//   GET /api/suggest?q=&locale=&arm=&n=          → JSON {items, first_ms, total_ms, cached}
//   GET /api/suggest/stream?q=&locale=&arm=&n=   → SSE: `item` per suggestion, then `done`
//   GET /api/arms                                → available A/B arms + default
//   GET /                                        → test page
import './env.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ARMS, DEFAULT_ARM } from './arms.mjs';
import { suggestAI } from './ai.mjs';
import { norm } from './normalize.mjs';

if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set (env var or service/.env)'); process.exit(1); }

const PORT = +process.env.PORT || 8787;
const MIN_CHARS = 2;
const INDEX = readFileSync(new URL('../public/index.html', import.meta.url));

// LRU cache: typeahead traffic is extremely repetitive ("soft", "softw", ...) across users.
const CACHE_MAX = 5000, cache = new Map();
const cacheGet = k => { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; };
const cacheSet = (k, v) => { cache.set(k, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

function parse(url) {
  const q = (url.searchParams.get('q') || '').slice(0, 80).trim();
  const locale = (url.searchParams.get('locale') || '').slice(0, 10);
  const armId = ARMS[url.searchParams.get('arm')] ? url.searchParams.get('arm') : DEFAULT_ARM;
  const n = Math.min(10, Math.max(1, +url.searchParams.get('n') || 6));
  return { q, locale, armId, arm: ARMS[armId], n, key: `${armId}|${locale}|${n}|${norm(q)}` };
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(INDEX); }
    if (url.pathname === '/api/arms') return json(res, 200, { default: DEFAULT_ARM, arms: ARMS });

    if (url.pathname === '/api/suggest') {
      const p = parse(url);
      if (p.q.length < MIN_CHARS) return json(res, 200, { items: [], arm: p.armId });
      const hit = cacheGet(p.key);
      if (hit) return json(res, 200, { ...hit, arm: p.armId, cached: true, first_ms: 0, total_ms: 0 });
      const ac = new AbortController(); res.on('close', () => ac.abort());
      const r = await suggestAI({ ...p, signal: ac.signal });
      cacheSet(p.key, { items: r.items });
      return json(res, 200, { ...r, arm: p.armId, cached: false });
    }

    if (url.pathname === '/api/suggest/stream') {
      const p = parse(url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      if (p.q.length < MIN_CHARS) { send('done', { items: [] }); return res.end(); }
      const hit = cacheGet(p.key);
      if (hit) { hit.items.forEach(t => send('item', t)); send('done', { ...hit, arm: p.armId, cached: true, first_ms: 0, total_ms: 0 }); return res.end(); }
      const ac = new AbortController(); res.on('close', () => ac.abort()); // user kept typing → cancel upstream call
      const r = await suggestAI({ ...p, signal: ac.signal, onItem: t => send('item', t) });
      cacheSet(p.key, { items: r.items });
      send('done', { ...r, arm: p.armId, cached: false });
      return res.end();
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e.message);
    if (!res.headersSent) json(res, 502, { error: e.message });
    else { res.write(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`); res.end(); }
  }
}).listen(PORT, () => console.log(`job-title-suggest on http://localhost:${PORT}  (default arm: ${DEFAULT_ARM})`));
