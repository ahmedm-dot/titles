// Streaming OpenAI call that emits each suggestion as soon as its line is complete.
import { PROMPTS } from './prompts.mjs';
import { norm } from './normalize.mjs';

const API = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';

const clean = s => s.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').replace(/^["'«“]+|["'»”]+$/g, '').trim();

/**
 * @returns {Promise<{items:string[], first_ms:number|null, total_ms:number, usage:object|null, tier:string|null}>}
 * onItem(title) fires per suggestion while streaming (drives SSE to the browser).
 */
export async function suggestAI({ q, locale, arm, n = 6, signal, onItem }) {
  const t0 = performance.now();
  const body = {
    model: arm.model,
    messages: PROMPTS[arm.prompt]({ q, locale, n }),
    max_completion_tokens: arm.reasoning_effort && arm.reasoning_effort !== 'none' ? 1500 : 120,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (arm.reasoning_effort) body.reasoning_effort = arm.reasoning_effort;
  if (arm.service_tier) body.service_tier = arm.service_tier;

  const res = await fetch(API, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const items = [], seen = new Set();
  let first_ms = null, usage = null, tier = null, buf = '', line = '';
  const emit = raw => {
    const t = clean(raw);
    const k = norm(t);
    if (!t || t === 'NONE' || seen.has(k) || items.length >= n) return;
    seen.add(k); items.push(t);
    if (first_ms === null) first_ms = Math.round(performance.now() - t0);
    onItem?.(t);
  };
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!ev.startsWith('data:') || ev === 'data: [DONE]') continue;
      const j = JSON.parse(ev.slice(5));
      if (j.usage) usage = j.usage;
      if (j.service_tier) tier = j.service_tier;
      const d = j.choices?.[0]?.delta?.content;
      if (!d) continue;
      line += d;
      let k;
      while ((k = line.indexOf('\n')) >= 0) { emit(line.slice(0, k)); line = line.slice(k + 1); }
    }
  }
  emit(line);
  return { items, first_ms, total_ms: Math.round(performance.now() - t0), usage, tier };
}
