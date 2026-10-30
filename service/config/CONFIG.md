# Production configuration: the two finalist setups

| | **A: Fastest (current default)** | **B: Best quality, cheapest** |
|---|---|---|
| Arm id | `luna56-fs3-prio` | `luna6-fs3` |
| Model | `gpt-5.6-luna` | `gpt-6-luna` |
| Service tier | `priority` (Fast mode) | default (Standard) |
| Reasoning | `none` | `none` |
| Prompt | few-shot v3 (`fewshot3`) | few-shot v3 (`fewshot3`) |
| Quality (judge, 0–10) | 9.31 · 85 % of queries ≥ 9 | **9.38 · 94 % ≥ 9** |
| First title p50 / p90 | **508 / 613 ms** | 617 / 942 ms |
| All 6 titles p50 / p90 | **659 / 796 ms** | 878 / 1125 ms |
| Price per 1M tokens (in / out) | $0.40 / $2.40 | **$0.10 / $0.50** |
| Cost per 1M uncached calls | $282 | **$67** |
| Known weak spot | Indonesian 8.0, Turkish 8.5 | English typed on a non-English CV 6.5, Arabic 7.6 |

The setups share everything except two fields: `model`, and whether `service_tier: "priority"` is sent.

## 1. OpenAI request (Chat Completions)

`POST https://api.openai.com/v1/chat/completions`

Complete request bodies, ready to send after replacing `{{QUERY}}` and `{{CV_LOCALE}}`:
- A: [`luna56-fast.request.json`](luna56-fast.request.json)
- B: [`luna6-standard.request.json`](luna6-standard.request.json)

| param | value | why |
|---|---|---|
| `model` | `gpt-5.6-luna` (A) / `gpt-6-luna` (B) | Winners of round 4 |
| `service_tier` | `"priority"` (A) / omitted (B) | Fast mode: ~130 ms faster to the first title on 5.6-luna at 2× token price. It gives no speed gain on 6-luna. `"fast"` is an accepted alias. Ultrafast is not offered for luna. |
| `reasoning_effort` | `"none"` | Reasoning added ~180 ms for +0.05 quality in round 1. `gpt-6-luna` **reasons by default**, so always send this. `"minimal"` is rejected by both models. |
| `stream` | `true` | Each title is shown as soon as its line is generated |
| `stream_options.include_usage` | `true` | Token usage for cost tracking |
| `max_completion_tokens` | `120` | 6 titles ≈ 34 tokens. This is a safety cap. |
| `temperature`, `top_p` | not set | Model defaults |
| `response_format` | not set | Plain lines are faster than JSON (fewer tokens, streamable) |

### Messages (identical for A and B)

1. **System**
   ```
   You are the job-title autocomplete in a multilingual CV builder. Return the 6 job titles the user most likely means, one per line, nothing else.
   - Complete the input as a prefix: every title must start with (or, after fixing typos/abbreviations, clearly contain) what was typed. Short inputs like "te" → titles starting with "Te".
   - If the last word is partial, list the occupations it could become (any script, incl. Arabic/Cyrillic) and pick the ones most common on CVs — real occupation words beat generic words that merely share the letters.
   - Language = the language the user is typing, even if the CV language differs. Use the CV language only when the input could be either language. Every title in that language and script; keep only universal acronyms (UX, QA, SAP, IT).
   - Fix typos, expand abbreviations (sr, swe, pm, hr, vp, cfo...). Real, standard, ATS-friendly titles; first = most common. Vary specialization/seniority, no near-duplicates.
   - Keep the grammatical gender the user typed.
   - If the input cannot be a job title, reply exactly: NONE
   ```
