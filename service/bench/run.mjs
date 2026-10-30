// A/B benchmark: every arm × every query, scored by an LLM judge.
// Usage: node bench/run.mjs [armA,armB,...] [--reps=1] [--judge=gpt-5.5]
import '../src/env.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { ARMS } from '../src/arms.mjs';
import { suggestAI } from '../src/ai.mjs';

const args = process.argv.slice(2);
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const armIds = (args.find(a => !a.startsWith('--'))?.split(',')) || Object.keys(ARMS);
const reps = +(opt('reps') || 1);
const JUDGE = opt('judge') || 'gpt-5.5';
const CONC = +(opt('conc') || 6);
const queries = JSON.parse(readFileSync(new URL('./queries.json', import.meta.url)));

async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

const JUDGE_SYS = `You grade a job-title autocomplete for a multilingual CV builder.
Given what the user typed, their CV language, the expected intent, and the suggestion list, score 0-10:
10 = first item is the obvious intended title, all items are real, standard, correctly spelled job titles in the right language, useful variety.
Deduct for: wrong language (except the cross-language rule in the intent), not completing the typed prefix/meaning, unfixed typos, invented/non-standard titles, near-duplicates, bad casing, mixed languages in one title, wrong grammatical gender vs what was typed.
For junk inputs, an empty or near-empty list scores 10; invented titles score low.
Reply as JSON: {"score": <0-10 int>, "issue": "<= 12 words, main problem or 'ok'>"}`;

async function judge(qd, items) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE, reasoning_effort: 'low', response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: JUDGE_SYS },
        { role: 'user', content: `Typed: ${qd.q}\nCV language: ${qd.locale}\nIntent: ${qd.intent}\nSuggestions:\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n') || '(empty)'}` }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return JSON.parse(j.choices[0].message.content);
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const rows = [];
for (const id of armIds) {
  const arm = ARMS[id];
  const tasks = [];
  for (let r = 0; r < reps; r++) for (const qd of queries) tasks.push(async () => {
    try {
      const res = await suggestAI({ q: qd.q, locale: qd.locale, arm });
      const j = await judge(qd, res.items);
      return { arm: id, ...qd, ...res, ...j };
    } catch (e) { return { arm: id, ...qd, error: e.message }; }
  });
  const res = await pool(tasks, CONC);
  const ok = res.filter(r => !r.error);
  const s = {
    arm: id, model: arm.model, reasoning: arm.reasoning_effort || '-', prompt: arm.prompt,
    n: ok.length, errors: res.length - ok.length,
    score: +mean(ok.map(r => r.score)).toFixed(2),
    perfect: Math.round(100 * ok.filter(r => r.score >= 9).length / ok.length),
    first_p50: pct(ok.map(r => r.first_ms ?? r.total_ms), 0.5), first_p90: pct(ok.map(r => r.first_ms ?? r.total_ms), 0.9),
    total_p50: pct(ok.map(r => r.total_ms), 0.5), total_p90: pct(ok.map(r => r.total_ms), 0.9),
    tiers: [...new Set(ok.map(r => r.tier))].join('/'),
    in_tok: Math.round(mean(ok.map(r => r.usage?.prompt_tokens || 0))), out_tok: Math.round(mean(ok.map(r => r.usage?.completion_tokens || 0))),
  };
  console.log(JSON.stringify(s));
  for (const r of res.filter(r => r.error)) console.log('  ERR', r.q, r.error.slice(0, 150));
  for (const r of ok.filter(r => r.score <= 6)) console.log(`  low ${r.score} [${r.locale}] "${r.q}" → ${r.items.join(' | ')}  // ${r.issue}`);
  rows.push({ summary: s, results: res });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(new URL(`./results/run-${stamp}.json`, import.meta.url), JSON.stringify(rows, null, 1));
console.log('\n| arm | model | reasoning | prompt | score/10 | ≥9 % | first p50 | first p90 | total p50 | total p90 | in tok | out tok | err |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const { summary: s } of rows.sort((a, b) => b.summary.score - a.summary.score))
  console.log(`| ${s.arm} | ${s.model} | ${s.reasoning} | ${s.prompt} | ${s.score} | ${s.perfect} | ${s.first_p50} | ${s.first_p90} | ${s.total_p50} | ${s.total_p90} | ${s.in_tok} | ${s.out_tok} | ${s.errors} |`);
