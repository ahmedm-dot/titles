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

// v2: tighter rules aimed at round-1 failures (partial-word ambiguity, cross-language input,
// mixed scripts, gibberish). Few-shot inputs deliberately differ from bench queries to avoid overfitting.
const RULES2 = `You are the job-title autocomplete in a multilingual CV builder. Return the {n} job titles the user most likely means, one per line, nothing else.
- Complete the input as a prefix. If the last word is partial, consider every word it could become and rank by how common the resulting title is on CVs.
- Language = the language the user is typing, even if the CV language differs. Use the CV language only when the input could be either language. Every title in that language and script; keep only universal acronyms (UX, QA, SAP, IT).
- Fix typos, expand abbreviations (sr, swe, pm, hr, vp, cfo...). Real, standard, ATS-friendly titles; first = most common. Vary specialization/seniority, no near-duplicates.
- Keep the grammatical gender the user typed.
- If the input cannot be a job title, reply exactly: NONE`;

const FEWSHOT2 = [
  ['jr front', 'en', 'Junior Frontend Developer\nJunior Front End Engineer\nJunior Frontend Web Developer\nJunior React Developer\nJunior UI Developer\nJunior JavaScript Developer'],
  ['enfermera de', 'es', 'Enfermera de Urgencias\nEnfermera de Cuidados Intensivos\nEnfermera de Quirófano\nEnfermera de Pediatría\nEnfermera de Atención Primaria\nEnfermera de Hospitalización'],
  ['product owner', 'de', 'Product Owner\nSenior Product Owner\nTechnical Product Owner\nAgile Product Owner\nProduct Owner Digital\nProduct Owner E-Commerce'],
  ['أخصائي تسو', 'ar', 'أخصائي تسويق\nأخصائي تسويق رقمي\nأخصائي تسويق إلكتروني\nأخصائي تسويق المحتوى\nأخصائي تسويق وسائل التواصل الاجتماعي\nأخصائي تسويق ومبيعات'],
  ['lorem xq', 'en', 'NONE'],
];

// v3: v2 + prefix discipline for short inputs and partial non-Latin words.
const RULES3 = RULES2.replace(
  '- Complete the input as a prefix. If the last word is partial, consider every word it could become and rank by how common the resulting title is on CVs.',
  `- Complete the input as a prefix: every title must start with (or, after fixing typos/abbreviations, clearly contain) what was typed. Short inputs like "te" → titles starting with "Te".
- If the last word is partial, list the occupations it could become (any script, incl. Arabic/Cyrillic) and pick the ones most common on CVs — real occupation words beat generic words that merely share the letters.`);

const FEWSHOT3 = [
  ['te', 'en', 'Teacher\nTechnician\nTeam Leader\nTechnical Support Specialist\nTest Engineer\nTelecommunications Engineer'],
  ...FEWSHOT2.slice(1, 3),
  ['مهندس برم', 'ar', 'مهندس برمجيات\nمهندس برمجيات أول\nمهندس برمجة\nمهندس برمجيات الواجهة الخلفية\nمهندس برمجيات تطبيقات الويب\nمهندس برمجيات الأنظمة المدمجة'],
  ['lorem xq', 'en', 'NONE'],
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
  // P3: v2 rules + v2 few-shot
  fewshot2: ({ q, locale, n }) => [
    { role: 'system', content: RULES2.replace('{n}', n) },
    ...FEWSHOT2.flatMap(([fq, fl, fa]) => [
      { role: 'user', content: userMsg(fq, fl) },
      { role: 'assistant', content: fa.split('\n').slice(0, n).join('\n') },
    ]),
    { role: 'user', content: userMsg(q, locale) },
  ],
  // P4: v3 rules + v3 few-shot
  fewshot3: ({ q, locale, n }) => [
    { role: 'system', content: RULES3.replace('{n}', n) },
    ...FEWSHOT3.flatMap(([fq, fl, fa]) => [
      { role: 'user', content: userMsg(fq, fl) },
      { role: 'assistant', content: fa.split('\n').slice(0, n).join('\n') },
    ]),
    { role: 'user', content: userMsg(q, locale) },
  ],
};
