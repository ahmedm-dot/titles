// Same numbers as llm-eval/scripts/summary.mjs, computed from an uploaded run.
export const judgesOf = (run) =>
  [...new Set(run.rows.flatMap((r) => r.checks.map((c) => c.metric)).filter((m) => m?.startsWith('judge_')))];

const scoreOf = (row, metric) => row.checks.find((c) => c.metric === metric)?.score;

export function summarize(run) {
  const judges = judgesOf(run);
  const perModel = run.models.map((model) => {
    const rows = run.rows.filter((r) => r.model === model);
    const avg = {};
    for (const j of judges) {
      const s = rows.map((r) => scoreOf(r, j)).filter((x) => typeof x === 'number');
      avg[j] = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    }
    return {
      model,
      total: rows.length,
      passed: rows.filter((r) => r.pass).length,
      avg,
      invented: rows.filter((r) => scoreOf(r, 'no_invented_numbers') === 0).length,
      cost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
      latencyMs: rows.length ? rows.reduce((a, r) => a + (r.latencyMs ?? 0), 0) / rows.length : 0,
    };
  });

  const groups = new Map();
  for (const r of run.rows) {
    const key = `${r.prompt}::${r.testIdx}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const wins = Object.fromEntries(judges.map((j) => [j, Object.fromEntries([...run.models, 'tie'].map((m) => [m, 0]))]));
  for (const group of groups.values()) {
    for (const j of judges) {
      const scored = group.map((r) => ({ m: r.model, s: scoreOf(r, j) ?? -1 }));
      const top = Math.max(...scored.map((x) => x.s));
      const best = scored.filter((x) => x.s === top);
      wins[j][best.length === 1 ? best[0].m : 'tie'] += 1;
    }
  }
  return { judges, perModel, wins, comparisons: groups.size };
}

export const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
export const judgeName = (metric) => {
  const n = metric.replace(/^judge_/, '');
  return n === 'gpt' ? 'GPT' : n.charAt(0).toUpperCase() + n.slice(1);
};
