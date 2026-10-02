// Uploads a promptfoo results file to the LLM Eval web app (llm-eval/web, on Vercel or Netlify).
// Only what the UI needs is sent: inputs, outputs, pass/fail, and each judge's score and reason.
// Usage: node scripts/upload.mjs [output/results.json]
// Needs in .env: EVAL_UI_URL, EVAL_UI_PASSWORD (and EVAL_UI_USER, default "team").
import fs from 'node:fs';

try {
  process.loadEnvFile('.env');
} catch {}
const { EVAL_UI_URL, EVAL_UI_USER = 'team', EVAL_UI_PASSWORD } = process.env;
if (!EVAL_UI_URL || !EVAL_UI_PASSWORD) {
  console.error('Set EVAL_UI_URL and EVAL_UI_PASSWORD in .env (see .env.example).');
  process.exit(1);
}

const file = process.argv[2] ?? 'output/results.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = data.results.results;

const run = {
  description: data.config?.description ?? '',
  createdAt: data.results.timestamp ?? null,
  models: [...new Set(results.map((r) => r.provider.label ?? r.provider.id))],
  rows: results.map((r) => ({
    prompt: (r.prompt.label ?? '').split(':')[0] || `prompt ${r.promptIdx}`,
    testIdx: r.testIdx,
    test: r.testCase?.description ?? '',
    vars: r.vars ?? r.testCase?.vars ?? {},
    model: r.provider.label ?? r.provider.id,
    output: typeof r.response?.output === 'string' ? r.response.output : JSON.stringify(r.response?.output ?? ''),
    error: r.error && !r.gradingResult ? String(r.error) : undefined,
    pass: Boolean(r.success),
    score: r.score,
    cost: r.cost ?? 0,
    latencyMs: r.latencyMs ?? 0,
    checks: (r.gradingResult?.componentResults ?? []).map((c) => ({
      metric: c.assertion?.metric,
      type: c.assertion?.type,
      pass: c.pass,
      score: c.score,
      reason: c.reason,
    })),
  })),
};

const res = await fetch(new URL('/api/runs', EVAL_UI_URL), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`${EVAL_UI_USER}:${EVAL_UI_PASSWORD}`).toString('base64')}`,
  },
  body: JSON.stringify(run),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Upload failed (${res.status}): ${body.error ?? res.statusText}`);
  process.exit(1);
}
console.log(`Uploaded ${run.rows.length} outputs: ${new URL(body.url, EVAL_UI_URL)}`);
