# Job Title Suggest (standalone AI service)

Typeahead job-title suggestions for the CV builder: the user types any partial title, in any
CV language, and gets 6 standard, ATS-friendly job titles streamed back.
Pure AI (OpenAI). No dependency on the rest of this repo, and no npm dependencies (Node ≥ 20).

**Production default: `luna56-fs3-prio`.** It uses `gpt-5.6-luna` with reasoning off, the few-shot v3 prompt and the
Fast tier (`service_tier: "priority"`, renamed Fast mode by OpenAI).
It scores **9.31/10**. The first suggestion arrives in **~510 ms** at p50 (~610 ms at p90), and the full list in ~660 ms.
It costs about **$280 per 1M uncached calls**, 73% less than the previous default (`mini54-fs3-prio`, $1,050), at the same speed.

Alternatives:
- **Best quality and lowest cost:** `luna6-fs3` (`gpt-6-luna`, standard tier). It scores 9.38 with 94% of answers rated ≥ 9,
  for **$67 per 1M calls**. It is ~130 ms slower to the first item and weaker when English is typed on a non-English CV (6.5).
- **Cheapest from the gpt-5.6 line:** `luna56-fs3` (standard tier). Same quality as the default, ~140 ms slower, $141 per 1M calls.

**→ The full quality × speed × cost matrix, with a score breakdown per language and per category, is in
[`bench/MATRIX.md`](bench/MATRIX.md).** Regenerate it with `node bench/matrix.mjs`. Prices are in `bench/pricing.json`.

## Run

```bash
cd service
echo "OPENAI_API_KEY=sk-..." > .env      # gitignored; or export OPENAI_API_KEY
npm start                                # http://localhost:8787
```

Open `http://localhost:8787` for the A/B test page. It runs two arms side by side, with a CV-language
picker and per-request latency.

### API

| endpoint | returns |
|---|---|
| `GET /api/suggest/stream?q=sr%20swe&locale=en` | **SSE** (recommended for the UI). It sends one `item` event per suggestion as soon as it is generated, then `done` with `{items, first_ms, total_ms, usage, cached}` |
| `GET /api/suggest?q=…&locale=…` | JSON `{items, first_ms, total_ms, usage, arm, cached}` |
| `GET /api/arms` | All A/B arms plus the default |

Params: `q` (≤ 80 chars, min 2), `locale` (CV language code, e.g. `en`, `fr`, `ar`), `arm` (optional
override for experiments), `n` (1–10, default 6). Env: `PORT`, `DEFAULT_ARM`, `OPENAI_BASE_URL`.

Built-in latency and cost controls:
- An LRU cache (5k keys) per arm, locale and normalized query. Typeahead prefixes repeat heavily
  across users, so cached hits return in about 0 ms.
- When the client disconnects (the user typed another key), the upstream OpenAI call is aborted.
  You don't pay for discarded keystrokes.
- Suggestions are streamed line by line, so the first title renders before the list is done.
- The client debounces input by 120 ms and closes the previous `EventSource` on each keystroke.

## How the default was chosen (A/B record)

The benchmark (`bench/queries.json`) has **54 queries across 12 CV languages**: en, es, pt, fr, de, it, nl, ar, tr,
pl, ru and id. They cover prefixes, very short input, abbreviations (`sr swe`, `hrbp`), typos
(`markting manger`), grammatical gender (`enfermera de`, `professora`), cross-language input
(English typed on a French CV), and gibberish.

Each arm's output is graded 0–10 by `gpt-5.5` (reasoning low), using a rubric covering intent, language,
standard titles, typo fixing, gender, duplicates and casing.
Latency is measured from this cloud container. `first` is the time to the first complete suggestion.

```bash
npm run bench -- mini54-fs3-prio,mini54-fewshot --reps=2      # any arms from src/arms.mjs
```

Raw per-query outputs, judge scores and issues are in `bench/results/round*.json`.

### Round 1: models × reasoning × prompt (1 rep)

| arm | model | reasoning | prompt | score | first p50 | total p50 |
|---|---|---|---|---|---|---|
| gpt55-fewshot | gpt-5.5 | none | few-shot v1 | **9.37** | 925 | 1364 |
| mini54-low | gpt-5.4-mini | **low** | few-shot v1 | 9.31 | 892 | 1044 |
| mini54-fewshot | gpt-5.4-mini | none | few-shot v1 | 9.26 | 712 | 958 |
| mini54-rules | gpt-5.4-mini | none | rules | 9.20 | 708 | 949 |
| mini41-fewshot | gpt-4.1-mini | – | few-shot v1 | 9.11 | 537 | 731 |
| nano54-fewshot | gpt-5.4-nano | none | few-shot v1 | 9.06 | 552 | 757 |
| 4omini-fewshot | gpt-4o-mini | – | few-shot v1 | 8.74 | 542 | 781 |
| mini54-minimal | gpt-5.4-mini | none | minimal | 8.67 | 690 | 915 |
| nano54-rules | gpt-5.4-nano | none | rules | 8.65 | 515 | 723 |

