import { getRun, listRunIds } from '../lib/store';
import { pct, summarize } from '../lib/summary';

export const dynamic = 'force-dynamic';

export default async function Runs() {
  const ids = (await listRunIds()).slice(0, 50);
  const runs = (await Promise.all(ids.map(getRun))).filter(Boolean);

  if (!runs.length) {
    return (
      <div className="card empty">
        <h1>No runs yet</h1>
        <p className="muted">
          In <code>llm-eval/</code> run <code>npm run eval</code> (or <code>npm run demo</code>), then <code>npm run upload</code>.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1>Runs</h1>
      <p className="muted">Newest first. Open a run to see which model won and why.</p>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Uploaded</th><th>Run</th><th>Outputs</th><th>Pass rate per model</th></tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const s = summarize(run);
              return (
                <tr key={run.id}>
                  <td className="num small">{new Date(run.uploadedAt).toLocaleString('en-GB')}</td>
                  <td><a href={`/runs/${run.id}`}>{run.description || run.id}</a></td>
                  <td className="num">{run.rows.length}</td>
                  <td>
                    <div className="chips">
                      {s.perModel.map((m) => (
                        <span key={m.model} className="chip"><b>{m.model}</b> {pct(m.passed, m.total)}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
