// Core tracker logic shared by the Node server (server.js) and the Cloudflare Worker (worker.js).
// Works on a plain `state` object: { me, cards, roomCursors, pendingRooms, lastPoll, error }.
// No Node or Cloudflare APIs in here.

import { RocketChat } from './rocketchat.js';
import { classify, makeTitle } from './classify.js';

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
const GROUP_WINDOW_MS = 30 * 60 * 1000;
const DONE_RETENTION_DAYS = 30;
export const STATUSES = ['inbox', 'todo', 'doing', 'waiting', 'done'];
const EDITABLE = ['status', 'priority', 'type', 'notes', 'title', 'snoozedUntil'];

const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const toISO = (d) => (d?.$date ? new Date(d.$date) : new Date(d)).toISOString();

export function readConfig(env) {
  return {
    url: env.RC_URL,
    userId: env.RC_USER_ID,
    token: env.RC_TOKEN,
    password: env.BOARD_PASSWORD || '',
    pollSeconds: Math.max(Number(env.POLL_SECONDS || 60), 15),
    lookbackHours: Number(env.LOOKBACK_HOURS || 48),
    watchKeywords: list(env.WATCH_KEYWORDS),
    mutedRooms: list(env.MUTED_ROOMS).map((r) => r.replace(/^#/, '')),
    groupMentions: env.INCLUDE_GROUP_MENTIONS !== 'false',
    // Cloudflare's free plan allows 50 outbound requests per run; leftovers carry to the next run.
    maxRoomsPerPoll: Number(env.MAX_ROOMS_PER_POLL || Infinity),
    maxPagesPerRoom: Number(env.MAX_PAGES_PER_ROOM || 10),
  };
}

export function missingConfig(cfg) {
  return [['url', 'RC_URL'], ['userId', 'RC_USER_ID'], ['token', 'RC_TOKEN']]
    .filter(([k]) => !cfg[k])
    .map(([, name]) => name);
}

export function emptyState() {
  return { me: null, cards: [], roomCursors: {}, pendingRooms: [], lastPoll: null, error: null };
}

/**
 * One sync pass. Mutates `state`; returns the ids of cards that were created or changed.
 */
export async function pollOnce(state, cfg) {
  const rc = new RocketChat(cfg);
  const changed = new Set();
  const startedAt = new Date().toISOString();
  state.pendingRooms ||= [];
  try {
    if (!state.me) {
      const me = await rc.me();
      state.me = { _id: me._id, username: me.username, name: me.name };
    }
    const lookback = new Date(Date.now() - cfg.lookbackHours * 3600e3).toISOString();

    const [subsRes, roomsRes] = await Promise.all([
      rc.subscriptions(),
      rc.rooms(state.lastPoll || undefined),
    ]);
    const subs = new Map((subsRes.update || []).map((s) => [s.rid, s]));

    // Rooms with new messages since the last pass, plus any left over from a capped pass.
    const queue = new Map(state.pendingRooms.map((r) => [r._id, r]));
    for (const r of roomsRes.update || []) {
      if (subs.has(r._id) && r.lm) queue.set(r._id, { _id: r._id, t: r.t, name: r.name, fname: r.fname, lm: toISO(r.lm) });
    }
    const due = [...queue.values()].filter((r) => r.lm > (state.roomCursors[r._id] || lookback));
    const now = due.slice(0, cfg.maxRoomsPerPoll);
    state.pendingRooms = due.slice(cfg.maxRoomsPerPoll);

    for (const room of now) {
      const sub = subs.get(room._id);
      if (!sub) continue;
      room.name = room.name || sub.name;
      room.displayName = room.t === 'd' ? sub.fname || sub.name : room.fname || room.name;
      const cursor = state.roomCursors[room._id] || lookback;
      const messages = await fetchSince(rc, room, cursor, cfg.maxPagesPerRoom);
      for (const msg of messages) handleMessage(state, cfg, rc, msg, room, sub, changed);
      state.roomCursors[room._id] = messages.length ? toISO(messages.at(-1).ts) : room.lm;
    }

    wakeSnoozed(state, changed);
    state.lastPoll = startedAt;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  return changed;
}

async function fetchSince(rc, room, oldest, maxPages) {
  // History comes newest-first; page backwards with `latest` until we reach `oldest`.
  const out = [];
  let latest;
  for (let page = 0; page < maxPages; page++) {
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

function handleMessage(state, cfg, rc, msg, room, sub, changed) {
  const me = state.me;
  const ts = toISO(msg.ts);
  const nowIso = new Date().toISOString();

  // My own reply → mark matching open cards as replied (and auto-close simple ones).
  if (msg.u?._id === me._id) {
    for (const card of state.cards) {
      if (card.roomId !== room._id || card.status === 'done' || card.lastTs >= ts) continue;
      const sameThread = msg.tmid ? card.tmid === msg.tmid || card.msgIds.includes(msg.tmid) : !card.tmid;
      if (!sameThread) continue;
      card.replied = true;
      if (card.status === 'inbox' && (card.type === 'fyi' || card.type === 'question')) {
        card.status = 'done';
        card.autoClosed = true;
      }
      card.updatedAt = nowIso;
      changed.add(card.id);
    }
    return;
  }

  if (state.cards.some((c) => c.msgIds?.includes(msg._id))) return;
  const result = classify(msg, { me, room, sub, watchKeywords: cfg.watchKeywords, mutedRooms: cfg.mutedRooms });
  if (!result) return;
  if (!cfg.groupMentions && result.reasons.every((r) => r === 'group')) return;

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
    existing.updatedAt = nowIso;
    changed.add(existing.id);
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
    updatedAt: nowIso,
  };
  state.cards.push(card);
  changed.add(card.id);
}

function wakeSnoozed(state, changed) {
  const now = new Date().toISOString();
  for (const card of state.cards) {
    if (card.snoozedUntil && card.snoozedUntil <= now) {
      card.snoozedUntil = null;
      if (card.status !== 'done') card.status = 'inbox';
      card.wokeAt = now;
      changed.add(card.id);
    }
  }
}

/** Done cards older than 30 days are dropped. Returns removed ids. */
export function prune(state) {
  const cutoff = new Date(Date.now() - DONE_RETENTION_DAYS * 864e5).toISOString();
  const removed = state.cards.filter((c) => c.status === 'done' && c.updatedAt < cutoff).map((c) => c.id);
  if (removed.length) state.cards = state.cards.filter((c) => !removed.includes(c.id));
  return removed;
}

export function applyPatch(card, body) {
  for (const k of EDITABLE) if (k in body) card[k] = body[k];
  if (!STATUSES.includes(card.status)) card.status = 'inbox';
  card.updatedAt = new Date().toISOString();
  return card;
}

export function manualCard(body, me) {
  const now = new Date().toISOString();
  return {
    id: `manual_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    source: 'manual',
    msgIds: [],
    messages: [],
    title: String(body.title).slice(0, 200),
    notes: String(body.notes || ''),
    type: body.type || 'task',
    priority: body.priority || 'medium',
    reasons: ['manual'],
    status: STATUSES.includes(body.status) ? body.status : 'todo',
    sender: { username: me?.username || 'me', name: 'Me' },
    roomName: '',
    createdAt: now,
    lastTs: now,
    updatedAt: now,
  };
}

export function publicState(state, cfg, extra = {}) {
  return {
    me: state.me,
    cards: state.cards,
    lastPoll: state.lastPoll,
    error: state.error,
    pending: (state.pendingRooms || []).length,
    rcUrl: cfg.url.replace(/\/+$/, ''),
    pollSeconds: cfg.pollSeconds,
    ...extra,
  };
}

/** Constant-time HTTP Basic auth check (any username, password = BOARD_PASSWORD). */
export function checkBasicAuth(header, password) {
  if (!password) return true;
  const [scheme, value] = (header || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  let given;
  try {
    given = atob(value).split(':').slice(1).join(':');
  } catch {
    return false;
  }
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(password);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}
