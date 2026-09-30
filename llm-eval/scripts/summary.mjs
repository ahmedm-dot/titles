// Prints the model comparison from a promptfoo results file:
// average score per judge per model, and head-to-head wins per judge.
// Usage: node scripts/summary.mjs [output/results.json]
import fs from 'node:fs';

const file = process.argv[2] ?? 'output/results.json';
const rows = JSON.parse(fs.readFileSync(file, 'utf8')).results.results;

const JUDGES = ['judge_claude', 'judge_jev', 'judge_gpt'];
const models = [...new Set(rows.map((r) => r.provider.label ?? r.provider.id))];
const scoreOf = (r, judge) =>
  r.gradingResult?.componentResults?.find((c) => c.assertion?.metric === judge)?.score;

// 1) Averages and pass rate per model
const table = models.map((m) => {
  const mine = rows.filter((r) => (r.provider.label ?? r.provider.id) === m);
  const row = { model: m, pass_rate: `${Math.round((100 * mine.filter((r) => r.success).length) / mine.length)}%` };
  for (const j of JUDGES) {
    const s = mine.map((r) => scoreOf(r, j)).filter((x) => typeof x === 'number');
    row[j] = s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) : '-';
  }
  row.invented_numbers = mine.filter((r) => scoreOf(r, 'no_invented_numbers') === 0).length;
  row.cost_usd = +mine.reduce((a, r) => a + (r.cost ?? 0), 0).toFixed(4);
  return row;
});
console.log('\nAverage score per judge (0-1), pass rate, and outputs with invented numbers:');
console.table(table);

// 2) Head-to-head: for each prompt x test case, which model each judge scored higher
const groups = new Map();
for (const r of rows) {
  const key = `${r.prompt.label}:${r.testIdx}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const wins = Object.fromEntries(JUDGES.map((j) => [j, Object.fromEntries([...models, 'tie'].map((m) => [m, 0]))]));
for (const group of groups.values()) {
  for (const j of JUDGES) {
    const scored = group.map((r) => ({ m: r.provider.label ?? r.provider.id, s: scoreOf(r, j) ?? -1 }));
    const top = Math.max(...scored.map((x) => x.s));
    const best = scored.filter((x) => x.s === top);
    wins[j][best.length === 1 ? best[0].m : 'tie'] += 1;
  }
}
console.log(`Head-to-head wins per judge (${groups.size} prompt x test-case comparisons):`);
console.table(wins);