Findings:
- **Reasoning doesn't pay off for this task.** `low` added +0.05 quality for +180 ms and 70% more output tokens.
- **The prompt matters more than the model.** Moving from the minimal prompt to the few-shot prompt on the same model added +0.6.
- **`gpt-5.5` is the quality ceiling but too slow for typeahead.**
- Models above 1.4 s first-token time (gpt-5.6-*, gpt-6-*, gpt-5.4) were dropped after a latency probe.

### Round 2: prompt v2 and the `priority` service tier (2 reps)

| arm | score | first p50 | first p90 | total p50 |
|---|---|---|---|---|
| gpt55-fs2 | 9.34 | 903 | 1046 | 1364 |
| mini54-fewshot | 9.22 | 697 | 823 | 914 |
| mini54-fs2 | 9.19 | 680 | 770 | 913 |
| **mini54-fs2-prio** | 9.19 | **471** | **610** | **614** |
| mini41-fewshot | 9.14 | 511 | 712 | 719 |
| mini41-fs2-prio | 9.03 | 458 | 545 | 701 |
| nano54-fewshot | 8.89 | 551 | 721 | 776 |
| nano54-fs2(-prio) | 8.70 | 533 | 680 | 745 |

Findings:
- **The `priority` tier is the biggest speed gain.** On gpt-5.4-mini it cut ~230 ms from the first item and ~300 ms
  from the full list, with no change in quality. It has no effect on nano.
- Prompt v2 fixed cross-language input. English typed on a French CV now stays English.
- **nano was dropped.** It produced false "no suggestions" for real titles (`krankenpfl`, `programis`).

### Round 3: prompt v3, prefix discipline and partial words (2 reps)

| arm | score | ≥ 9/10 | first p50 | first p90 | total p50 |
|---|---|---|---|---|---|
| **mini54-fs3-prio** ✅ | **9.30** | 85 % | **477** | **586** | **638** |
| mini54-fs2-prio | 9.19 | 81 % | 468 | 583 | 631 |
| mini41-fs3-prio | 8.83 | 70 % | 521 | 696 | 729 |

The winner matches `gpt-5.5` quality (9.30 vs 9.34) at about half the latency.

### Round 4: luna models plus pricing (2 reps)

| arm | score | ≥ 9/10 | first p50 | all p50 | $ / 1M calls |
|---|---|---|---|---|---|
| luna6-fs3 (gpt-6-luna) | **9.38** | **94 %** | 617 | 878 | **$67** |
| luna6-fs3-prio (Fast) | 9.40 | 89 % | 692 | 915 | $135 |
| luna56-fs3 | 9.32 | 85 % | 642 | 931 | $141 |
| **luna56-fs3-prio** ✅ new default | 9.31 | 85 % | 508 | 659 | $282 |
| mini54-fs3-prio (old default) | 9.18 | 77 % | 490 | 652 | $1,050 |
| mini54-fs3 | 9.22 | 82 % | 678 | 911 | $523 |

Findings:
- Fast mode does not speed up gpt-6-luna. Its standard tier is already the fastest gpt-6 option.
- The service records the tier that actually served each request (`tier` in the response). Fast requests came back
  as `priority`, or `fast` on gpt-6-luna, so the tier was really applied.

### Known weak spots (as of round 3)

- **Arabic partial words where a generic word shares the letters.** For example, `مدير مشار` gets completed to مشارك
  ("associate") about half the time instead of مشاريع ("projects"). Every model has this problem, including gpt-5.5. In
  practice one more keystroke (`مدير مشاري`) resolves it.
- Russian and Indonesian score around 7.5–8 (still usable). The judge mostly flags the ranking order.
- Fast mode costs exactly 2× standard per token (official pricing). On luna that is still far cheaper than gpt-5.4-mini.

## Files

```
src/server.mjs     HTTP + SSE server, LRU cache, upstream abort
src/ai.mjs         streaming OpenAI client (emits each line as a suggestion)
src/prompts.mjs    prompt variants: minimal, rules, fewshot, fewshot2, fewshot3
src/arms.mjs       A/B arms (model × reasoning × prompt × service tier) + DEFAULT_ARM
public/index.html  side-by-side A/B test page
bench/             queries.json, run.mjs (LLM-judged benchmark), matrix.mjs → MATRIX.md, pricing.json, results/
```
