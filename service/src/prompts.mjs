// Prompt variants under A/B test. Each builds chat messages for one keystroke query.
// Kept short on purpose: every input token adds latency on a per-keystroke call.

const RULES = `You are the job-title autocomplete inside a CV/resume builder used in many languages.
The user is typing the job title for their CV. Return the {n} most likely job titles they mean.

Rules:
- Output ONLY job titles, one per line. No numbering, bullets, quotes, or commentary.
- Language: write titles in the language the user is typing, even if it differs from the CV language (English typed on a French CV → English titles). Only when the input is ambiguous between languages (e.g. "manager", "data") use the CV language. All titles in the list must be in that one language.
- Treat input as a prefix or partial phrase: complete it. The first title should be the single most common completion.
- Silently fix typos and expand abbreviations (sr, jr, swe, pm, hr, qa, vp, cfo...) into full standard titles.
- Use real, standard, ATS-friendly titles that recruiters search for. Title Case for English; normal capitalization for other languages.
- Keep the grammatical gender the user typed (enfermera, infirmière, Lehrerin). If gender is unclear, use the most common form.
- Vary specializations/seniority; no near-duplicates.
- If the input is not a plausible job, return an empty response.`;

const FEWSHOT = [
  ['sr swe', 'en', 'Senior Software Engineer\nSenior Software Developer\nSenior Backend Engineer\nSenior Full Stack Engineer\nSenior Frontend Engineer\nSenior Mobile Engineer'],
  ['enfermera de', 'es', 'Enfermera de Urgencias\nEnfermera de Cuidados Intensivos\nEnfermera de Quirófano\nEnfermera de Pediatría\nEnfermera de Atención Primaria\nEnfermera de Hospitalización'],
  ['chef de pro', 'fr', 'Chef de projet\nChef de projet informatique\nChef de produit\nChef de projet digital\nChef de projet marketing\nChef de projet travaux'],
  ['محاسب', 'ar', 'محاسب\nمحاسب عام\nمحاسب مالي\nمحاسب تكاليف\nمحاسب قانوني\nمحاسب ضرائب'],
];

const userMsg = (q, locale) => `CV language: ${locale || 'unknown'}\nInput: ${q}`;

export const PROMPTS = {
  // P0: bare minimum instruction
  minimal: ({ q, locale, n }) => [
    { role: 'system', content: `Autocomplete a job title for a CV. Return ${n} job titles, one per line, in the same language as the input (CV language as tie-breaker). Fix typos and abbreviations. No numbering or commentary.` },
    { role: 'user', content: userMsg(q, locale) },
  ],
  // P1: explicit product rules
  rules: ({ q, locale, n }) => [
    { role: 'system', content: RULES.replace('{n}', n) },
    { role: 'user', content: userMsg(q, locale) },
  ],
  // P2: rules + multilingual few-shot (anchors format, casing, gender, abbreviations)
  fewshot: ({ q, locale, n }) => [
    { role: 'system', content: RULES.replace('{n}', n) },
    ...FEWSHOT.flatMap(([fq, fl, fa]) => [
      { role: 'user', content: userMsg(fq, fl) },
      { role: 'assistant', content: fa.split('\n').slice(0, n).join('\n') },
    ]),
    { role: 'user', content: userMsg(q, locale) },
  ],
};
