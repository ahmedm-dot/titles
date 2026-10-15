// Core tracker logic shared by the Node server (server.js) and the Cloudflare Worker (worker.js).
// Works on a plain `state` object: { me, cards, roomCursors, pendingRooms, gaps, lastPoll, error }.
// No Node or Cloudflare APIs in here.

import { RocketChat } from './rocketchat.js';
import { classify, makeTitle } from './classify.js';

const PRIORITY_RANK = { low: 0, medium: 1, high: 2 };
// A DM or channel conversation ends after this much silence; a thread never does.
const SESSION_GAP_MS = { d: 8 * 3600e3, c: 2 * 3600e3 };
const MAX_MESSAGES_PER_CARD = 40;
const CONTEXT_BEFORE = 3; // earlier messages attached when a channel/DM card starts…
const CONTEXT_WINDOW_MS = 30 * 60 * 1000; // …if they were sent within this window
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
    lookbackHours: Number(env.LOOKBACK_HOURS || 24),
    watchKeywords: list(env.WATCH_KEYWORDS),
    mutedRooms: list(env.MUTED_ROOMS).map((r) => r.replace(/^#/, '')),
    groupMentions: env.INCLUDE_GROUP_MENTIONS === 'true',
    // Cloudflare's free plan allows 50 outbound requests per run; whatever doesn't fit
    // carries over to the next run, so nothing is skipped.
    maxRoomsPerPoll: Number(env.MAX_ROOMS_PER_POLL || Infinity),
    maxPagesPerRoom: Number(env.MAX_PAGES_PER_ROOM || 10),
    maxRequests: Number(env.MAX_REQUESTS_PER_POLL || Infinity),
  };
}

export function missingConfig(cfg) {
  return [['url', 'RC_URL'], ['userId', 'RC_USER_ID'], ['token', 'RC_TOKEN']]
    .filter(([k]) => !cfg[k])
    .map(([, name]) => name);
}

export function emptyState() {
  return { me: null, cards: [], roomCursors: {}, pendingRooms: [], gaps: [], lastPoll: null, error: null };
}

/**
 * One sync pass. Mutates `state`; returns the ids of cards that were created or changed.
 *
 * Each room has a cursor (the last message read). When a room has more new messages than
 * one run can read, the newest ones are read now and the unread stretch in between is
 * kept as a "gap" that later runs fill in, so no message is ever skipped.
 */
export async function pollOnce(state, cfg) {
  const rc = new RocketChat(cfg);
  const budgetLeft = () => cfg.maxRequests - rc.calls;
  const changed = new Set();
  const startedAt = new Date().toISOString();
  state.pendingRooms ||= [];
  state.gaps ||= [];
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
    state.pendingRooms = [];
    let roomsRead = 0;
    const hasRoom = () => roomsRead < cfg.maxRoomsPerPoll && budgetLeft() >= 2;

    const readAll = async (messages, room, sub) => {
      for (let i = 0; i < messages.length; i++) {
        await handleMessage(state, cfg, rc, messages[i], messages.slice(Math.max(0, i - CONTEXT_BEFORE), i), room, sub, changed, budgetLeft);
      }
    };

    // 1. New messages, newest first.
    for (const room of due) {
      const sub = subs.get(room._id);
      if (!sub) continue;
      if (!hasRoom()) {
        state.pendingRooms.push(room);
        continue;
      }
      roomsRead++;
      prepareRoom(room, sub);
      const cursor = state.roomCursors[room._id] || lookback;
      const { messages, complete, oldestRead } = await fetchBetween(rc, room, cursor, undefined, cfg.maxPagesPerRoom, budgetLeft);
      await readAll(messages, room, sub);
      if (!complete) state.gaps.push({ rid: room._id, from: cursor, to: oldestRead, room: minimalRoom(room) });
      state.roomCursors[room._id] = messages.length ? toISO(messages.at(-1).ts) : room.lm;
    }

    // 2. Fill in unread stretches left by earlier busy runs, with whatever budget is left.
    for (const gap of [...state.gaps]) {
      if (!hasRoom()) break;
      const sub = subs.get(gap.rid);
      if (!sub) {
        state.gaps = state.gaps.filter((g) => g !== gap);
        continue;
      }
      roomsRead++;
      const room = prepareRoom({ ...gap.room }, sub);
      const { messages, complete, oldestRead } = await fetchBetween(rc, room, gap.from, gap.to, cfg.maxPagesPerRoom, budgetLeft);
      await readAll(messages, room, sub);
      if (complete) state.gaps = state.gaps.filter((g) => g !== gap);
      else gap.to = oldestRead;
    }

    wakeSnoozed(state, changed);
    state.lastPoll = startedAt;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  return changed;
}

function prepareRoom(room, sub) {
  room.name = room.name || sub.name;
  room.displayName = room.t === 'd' ? sub.fname || sub.name : room.fname || room.name;
  return room;
}

const minimalRoom = (r) => ({ _id: r._id, t: r.t, name: r.name, fname: r.fname });

