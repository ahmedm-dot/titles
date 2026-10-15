// Rule-based triage: decides whether a chat message deserves a card, and what kind.
// English + Arabic keyword lists; extend via WATCH_KEYWORDS in .env.

const RULES = {
  urgent: [
    'asap', 'urgent', 'urgently', 'eod', 'end of day', 'today', 'tonight', 'deadline',
    'blocker', 'blocking', 'critical', 'immediately', 'by tomorrow', 'p0', 'hotfix',
    'عاجل', 'ضروري', 'حالا', 'فورا', 'النهارده', 'اليوم', 'بكرة',
  ],
  task: [
    'can you', 'could you', 'would you', 'please', 'pls', 'plz', 'need you', 'need to',
    'action item', 'todo', 'to do', 'assign', 'take care', 'follow up', 'make sure',
    'let me know', 'please review', 'please check', 'can you check', 'fix the', 'send me',
    'ممكن', 'لو سمحت', 'من فضلك', 'محتاج', 'محتاجين', 'عايز', 'عاوز', 'راجع', 'تابع',
  ],
  requirement: [
    'requirement', 'requirements', 'spec', 'prd', 'user story', 'acceptance criteria',
    'feature request', 'new feature', 'should be able', 'must be able',
    'متطلبات', 'فيتشر', 'ميزة جديدة',
  ],
  bug: [
    'bug', 'broken', 'not working', "doesn't work", 'does not work', 'crash', 'crashing',
    'regression', 'is down', 'مش شغال', 'باظ', 'خطأ',
  ],
};

const hasAny = (text, words) => words.some((w) => matchWord(text, w));

function matchWord(text, word) {
  // Latin words need word boundaries ("eod" shouldn't match "geode"); Arabic uses plain includes.
  if (/^[\x00-\x7F]+$/.test(word)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
  }
  return text.includes(word);
}

/**
 * @returns {null | {reasons: string[], type: string, priority: 'high'|'medium'|'low', urgent: boolean}}
 */
export function classify(msg, { me, room, sub, watchKeywords = [], mutedRooms = [] }) {
  if (!msg.msg || msg.t) return null; // system messages (joins, pins, etc.)
  if (msg.u?._id === me._id) return null; // own messages

  const text = msg.msg.toLowerCase();
  const mentions = msg.mentions || [];
  const reasons = [];

  if (mentions.some((m) => m._id === me._id || m.username === me.username)) reasons.push('mention');
  if (room.t === 'd') reasons.push('dm');
  if (msg.tmid && (sub?.tunread || []).includes(msg.tmid)) reasons.push('thread');
  if (mentions.some((m) => m.username === 'all' || m.username === 'here')) reasons.push('group');

  const muted = mutedRooms.includes((room.name || '').toLowerCase());
  const watched = !muted && watchKeywords.find((k) => matchWord(text, k));
  if (watched) reasons.push(`keyword:${watched}`);

  if (!reasons.length) return null;

  const urgent = hasAny(text, RULES.urgent);
  let type = 'fyi';
  if (hasAny(text, RULES.bug)) type = 'bug';
  else if (hasAny(text, RULES.requirement)) type = 'requirement';
  else if (hasAny(text, RULES.task)) type = 'task';
  else if (/[?؟]/.test(text)) type = 'question';

  // Chit-chat doesn't need a card: outside a direct @mention, only an ask (task,
  // requirement, bug, question) or something urgent does.
  if (type === 'fyi' && !urgent && !reasons.includes('mention')) return null;

  const direct = reasons.includes('mention') || reasons.includes('dm') || reasons.includes('thread');
  let priority = 'low';
  if (direct && (urgent || type !== 'fyi')) priority = 'high';
  else if (direct || urgent || type === 'requirement' || type === 'bug') priority = 'medium';

  return { reasons, type, priority, urgent };
}

export function makeTitle(text, max = 90) {
  const clean = text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
