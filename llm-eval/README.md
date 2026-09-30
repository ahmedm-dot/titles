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
                                           - JS check    -> no invented numbers
```

| File | What it holds |
|---|---|
| `promptfooconfig.yaml` | generator models, judges, rubric |
| `prompts/*.txt` | production prompts under test (`{{vars}}` get filled from test cases) |
| `tests/*.yaml` | test cases: anonymised resumes and job descriptions |
| `judges/jev.mjs` | Jev (TypeSafe AI) judge |
| `scripts/summary.mjs` | model comparison table: average score per judge, head-to-head wins |
| `demo/` | fake models and judges for `npm run demo` (no keys, no cost) |
| `web/` | team UI on Vercel: runs, winners, outputs and judge reasons |
| `scripts/upload.mjs` | uploads a run to the web app |

## Try it with no API keys (demo)

```bash
cd llm-eval
npm install
npm run demo        # fake GPT/Gemini outputs, fake Claude/GPT judges, local fake Jev API
npm run view        # full web UI at http://localhost:15500
```
`.env.demo` holds dummy keys only. The demo runs the real config, the real Jev judge
code and the real TypeSafe SDK; only the model calls are fake. It writes a standalone
report to `output/demo-report.html`. The demo's scores come from a simple keyword/number
heuristic, so they show how the report works, not how good GPT or Gemini really is.

## Run it for real

```bash
cd llm-eval
npm install
cp .env.example .env        # add OPENAI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, TYPESAFE_API_KEY
npm run eval                # runs every prompt x model x test case, then every judge
npm run summary             # which model wins, per judge
npm run view                # opens the web UI: side-by-side outputs, per-judge scores
```

`npm run eval` also saves `output/results.json` and a standalone `output/report.html`
you can share. Useful flags: `npm run eval -- --filter-providers Gemini`, `--repeat 3`
(checks stability), `-o output/results.csv` (spreadsheet export), `--no-cache`.

Head-to-head winners come from `npm run summary`, which compares the judges' scores for
GPT and Gemini on each prompt x test case. promptfoo's own `select-best` isn't used: it
runs only one judge per test, mixes different prompts into one comparison, and marks the
losing output as failed, which would distort the pass rate.

## Team UI on Vercel

`web/` is a small Next.js app that shows each uploaded run: the winner, pass rate and
average score per judge for each model, head-to-head wins, and every output side by side
with each judge's score and reason. It's password protected, and runs are stored in a
**private** Vercel Blob store, so CVs never get a public URL.

(promptfoo's own UI can't run on Vercel: it needs a long-running server and a database on
disk. `npm run view` still works locally.)

**One-time setup (free Hobby plan, no card)**
1. Vercel -> **Add New -> Project** -> import `ahmedm-dot/titles`.
   Set **Root Directory** to `llm-eval/web`. Framework: Next.js (auto-detected).
2. Before deploying, add environment variables:
   - `BASIC_AUTH_PASSWORD`: a long random password (12+ characters)
   - `BASIC_AUTH_USER`: optional, defaults to `team`
3. Deploy. Then **Storage -> Create -> Blob**, choose **Private**, connect it to the
   project, and **redeploy** (this adds `BLOB_READ_WRITE_TOKEN`).
4. Open the project URL; the browser asks for the username and password.

Note: Vercel's Hobby plan is for personal, non-commercial use. For company use, move the
project to a Pro team, or host `web/` elsewhere (only `web/lib/store.js` touches Vercel).

**Upload a run** — add to `llm-eval/.env`:
```
EVAL_UI_URL=https://your-project.vercel.app
EVAL_UI_PASSWORD=the password from step 2
```
Then:
```bash
npm run eval && npm run upload        # real run
npm run demo && npm run upload:demo   # demo run
```
Only what the UI needs is uploaded: inputs, outputs, pass/fail and judge scores/reasons.

**Run the web app locally**
```bash
cd web && npm install
BASIC_AUTH_PASSWORD=local-dev-password npm run dev   # http://localhost:3000, runs saved in web/.data/
```

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
is compared through `npm run summary` like the other judges. Set `TYPESAFE_DEFAULT_MODEL`
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
