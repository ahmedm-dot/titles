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

function parse(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const out = JSON.parse(match[0]);
    return {
      title: String(out.title || '').trim().slice(0, 120),
      ask: String(out.ask || '').trim().slice(0, 240),
      type: TYPES.includes(out.type) ? out.type : null,
    };
  } catch {
    return null;
  }
}

/** Summarizes up to `max` cards that changed, newest open cards first. Returns ids updated. */
export async function summarizeCards(state, run, max = 6) {
  const queue = state.cards
    .filter((c) => c.needsSummary && c.source === 'rocketchat' && c.status !== 'done')
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
    .slice(0, max);
  const updated = [];
  for (const card of queue) {
    try {
      const out = parse(await run(prompt(card, state.me)));
      if (out) {
        if (out.title && !card.titleEdited) card.title = out.title;
        card.summary = out.ask;
        if (out.type) card.type = out.type;
      }
    } catch {
      /* leave the rule-based title; retry on the next change */
      continue;
    }
    card.needsSummary = false;
    updated.push(card.id);
  }
  return updated;
}