/**
 * Messages after `oldest` (and before `latest`, if given), oldest first. History comes
 * newest-first, so it pages backwards; `complete` is false when it stopped before reaching
 * `oldest`, and `oldestRead` is where to continue next time.
 */
async function fetchBetween(rc, room, oldest, latest, maxPages, budgetLeft) {
  const out = [];
  let complete = false;
  for (let page = 0; page < maxPages && budgetLeft() > 0; page++) {
    const { messages = [] } = await rc.history(room, oldest, latest);
    out.push(...messages);
    if (messages.length < 100) {
      complete = true;
      break;
    }
    latest = toISO(messages.at(-1).ts);
  }
  const seen = new Set();
  const sorted = out
    .filter((m) => !seen.has(m._id) && seen.add(m._id))
    .sort((a, b) => toISO(a.ts).localeCompare(toISO(b.ts)));
  return { messages: sorted, complete, oldestRead: sorted.length ? toISO(sorted[0].ts) : latest };
}

// ---------- conversation cards ----------
// A card is one conversation: a thread, a DM session, or a channel discussion that
// involves you. Every message in it is kept for context; asks raise its priority.

function conversationKey(msg, room) {
  if (msg.tmid) return `t:${msg.tmid}`;
  return `${room.t === 'd' ? 'd' : 'c'}:${room._id}`;
}

function findConversation(state, msg, room, ts) {
  const key = conversationKey(msg, room);
  const gap = msg.tmid ? Infinity : SESSION_GAP_MS[room.t === 'd' ? 'd' : 'c'];
  let best = null;
  for (const c of state.cards) {
    if (c.source !== 'rocketchat' || c.roomId !== room._id) continue;
    const sameKey = c.key === key || (msg.tmid && c.msgIds.includes(msg.tmid));
    if (!sameKey || Date.parse(ts) - Date.parse(c.lastTs) > gap || Date.parse(c.createdAt) - Date.parse(ts) > gap) continue;
    if (!best || c.lastTs > best.lastTs) best = c;
  }
  return best;
}

function entryFor(rc, room, msg, me, trigger) {
  return {
    id: msg._id,
    text: msg.msg,
    ts: toISO(msg.ts),
    who: msg.u?.name || msg.u?.username || '?',
    mine: msg.u?._id === me._id,
    trigger: !!trigger,
    link: rc.messageLink(room, msg._id),
  };
}

function append(card, entry) {
  if (card.msgIds.includes(entry.id)) return false;
  card.messages.push(entry);
  card.msgIds.push(entry.id);
  // Backfilled (older) messages can arrive after newer ones; keep the conversation in order.
  if (card.messages.length > 1 && entry.ts < card.messages.at(-2).ts) card.messages.sort((a, b) => a.ts.localeCompare(b.ts));
  if (card.messages.length > MAX_MESSAGES_PER_CARD) card.messages = card.messages.slice(-MAX_MESSAGES_PER_CARD);
  if (entry.ts > card.lastTs) card.lastTs = entry.ts;
  if (entry.ts < card.createdAt) card.createdAt = entry.ts;
  if (!entry.mine && !card.participants.includes(entry.who)) card.participants.push(entry.who);
  card.needsSummary = true;
  card.summaryTries = 0;
  return true;
}

