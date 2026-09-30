// DEMO ONLY: stands in for the Claude and GPT judges (llm-rubric and select-best).
import { heuristic } from './scoring.mjs';

const between = (text, a, b) => {
  const i = text.indexOf(a);
  if (i < 0) return '';
  const j = text.indexOf(b, i + a.length);
  return text.slice(i + a.length, j < 0 ? undefined : j).trim();
};

export default class MockJudge {
  constructor(options) {
    this.name = options.config?.judge ?? 'judge';
    this.offset = options.config?.offset ?? 0;
  }
  id() {
    return `demo-judge:${this.name}`;
  }
  async callApi(prompt) {
    let text = prompt;
    try {
      // the last message holds the real output; earlier ones hold promptfoo's examples
      const messages = JSON.parse(prompt);
      text = messages[messages.length - 1].content;
    } catch {}

    if (text.includes('<Text index=')) {
      // select-best: return the index of the best output
      const input = between(text, 'criteria:', 'Here are the pieces of text');
      const jd = between(input, 'job description:', '), without');
      const texts = [...text.matchAll(/<Text index="(\d+)">([\s\S]*?)<\/Text>/g)];
      const best = texts
        .map(([, i, t]) => ({ i, s: heuristic(t.trim(), input, jd).score }))
        .sort((a, b) => b.s - a.s)[0];
      return { output: best.i };
    }

    // llm-rubric: return {reason, pass, score}
    const output = between(text, '<Output>', '</Output>');
    const input = between(text, '<CandidateInput>', '</CandidateInput>');
    const jd = between(input, 'Job description:', 'Summary:');
    const h = heuristic(output, input, jd);
    const score = h.invented.length ? 0 : Math.max(0, Math.min(1, +(h.score + this.offset).toFixed(2)));
    const pass = !h.invented.length && h.formatOk && score >= 0.6;
    return { output: JSON.stringify({ reason: `[demo ${this.name}] ${h.reason}`, pass, score }) };
  }
}
