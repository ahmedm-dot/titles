// Turns a conversation card into a contextual title, a background line and
// "what's asked of you" with an LLM. `run(messages)` is injected by the host
// (Workers AI on Cloudflare); without it, cards keep their rule-based title.

import { applyAiState } from './tracker.js';

const TYPES = ['task', 'requirement', 'bug', 'question', 'fyi'];
const STATES = ['needs_me', 'waiting_on_them', 'resolved'];

function line(m) {
  return `${m.mine ? 'ME' : m.who}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`;
}

function transcript(card) {
  const msgs = card.messages || [];
  // Keep the opening message (it usually names the topic) plus the latest exchange.
  if (msgs.length <= 16) return msgs.map(line).join('\n');
  return [line(msgs[0]), `… ${msgs.length - 15} earlier messages …`, ...msgs.slice(-14).map(line)].join('\n');
}

function where(card) {
  if (card.roomType === 'd') return `a direct message with ${card.roomName}`;
  return `#${card.roomName}${card.tmid ? ' (a thread)' : ''}`;
}

function prompt(card, me) {
  return [
    {
      role: 'system',
      content: `You turn workplace chat into a task card for ${me.name || me.username}, shown as ME.
Reply with one JSON object and nothing else:
{"title": "...", "context": "...", "ask": "...", "type": "task|requirement|bug|question|fyi",
 "state": "needs_me|waiting_on_them|resolved"}

title: "<feature, product or project>: <the specific thing>", 4 to 10 words. Use the real names
  from the chat (features, screens, clients, locales, models, numbers). Someone must know what it is
  about without opening it. Never a bare verb phrase.
  Good: "Checkout page: coupon field rejects lowercase codes"
  Good: "Billing API: move invoices job to the EU region"
  Good: "Onboarding emails: French copy for day-3 reminder"
  Bad: "Validate changes"  Bad: "Review design"  Bad: "Question about upload"
  (These examples are only about format. Never reuse their words.)
context: one sentence of background: what the discussion is about and where it stands.
ask: what ME must do or answer next, one short sentence starting with a verb. Empty string if
  nothing is needed from ME (for example ME already answered and nobody asked again).
type: task (ME must do something), requirement (a new feature or spec), bug (something broken),
  question (ME must answer), fyi (nothing needed).
state: where the conversation stands right now, judged from the latest messages:
  needs_me: someone is waiting for ME to answer, decide, review or deliver something.
  waiting_on_them: ME replied, asked something or handed work off, and is waiting for someone else.
  resolved: answered, fixed, confirmed, delivered or dropped ("works now", "thanks", "done",
    "deployed", "no need"), and nobody is waiting on anything.
  When unsure between needs_me and anything else, choose needs_me.
Write in the language the conversation mostly uses.`,
    },
    {
      role: 'user',
      content: `Conversation in ${where(card)}${card.participants?.length ? ` with ${card.participants.join(', ')}` : ''}:\n${transcript(card)}`,
    },
  ];
}

function parse(reply) {
  let out = reply;
  if (typeof reply !== 'object' || reply === null) {
    const match = String(reply || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      out = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!out || typeof out !== 'object') return null;
  return {
    title: String(out.title || '').trim().slice(0, 120),
    context: String(out.context || '').trim().slice(0, 280),
    ask: String(out.ask || '').trim().slice(0, 240),
    type: TYPES.includes(out.type) ? out.type : null,
    state: STATES.includes(out.state) ? out.state : null,
  };
}

/**
 * Summarizes up to `max` cards that changed: open cards first (newest first), then Done.
 * Returns ids updated. The last failure is kept in state.aiError so it can be shown.
 */
export async function summarizeCards(state, run, max = 6) {
  const queue = state.cards
    .filter((c) => c.needsSummary && c.source === 'rocketchat' && (c.summaryTries || 0) < 3)
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.lastTs.localeCompare(a.lastTs))
    .slice(0, max);
  const updated = [];
  for (const card of queue) {
    let reply;
    try {
      reply = await run(prompt(card, state.me));
    } catch (err) {
      state.aiError = `AI call failed: ${err.message}`;
      break; // likely a quota or binding problem; try again next run
    }
    const out = parse(reply);
    card.summaryTries = (card.summaryTries || 0) + 1;
    updated.push(card.id);
    if (!out) {
      state.aiError = `AI reply was not JSON: ${JSON.stringify(reply).slice(0, 200)}`;
      continue;
    }
    if (out.title && !card.titleEdited) card.title = out.title;
    card.context = out.context;
    card.summary = out.ask;
    if (out.type) card.type = out.type;
    applyAiState(card, out.state);
    card.needsSummary = false;
    card.summaryTries = 0;
    state.aiError = null;
  }
  return updated;
}
