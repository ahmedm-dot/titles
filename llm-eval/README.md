# LLM eval: compare models and judge their outputs

Send the same prompts to several **generator** models (GPT, Gemini), then have several
**judge** models (Claude, Jev, GPT) grade every output. Built on
[promptfoo](https://promptfoo.dev), an open-source eval tool (MIT), so we get the runner,
caching, cost tracking, a side-by-side web UI and CI support without writing them ourselves.

## How it works

```
test case (resume + JD) ─┬─> GPT    ─┐
                         └─> Gemini ─┴─> judges: Claude, Jev, GPT
                                           - llm-rubric  -> 0-1 score (judge_claude, judge_gpt)
                                           - Jev         -> 0-1 score (judge_jev)
                                           - select-best -> which model won (winner_by_claude/gpt)
                                           - JS check    -> no invented numbers
```

| File | What it holds |
|---|---|
| `promptfooconfig.yaml` | generator models, judges, rubric |
| `prompts/*.txt` | production prompts under test (`{{vars}}` get filled from test cases) |
| `tests/*.yaml` | test cases: anonymised resumes and job descriptions |
| `judges/jev.mjs` | Jev (TypeSafe AI) judge |

## Run it

```bash
cd llm-eval
npm install
cp .env.example .env        # add OPENAI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY
npm run eval                # runs every prompt x model x test case, then every judge
npm run view                # opens the web UI: side-by-side outputs, per-judge scores
```

Useful flags: `npx promptfoo eval --filter-providers Gemini`, `--repeat 3` (checks
stability), `-o output/results.csv` (export for a spreadsheet), `--no-cache`.

## Adding a feature (cover letter, LinkedIn headline, job-match score...)

1. Add `prompts/<feature>.txt` using `{{variables}}`.
2. Add `tests/<feature>.yaml` with 20-50 real, anonymised cases (include hard ones:
   career changers, gaps, non-English CVs).
3. Point a config at them (copy `promptfooconfig.yaml` and change the rubric).

## The Jev judge

[Jev](https://docs.typesafe.ai) (TypeSafe AI) is not a chat model. You send it content plus
typed questions, and it returns probabilities instead of free text. `judges/jev.mjs`
asks it three questions about every output:

| Question | Type | Fails the output when |
|---|---|---|
| Did it invent experience, employers, qualifications or metrics? | yes/no | P(yes) >= 0.5 |
| Does it follow the prompt's formatting rules? | yes/no | P(yes) < 0.5 |
| How well does it improve the candidate for this job? | score, 0-4 | expected score < 2.5 |

Because Jev returns a probability instead of an opinion in words, it is the most
consistent of the three judges from run to run. It also has no stake in GPT vs Gemini,
so it's a good neutral tie-breaker next to Claude. It scores each output on its own, so it
doesn't take part in the head-to-head `select-best` step. Set `TYPESAFE_DEFAULT_MODEL`
to pin a model version (the default is `jev-latest`).

## Judge design notes

- **Self-preference bias:** GPT tends to favour GPT output. Claude and Jev generate
  nothing in this comparison, so treat them as the neutral judges and `judge_gpt` as a
  second opinion. Don't let one self-judging model decide a winner.
- **Calibrate once:** have a recruiter or PM hand-score ~30 outputs, and keep the judge
  whose scores agree with theirs most. Tighten the rubric where judges disagree.
- **Deterministic checks first:** anything a script can check (length, bullet count,
  invented numbers, required keywords via `icontains-any`) should be a code assertion.
  Those checks cost nothing and give the same answer every run.

## Image generation (next step)

promptfoo can call image models (`openai:image:gpt-image-1.5`, Gemini image models) and
grade the results with a vision judge through `llm-rubric`. We'll add an `images/` config
(resume template previews, profile photos) once the text setup is in use.