2. **Few-shot pairs.** Five user/assistant pairs, in this order:

   | user | assistant |
   |---|---|
   | `CV language: en` ⏎ `Input: te` | Teacher ⏎ Technician ⏎ Team Leader ⏎ Technical Support Specialist ⏎ Test Engineer ⏎ Telecommunications Engineer |
   | `CV language: es` ⏎ `Input: enfermera de` | Enfermera de Urgencias ⏎ Enfermera de Cuidados Intensivos ⏎ Enfermera de Quirófano ⏎ Enfermera de Pediatría ⏎ Enfermera de Atención Primaria ⏎ Enfermera de Hospitalización |
   | `CV language: de` ⏎ `Input: product owner` | Product Owner ⏎ Senior Product Owner ⏎ Technical Product Owner ⏎ Agile Product Owner ⏎ Product Owner Digital ⏎ Product Owner E-Commerce |
   | `CV language: ar` ⏎ `Input: مهندس برم` | مهندس برمجيات ⏎ مهندس برمجيات أول ⏎ مهندس برمجة ⏎ مهندس برمجيات الواجهة الخلفية ⏎ مهندس برمجيات تطبيقات الويب ⏎ مهندس برمجيات الأنظمة المدمجة |
   | `CV language: en` ⏎ `Input: lorem xq` | NONE |
3. **User**
   ```
   CV language: {{CV_LOCALE}}
   Input: {{QUERY}}
   ```

`{{CV_LOCALE}}` is the CV's language code (`en`, `fr`, `es`, `pt`, `de`, `it`, `nl`, `ar`, `tr`, `pl`, `ru`, `id`, …).
`{{QUERY}}` is the raw text the user typed, trimmed and cut to 80 characters.

The source of truth is `src/prompts.mjs` (`fewshot3`). If you change the number of suggestions, the `6` in the system prompt
and the few-shot answers are sliced automatically.

## 2. Post-processing (`src/ai.mjs`)

Applied to each streamed line:
1. Strip leading bullets and numbering (`-`, `*`, `•`, `1.`, `1)`) and surrounding quotes.
2. Drop empty lines and the literal `NONE`, which means empty results.
3. De-duplicate with accent-, case- and Arabic-letter-insensitive normalization (`src/normalize.mjs`).
4. Cap the list at `n` (6).

## 3. Service settings (`src/server.mjs`)

| setting | value |
|---|---|
| `DEFAULT_ARM` env | `luna56-fs3-prio` (A) or `luna6-fs3` (B) |
| Per-request override | `?arm=luna6-fs3` (for A/B bucketing) |
| Minimum query length | 2 characters (shorter returns an empty list, with no API call) |
| Max query length | 80 characters |
| Suggestions `n` | 6 (range 1–10, `?n=`) |
| Cache | In-memory LRU, 5,000 keys, keyed on arm + locale + n + normalized query. Use Redis in production, with a TTL of about 7 days. |
| Cancellation | Client disconnect aborts the OpenAI call (no charge for discarded keystrokes) |
| Endpoint for the UI | `GET /api/suggest/stream?q=&locale=` (SSE: `item` events, then `done`) |
| Response metadata | `tier` (`priority` / `fast` / `default`) = the tier OpenAI actually served. Log it. |

## 4. Frontend settings (`public/index.html`)

| setting | value |
|---|---|
| Debounce | 120 ms |
| Trigger | ≥ 2 characters |
| On new keystroke | Close the previous `EventSource` (cancels the upstream call) |
| Rendering | Keep the old list until the first new item arrives (no flicker); append items as they stream |
| RTL | `dir="auto"` on the input and list (Arabic) |

## 5. A/B rollout plan (A vs B)

- **Bucket:** hash the user id to choose arm A or B (50/50), and pass `arm=` on each request.
- **Primary metric:** suggestion acceptance rate (a suggestion is clicked rather than free text typed).
- **Secondary metrics:** time to choose a title, completion rate of the job-title step, edits after selection, CV completion.
- **Guardrails:** first-title p90 latency, error rate, and cost per 1,000 sessions (log `usage` and `tier`).
- **Decision rule:** B wins if acceptance is not worse (within the confidence interval) and latency guardrails hold. It is
  76 % cheaper and higher quality. A wins if B's extra ~110 ms to the first title measurably lowers acceptance.
