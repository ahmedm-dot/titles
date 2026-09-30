'use client';
import { useMemo, useState } from 'react';

const label = (metric, type) => {
  if (!metric) return type;
  if (metric.startsWith('judge_')) {
    const n = metric.slice(6);
    return n === 'gpt' ? 'GPT' : n.charAt(0).toUpperCase() + n.slice(1);
  }
  return metric.replace(/_/g, ' ');
};

export default function Results({ run }) {
  const [show, setShow] = useState('all');
  const [prompt, setPrompt] = useState('all');
  const prompts = [...new Set(run.rows.map((r) => r.prompt))];

  const cases = useMemo(() => {
    const groups = new Map();
    for (const r of run.rows) {
      if (prompt !== 'all' && r.prompt !== prompt) continue;
      const key = `${r.prompt}::${r.testIdx}`;
      if (!groups.has(key)) groups.set(key, { key, prompt: r.prompt, test: r.test, vars: r.vars, rows: [] });
      groups.get(key).rows.push(r);
    }
    return [...groups.values()].filter((g) =>
      show === 'all' ? true : show === 'fail' ? g.rows.some((r) => !r.pass) : g.rows.every((r) => r.pass),
    );
  }, [run, show, prompt]);

  return (
    <>
      <div className="toolbar">
        {[['all', 'All'], ['fail', 'Has a failure'], ['pass', 'All passed']].map(([v, t]) => (
          <button key={v} className="tab" aria-pressed={show === v} onClick={() => setShow(v)}>{t}</button>
        ))}
        <select value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt">
          <option value="all">All prompts</option>
          {prompts.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="muted small">{cases.length} test cases</span>
      </div>

      {cases.map((c) => (
        <div key={c.key} className="card case">
          <div className="case-head">
            <b>{c.test || 'Test case'}</b>
            <span className="chip">{c.prompt}</span>
            {c.vars?.job_title && <span className="muted small">Target job: {c.vars.job_title}</span>}
          </div>
          <details>
            <summary>Candidate input</summary>
            <pre className="vars">{Object.entries(c.vars ?? {}).map(([k, v]) => `${k}:\n${String(v).trim()}\n`).join('\n')}</pre>
          </details>
          <div className="outputs" style={{ marginTop: 12 }}>
            {c.rows.map((r) => (
              <div key={r.model} className={`output ${r.pass ? '' : 'failed'}`}>
                <div className="case-head" style={{ marginBottom: 0 }}>
                  <b>{r.model}</b>
                  <span className={`badge ${r.pass ? 'pass' : 'fail'}`}>{r.pass ? 'PASS' : 'FAIL'}</span>
                  <span className="muted small num">score {r.score?.toFixed(2)}</span>
                </div>
                <pre>{r.error ? `Error: ${r.error}` : r.output}</pre>
                <div className="chips">
                  {r.checks.filter((k) => k.metric).map((k) => (
                    <span key={k.metric} className={`chip ${k.pass ? '' : 'fail'}`}>
                      {label(k.metric, k.type)} <b className="num">{k.score?.toFixed(2)}</b>
                    </span>
                  ))}
                </div>
                <details>
                  <summary>Why? (judge reasons)</summary>
                  <ul>
                    {r.checks.map((k, i) => (
                      <li key={i}>
                        <b>{label(k.metric, k.type)}</b> {k.pass ? '✓' : '✗'} {k.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
