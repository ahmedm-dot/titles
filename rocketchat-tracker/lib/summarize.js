// Turns a conversation card into a topic title + "what's asked of you" line with an LLM.
// `run(messages)` is injected by the host (Workers AI on Cloudflare); without it, cards
// keep their rule-based title.

const TYPES = ['task', 'requirement', 'bug', 'question', 'fyi'];

function transcript(card) {
  return card.messages
    .slice(-15)
    .map((m) => `${m.mine ? 'ME' : m.who}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
}

function prompt(card, me) {
  return [
    {
      role: 'system',
      content:
        `You triage workplace chat for ${me.name || me.username} (shown as ME). ` +
        'Read the conversation and reply with JSON only, no prose: ' +
        '{"title": "the topic in at most 8 words", ' +
        '"ask": "what ME is being asked to do or answer, one short sentence, or empty if nothing", ' +
        '"type": "task" | "requirement" | "bug" | "question" | "fyi"}. ' +
        'Write title and ask in the language the conversation mostly uses.',
    },
    { role: 'user', content: `Conversation in ${card.roomType === 'd' ? 'a DM' : '#' + card.roomName}:\n${transcript(card)}` },
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
  try {
    return {
      title: String(out.title || '').trim().slice(0, 120),
      ask: String(out.ask || '').trim().slice(0, 240),
      type: TYPES.includes(out.type) ? out.type : null,
    };
  } catch {
    return null;
  }
}

/**
 * Summarizes up to `max` cards that changed, newest open cards first. Returns ids updated.
 * The last failure is kept in state.aiError so the board can show it.
 */
export async function summarizeCards(state, run, max = 6) {
  const queue = state.cards
    .filter((c) => c.needsSummary && c.source === 'rocketchat' && c.status !== 'done' && (c.summaryTries || 0) < 3)
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
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
    card.summary = out.ask;
    if (out.type) card.type = out.type;
    card.needsSummary = false;
    card.summaryTries = 0;
    state.aiError = null;
  }
  return updated;
}
