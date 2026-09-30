// DEMO ONLY: a local stand-in for the TypeSafe API (POST /v1/systemone), so the real
// judges/jev.mjs code and the real @typesafe-ai/sdk run unchanged against it.
import http from 'node:http';
import { heuristic } from './scoring.mjs';

export function startMockJev(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { state } = JSON.parse(body);
      const vars = state.candidate_input ?? {};
      const h = heuristic(state.ai_output, Object.values(vars).join(' '), vars.job_description ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        model: 'jev-demo',
        usage: { input_tokens: 600, output_tokens: 3 },
        answers: {
          invented: { type: 'noul', noul: h.invented.length ? 0.93 : 0.04 },
          follows_format: { type: 'noul', noul: h.formatOk ? 0.91 : 0.22 },
          quality: { type: 'score', score: +(h.score * 4).toFixed(2), confidence: 0.8, legend: {}, probabilities: {} },
        },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
