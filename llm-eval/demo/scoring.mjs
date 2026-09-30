// DEMO ONLY: a crude stand-in for a real judge, so the report has realistic-looking scores.
const STOP = new Set('about their there which would should could these those with from that this have will your team teams including strong skills looking responsible'.split(' '));

const words = (t) => (t.toLowerCase().match(/[a-z][a-z()+#]{4,}/g) || []).filter((w) => !STOP.has(w));

export function heuristic(output, inputText, jobDescription) {
  const invented = (output.match(/\d+(?:\.\d+)?/g) || []).filter((n) => !inputText.includes(n));
  const jd = [...new Set(words(jobDescription))];
  const out = new Set(words(output));
  const coverage = jd.length ? jd.filter((w) => out.has(w)).length / jd.length : 0;
  const firstPerson = /\b(I|my)\b/.test(output);
  const tooLong = output.split(/\s+/).length > 80;
  let score = Math.min(0.95, 0.45 + coverage * 1.4);
  if (firstPerson) score -= 0.15;
  if (tooLong) score -= 0.2;
  if (invented.length) score = 0;
  const reasons = [];
  if (invented.length) reasons.push(`invents numbers not in the input: ${invented.join(', ')}`);
  if (firstPerson) reasons.push('uses first person');
  if (tooLong) reasons.push('too long');
  reasons.push(`job-keyword coverage ${(coverage * 100).toFixed(0)}%`);
  return { score: Math.max(0, +score.toFixed(2)), invented, formatOk: !firstPerson && !tooLong, reason: reasons.join('; ') };
}