async function handleMessage(state, cfg, rc, msg, before, room, sub, changed, budgetLeft = () => Infinity) {
  if (!msg.msg || msg.t) return; // system messages
  const me = state.me;
  const ts = toISO(msg.ts);
  const nowIso = new Date().toISOString();
  const mine = msg.u?._id === me._id;
  let card = findConversation(state, msg, room, ts);

  if (mine) {
    if (!card) return;
    // In a channel, your top-level message only belongs here if it answers someone in it.
    const answers = room.t === 'd' || msg.tmid || (msg.mentions || []).some((m) => card.senders?.includes(m.username));
    if (!answers) return;
    const latest = ts >= card.lastTs; // an older, backfilled reply doesn't answer newer asks
    if (!append(card, entryFor(rc, room, msg, me, false))) return;
    if (latest) {
      card.replied = true;
      card.waitingOnThem = true;
      if (card.status === 'inbox') {
        // Real work you acknowledged moves to To do; everything else is handled.
        const work = ['task', 'requirement', 'bug'].includes(card.type) && card.priority === 'high';
        autoMove(card, work ? 'todo' : 'done', 'you replied');
      }
      card.reopened = false;
      card.newActivity = false;
    }
    card.updatedAt = nowIso;
    changed.add(card.id);
    return;
  }

  const result = classify(msg, { me, room, sub, watchKeywords: cfg.watchKeywords, mutedRooms: cfg.mutedRooms });
  const relevant = result && !(!cfg.groupMentions && result.reasons.every((r) => r === 'group'));

  if (card) {
    // Threads and DMs keep every message; a busy channel only adds asks or people already in it.
    const keep = msg.tmid || room.t === 'd' || relevant || card.senders?.includes(msg.u.username);
    const latest = ts >= card.lastTs;
    if (!keep || !append(card, entryFor(rc, room, msg, me, relevant))) return;
    card.senders = [...new Set([...(card.senders || []), msg.u.username])];
    if (relevant) mergeResult(card, result);
    if (relevant && latest) {
      card.waitingOnThem = false;
      if (card.status === 'done') {
        autoMove(card, 'inbox', 'new ask');
        card.reopened = true;
      } else if (card.status !== 'inbox') {
        card.newActivity = true;
      }
    }
    card.updatedAt = nowIso;
    changed.add(card.id);
    return;
  }

  if (!relevant) return;

  // New conversation. A thread is titled by its first message.
  let title = msg.msg;
  let root = null;
  if (msg.tmid && budgetLeft() > 0) {
    root = await rc.message(msg.tmid).catch(() => null);
    if (root?.msg) title = root.msg;
  }
  card = {
    id: `rc_${msg._id}`,
    source: 'rocketchat',
    key: conversationKey(msg, room),
    msgIds: msg.tmid ? [msg.tmid] : [],
    roomId: room._id,
    roomName: room.displayName,
    roomType: room.t,
    tmid: msg.tmid || null,
    sender: { username: msg.u.username, name: msg.u.name || msg.u.username },
    senders: [msg.u.username],
    participants: [],
    title: makeTitle(title),
    summary: '',
    messages: [],
    link: rc.messageLink(room, msg.tmid || msg._id),
    reasons: [],
    type: 'fyi',
    priority: 'low',
    urgent: false,
    status: 'inbox',
    replied: false,
    snoozedUntil: null,
    notes: '',
    createdAt: ts,
    lastTs: ts,
    updatedAt: nowIso,
  };
  // A little lead-in so the card makes sense on its own (same thread only, for threads).
  if (root?.msg) {
    card.msgIds = [];
    append(card, entryFor(rc, room, root, me, false));
  }
  for (const prev of before) {
    if (!prev.msg || prev.t || (prev.tmid || null) !== (msg.tmid || null)) continue;
    if (Date.parse(ts) - Date.parse(toISO(prev.ts)) > CONTEXT_WINDOW_MS) continue;
    append(card, entryFor(rc, room, prev, me, false));
  }
  append(card, entryFor(rc, room, msg, me, true));
  mergeResult(card, result);
  state.cards.push(card);
  changed.add(card.id);
}

function autoMove(card, status, reason) {
  if (card.status === status) return false;
  card.status = status;
  card.autoReason = reason;
  card.autoAt = new Date().toISOString();
  return true;
}

/**
 * Moves a card to match the AI's reading of the conversation:
 *   resolved        → Done (from any column)
 *   waiting_on_them → Waiting on others (from Inbox or To do)
 *   needs_me        → Inbox (from Waiting or Done), unless your message is the latest
 * A move you made by hand wins until someone writes in the conversation again.
 * Returns true if the card moved.
 */
export function applyAiState(card, aiState) {
  card.aiState = aiState || null;
  if (!aiState) return false;
  if (card.manualAt && card.manualAt >= card.lastTs) return false;
  const from = card.status;
  if (aiState === 'resolved') return autoMove(card, 'done', 'resolved');
  if (aiState === 'waiting_on_them' && (from === 'inbox' || from === 'todo')) return autoMove(card, 'waiting', 'waiting on them');
  if (aiState === 'needs_me' && (from === 'waiting' || from === 'done') && !card.messages?.at(-1)?.mine) {
    if (from === 'done') card.reopened = true;
    return autoMove(card, 'inbox', 'needs you');
  }
  return false;
}

function mergeResult(card, result) {
  card.reasons = [...new Set([...card.reasons, ...result.reasons])];
  card.urgent ||= result.urgent;
  if (PRIORITY_RANK[result.priority] > PRIORITY_RANK[card.priority]) card.priority = result.priority;
  const TYPE_RANK = { fyi: 0, question: 1, task: 2, requirement: 3, bug: 4 };
  if (TYPE_RANK[result.type] > TYPE_RANK[card.type]) card.type = result.type;
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

/**
 * Drop auto-created cards (except ones with your notes) and rescan with the current
 * rules. Cards you added yourself are kept. Returns removed ids.
 */
export function rebuild(state) {
  const removed = state.cards.filter((c) => c.source === 'rocketchat' && !c.notes).map((c) => c.id);
  state.cards = state.cards.filter((c) => !removed.includes(c.id));
  state.roomCursors = {};
  state.pendingRooms = [];
  state.gaps = [];
  state.lastPoll = null;
  return removed;
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
  if ('title' in body) card.titleEdited = true;
  if ('status' in body) {
    card.manualAt = new Date().toISOString(); // your move wins over automatic moves
    card.autoReason = null;
  }
  card.newActivity = false;
  card.reopened = false;
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
    aiError: state.aiError || null,
    pending: (state.pendingRooms || []).length + (state.gaps || []).length,
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
