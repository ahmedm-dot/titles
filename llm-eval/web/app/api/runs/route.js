// POST /api/runs: upload a run (made by `npm run upload` in llm-eval/). Protected by proxy.js.
import { randomBytes } from 'node:crypto';
import { saveRun } from '../../../lib/store';

export async function POST(request) {
  let run;
  try {
    run = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!Array.isArray(run?.rows) || !Array.isArray(run?.models) || !run.rows.length) {
    return Response.json({ error: 'Not a run: expected { models: [], rows: [] } from npm run upload' }, { status: 400 });
  }
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const id = `${stamp}-${randomBytes(4).toString('hex')}`;
  try {
    await saveRun({ ...run, id, uploadedAt: new Date().toISOString() });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
  return Response.json({ id, url: `/runs/${id}` }, { status: 201 });
}
