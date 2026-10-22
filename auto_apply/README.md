# Auto Apply — AI job applications from a CV + job URL

Give it a CV and one or more job posting URLs. For each job, a cloud browser
agent (Browser Use Cloud, API v4) opens the posting, fills in the application
from your CV, uploads the CV file, and returns a structured result:

- **status** — `submitted`, `ready_to_submit`, `needs_user_input`,
  `blocked_login`, `blocked_captcha`, `job_closed`, `failed`
  (plus `declined_by_user` when you reject a review)
- **job** — title, company, location, ATS platform (Greenhouse, Lever, Workday…)
- **match** — ATS-style CV ↔ job score (0–100), matched skills, missing keywords
- **fields_filled** — every field and the value used, tagged `cv` / `answers` / `generated`
- **unanswered_required_questions** — what the agent refused to guess
- **confirmation** — confirmation text or reference number after submitting
- cost in USD, run IDs and session ID (look the session up in the
  [Browser Use dashboard](https://cloud.browser-use.com) to replay it)

## Setup

```bash
pip install -r auto_apply/requirements.txt
export BROWSER_USE_API_KEY=bu_...   # https://cloud.browser-use.com/settings?tab=api-keys&new=1
```

## Use

```bash
# Default "review" mode: fill the form, show you the result, submit only if you type y
python -m auto_apply --cv my_cv.pdf --job https://boards.greenhouse.io/acme/jobs/123 \
    --answers auto_apply/examples/answers.example.json

# Many jobs, fill-only (never submits) — good for a first pass
python -m auto_apply --cv my_cv.pdf --jobs-file auto_apply/examples/jobs.example.txt --mode dry-run

# Fully automatic submission
python -m auto_apply --cv my_cv.pdf --jobs-file jobs.txt --mode auto --max-cost 2
```

Results print as each job finishes and are saved to
`results/applications_<timestamp>.json`.

| flag | default | meaning |
|---|---|---|
| `--mode` | `review` | `review` = fill → you approve → submit · `dry-run` = never submit · `auto` = submit without asking |
| `--answers` | none | JSON with answers the CV doesn't hold: work authorization, sponsorship, salary, notice period, phone, links, EEO. See `examples/answers.example.json` |
| `--model` | account default (`gpt-6-luna` on the free plan) | any Browser Use v4 model id; paid models such as `claude-sonnet-5-5` need credits |
| `--max-cost` | `3` | USD budget per job session (enforced server-side) |
| `--proxy-country` | `us` | residential proxy exit country, or `none` |
| `--concurrency` | `3` | jobs processed in parallel |
| `--timeout` | `1800` | seconds to wait for each agent run (the run is cancelled after) |

From Python:

```python
import asyncio
from auto_apply import ApplyConfig, apply_to_jobs

results = asyncio.run(apply_to_jobs(
    ["https://jobs.lever.co/acme/abcd"], "my_cv.pdf",
    ApplyConfig(mode="dry-run", answers={"notice_period": "1 month"}),
))
```

## How it works

1. The CV is uploaded once to a Browser Use workspace and attached to every run,
   so the agent can both read it and upload it into resume fields.
2. One run per job (`POST /api/v4/runs`) with a strict JSON output schema
   (`prompts.py`). The prompt forbids inventing facts, forces the
   "decline to self-identify" option for EEO questions, and makes the agent
   stop and report rather than guess required answers.
3. **Review mode** stops before the final submit and keeps the browser alive
   for `review_window_s` (600 s). If you approve, a follow-up run in the *same
   session* clicks submit on the already-filled page. If you decline, nothing is
   sent; the idle browser closes when the window expires (that idle time is billed).

## Known limits

- **Login-walled ATSs** (Workday, LinkedIn Easy Apply, Taleo) end as
  `blocked_login` — credentials aren't wired in yet. Next step: pass
  `secret_bindings` per domain (the agent can type them without seeing them),
  or a persistent Browser Use profile that's already signed in.
- CAPTCHAs end as `blocked_captcha`; stealth + residential proxies reduce
  but don't remove them.
- The match score is the agent's judgement from the posting, not a
  deterministic ATS parser.
- Check each site's terms of service before running `auto` mode at volume.

## Tests

```bash
python -m pytest tests/
```

The tests use a fake client, so they need no API key or network.
