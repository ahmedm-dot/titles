// Chat Tracker — Cloudflare Worker.
// A Cron Trigger syncs Rocket.Chat every minute (even with the page closed),
// D1 keeps the cards, and the board in public/ is served as static assets.

import {
  readConfig, missingConfig, emptyState, pollOnce, prune, rebuild, applyPatch, manualCard, publicState, checkBasicAuth,
} from './lib/tracker.js';
import { summarizeCards } from './lib/summarize.js';

const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];
const META_KEYS = ['me', 'roomCursors', 'pendingRooms', 'lastPoll', 'error', 'aiError'];

async function ensureSchema(db) {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

async function loadState(db) {
  await ensureSchema(db);
  const [cards, meta] = await db.batch([
    db.prepare('SELECT data FROM cards'),
    db.prepare('SELECT key, value FROM meta'),
  ]);
  const state = emptyState();
  state.cards = cards.results.map((r) => JSON.parse(r.data));
  for (const { key, value } of meta.results) state[key] = JSON.parse(value);
  return state;
}

const putCard = (db, card) =>
  db.prepare('INSERT INTO cards (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?2').bind(card.id, JSON.stringify(card));

async function saveSync(db, state, changedIds, removedIds) {
  const stmts = [
    ...META_KEYS.map((k) =>
      db.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2').bind(k, JSON.stringify(state[k] ?? null))
    ),
    ...state.cards.filter((c) => changedIds.has(c.id)).map((c) => putCard(db, c)),
    ...removedIds.map((id) => db.prepare('DELETE FROM cards WHERE id = ?1').bind(id)),
  ];
  await db.batch(stmts);
}

async function sync(env, { fresh = false, wipe = false, resummarize = false, aiMax = 6 } = {}) {
  const cfg = readConfig(env);
  if (wipe) {
    await ensureSchema(env.DB);
    await env.DB.batch([env.DB.prepare('DELETE FROM cards'), env.DB.prepare('DELETE FROM meta')]);
  }
  const state = await loadState(env.DB);
  if (fresh) {
    const gone = rebuild(state);
    if (gone.length) await env.DB.batch(gone.map((id) => env.DB.prepare('DELETE FROM cards WHERE id = ?1').bind(id)));
  }
  const changed = await pollOnce(state, cfg);
  if (resummarize) {
    for (const c of state.cards) {
      if (c.source === 'rocketchat' && c.status !== 'done') {
        c.needsSummary = true;
        c.summaryTries = 0;
      }
    }
  }
  if (env.AI && state.me) {
    const run = async (messages) => (await env.AI.run(AI_MODEL, { messages, max_tokens: 350 }))?.response;
    for (const id of await summarizeCards(state, run, aiMax)) changed.add(id);
  }
  const removed = prune(state);
  await saveSync(env.DB, state, changed, removed);
  return { state, cfg };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async scheduled(_event, env, ctx) {
    if (missingConfig(readConfig(env)).length) return;
    ctx.waitUntil(sync(env));
  },

  async fetch(request, env) {
    const cfg = readConfig(env);
    if (cfg.password.length < 8) {
      return new Response('Set the BOARD_PASSWORD secret (8+ characters): npx wrangler secret put BOARD_PASSWORD', { status: 503 });
    }
    if (!checkBasicAuth(request.headers.get('Authorization'), cfg.password)) {
      return new Response('Password required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Chat Tracker"' } });
    }
    const missing = missingConfig(cfg);
    const url = new URL(request.url);
    const [, api, resource, id] = url.pathname.split('/');
    if (api !== 'api') return env.ASSETS.fetch(request);
    if (missing.length) return json({ error: `Missing secrets: ${missing.join(', ')}` }, 500);

    try {
      if (resource === 'state' && request.method === 'GET') {
        return json(publicState(await loadState(env.DB), cfg));
      }
      if (resource === 'poll' && request.method === 'POST') {
        const { state } = await sync(env);
        return json(publicState(state, cfg));
      }
      if (resource === 'rebuild' && request.method === 'POST') {
        const { state } = await sync(env, { fresh: true, aiMax: 15 });
        return json(publicState(state, cfg));
      }
      // Re-runs the AI on every open card (titles, asks and automatic status), keeping your cards.
      if (resource === 'resummarize' && request.method === 'POST') {
        const { state } = await sync(env, { resummarize: true, aiMax: 20 });
        return json(publicState(state, cfg));
      }
      // Deletes every card (including your own and your notes) and starts over.
      if (resource === 'reset' && request.method === 'POST') {
        const { state } = await sync(env, { wipe: true, aiMax: 15 });
        return json(publicState(state, cfg));
      }
      if (resource === 'bulk' && request.method === 'POST') {
        const { ids = [], status } = await request.json();
        const rows = ids.length
          ? await env.DB.batch(ids.slice(0, 500).map((cid) => env.DB.prepare('SELECT data FROM cards WHERE id = ?1').bind(cid)))
          : [];
        const cards = rows.flatMap((r) => r.results).map((r) => applyPatch(JSON.parse(r.data), { status }));
        if (cards.length) await env.DB.batch(cards.map((c) => putCard(env.DB, c)));
        return json({ updated: cards.length });
      }
      if (resource === 'cards') {
        await ensureSchema(env.DB);
        if (request.method === 'POST' && !id) {
          const body = await request.json();
          if (!body.title) return json({ error: 'title required' }, 400);
          const meRow = await env.DB.prepare("SELECT value FROM meta WHERE key = 'me'").first();
          const card = manualCard(body, meRow ? JSON.parse(meRow.value) : null);
          await putCard(env.DB, card).run();
          return json(card, 201);
        }
        const row = await env.DB.prepare('SELECT data FROM cards WHERE id = ?1').bind(id).first();
        if (!row) return json({ error: 'not found' }, 404);
        if (request.method === 'PATCH') {
          const card = applyPatch(JSON.parse(row.data), await request.json());
          await putCard(env.DB, card).run();
          return json(card);
        }
        if (request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM cards WHERE id = ?1').bind(id).run();
          return json({ ok: true });
        }
      }
      return json({ error: 'unknown endpoint' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
