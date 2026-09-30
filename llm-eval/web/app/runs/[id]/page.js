import { notFound } from 'next/navigation';
import { getRun } from '../../../lib/store';
import { judgeName, pct, summarize } from '../../../lib/summary';
import Results from './results';

export const dynamic = 'force-dynamic';

const fmt = (x) => (x == null ? '-' : x.toFixed(2));

export default async function RunPage({ params }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const s = summarize(run);

  // Who do the judges prefer? Count head-to-head wins across all judges.
  const totals = Object.fromEntries(run.models.map((m) => [m, 0]));
  for (const j of s.judges) for (const m of run.models) totals[m] += s.wins[j][m];
  const ranked = [...run.models].sort((a, b) => totals[b] - totals[a]);
  const leader = totals[ranked[0]] > (totals[ranked[1]] ?? -1) ? ranked[0] : null;

  return (
    <>
      <p className="small"><a href="/">← All runs</a></p>
      <h1>{run.description || run.id}</h1>
      <p className="muted small">
        Uploaded {new Date(run.uploadedAt).toLocaleString('en-GB')} · {run.rows.length} outputs · {s.comparisons} head-to-head comparisons
      </p>

      <div className="verdict">
        {leader ? (
          <>
            <b>{leader} wins.</b>{' '}
            {s.judges.map((j) => `${judgeName(j)} picked ${leader} ${s.wins[j][leader]}/${s.comparisons}`).join(' · ')}
          </>
        ) : (
          <b>No clear winner: the judges split evenly.</b>
        )}
      </div>

      <div className="grid">
        {s.perModel.map((m) => (
          <div key={m.model} className="card">
            <div className="muted small">{m.model}</div>
            <div className="big">{pct(m.passed, m.total)}</div>
            <div className="muted small">passed ({m.passed}/{m.total})</div>
            <div className="chips">
              {s.judges.map((j) => (
                <span key={j} className="chip">{judgeName(j)} <b className="num">{fmt(m.avg[j])}</b></span>
              ))}
            </div>
            <div className="small">
              <span className={m.invented ? 'badge fail' : 'badge pass'}>{m.invented} with invented numbers</span>
              <span className="muted"> · ${m.cost.toFixed(4)} · {Math.round(m.latencyMs)} ms avg</span>
            </div>
          </div>
        ))}
      </div>

      <h2>Head-to-head wins per judge</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Judge</th>{run.models.map((m) => <th key={m}>{m}</th>)}<th>Tie</th></tr>
          </thead>
          <tbody>
            {s.judges.map((j) => (
              <tr key={j}>
                <td>{judgeName(j)}</td>
                {run.models.map((m) => <td key={m} className="num">{s.wins[j][m]}</td>)}
                <td className="num">{s.wins[j].tie}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Outputs</h2>
      <Results run={run} />
    </>
  );
}
