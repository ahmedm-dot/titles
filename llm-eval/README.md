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
| `deploy/` | password-protected promptfoo UI for Render (`render.yaml` at the repo root) |

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

## Host the UI on Render (for the team)

One Render web service runs the promptfoo UI behind a password, with results stored on
a Render persistent disk so they survive deploys. You run evals on your machine (or in CI)
and upload each run with `npm run share`.

**One-time setup**
1. Render Dashboard -> **New -> Blueprint** -> connect this repo. Render reads `render.yaml`
   and creates the `llm-eval` service (Starter plan, needed for the disk; 1 GB disk).
2. When it's live, open the service's **Environment** tab and copy `BASIC_AUTH_PASSWORD`
   (Render generated it). The username is `team`.
3. Open `https://llm-eval.onrender.com` (or the URL Render shows). The browser asks for
   the username and password.

**Upload a run**
Add to your `.env` (the password goes inside the URL):
```
PROMPTFOO_REMOTE_API_BASE_URL=https://team:YOUR_RENDER_PASSWORD@llm-eval.onrender.com
PROMPTFOO_REMOTE_APP_BASE_URL=https://llm-eval.onrender.com
```
Then:
```bash
npm run eval       # or: npm run demo
npm run share      # uploads the latest run and prints its link
```

**Notes**
- The promptfoo UI has no login of its own; `deploy/auth-proxy.mjs` is the only thing
  protecting it. Only `/healthz` (Render's health check, returns "ok") is public.
- Keep the promptfoo version in `deploy/Dockerfile` and `package.json` the same, so
  uploads match what the server expects.
- To change the password, edit `BASIC_AUTH_PASSWORD` on Render, then update your `.env`.
- Real CVs are personal data. Share the password only with people who should see them,
  and use anonymised CVs in `tests/` where you can.

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
