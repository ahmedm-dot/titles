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
- full cost in USD (AI model + browser time + proxy traffic, with a breakdown), run IDs and session ID.
  The tool closes each job's browser when it is done, which refunds unused browser time and makes
  the cost final (Browser Use holds browser time up front until the browser closes) (look the session up in the
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
| `--proxy-country` | `us` | residential proxy exit country for sites that need one, or `none`. **Only Lever gets a proxy by default** (its hCaptcha blocks datacenter IPs); add `--proxy-everywhere` to proxy every site. Proxy traffic is billed per MB |
| `--concurrency` | `3` | jobs processed in parallel |
| `--timeout` | `1800` | seconds to wait for each agent run (the run is cancelled after) |
| `--fill-optional` | off | by default the agent fills **required fields only** (marked `*`/"required" or blocking submit) and leaves optional ones empty; this flag also fills optional fields |

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
3. If the agent reports the CV upload failed (`cv_upload: "failed"`), the tool
   retries up to 2 times rather than dropping the application: first in the same
   browser session (the form is still filled), then from scratch in a fresh browser,
   since a stuck file transfer tends to stay stuck in the same browser. A closed or
   login-walled job is not retried. The agent never submits without the CV.
4. **Review mode** stops before the final submit and keeps the browser alive
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

## Prompt A/B testing

`prompt_variants/b.txt` holds an alternative application prompt, kept verbatim.
Use it for a single run with `--prompt-variant b`, or compare both prompts:

```bash
python -m auto_apply.ab_test --cv my_cv.pdf --jobs-file jobs.txt --answers answers.json --proxy-country pl
```

To really submit, add `--split`: each job is randomly given to one prompt only
(`--seed` makes it reproducible), which runs it in `--mode auto`, and the report
compares the two groups. `--email-b you@example.com` makes variant B use your own
email instead of an AgentMail inbox, so recruiter replies reach you (but B can then
no longer read verification codes itself).

By default both variants run in **dry-run** on the same jobs (one employer must never get two
applications) with the same model, proxy, CV and answers, and automatic upload
retries off so each result reflects the prompt alone. The report (`ab_<ts>.md`)
compares: reached the final submit step, CV attached, stopped for user input, fields
filled, AI-written answers, final cost and time.

Variant B's placeholders are filled as: `{{totp_identifier}}` = a Browser Use
AgentMail inbox (enabled with `agentmail`), `{{resume}}` = the attached CV file
(B was written for a CV URL), `{{parsed_resume}}` = the CV's text,
`{{candidate_info}}` = the answers JSON. Around (not inside) the template the tool
adds the posting URL, a no-submit override in dry-run/review modes, and a reporting
footer so B's runs fill the same output schema as A.

## Scan first, then finish in the same session

```bash
# 1) Scan: fill what is known, list every question the answers do not cover, keep the browser open
python -m auto_apply --cv cv.pdf --job <url> --answers answers.json --mode dry-run --hold [--account-password-env PW]
# 2) Add the missing answers to answers.json, then finish the same half-filled form
python -m auto_apply --cv cv.pdf --job <url> --answers answers.json --mode auto --continue-session <SESSION_ID>
```

`--hold` keeps the browser open (for `verification_window_s`, 15 min by default; billed as
browser time) whenever a run stops for missing answers or a dry-run ends. `--continue-session`
starts a follow-up turn in that session: it keeps the conversation, the CV and the filled form,
so it only fills the gaps and submits. `--resume-session` is the same for email verification.

## CV link (recommended)

Pass `--cv-url <public link to the same PDF>` (for Google Drive use the direct-download form
`https://drive.google.com/uc?export=download&id=<FILE_ID>`). The CV is still attached as a file;
the link is the first fallback when the upload fails: many file inputs only accept files from the
browser's Downloads folder, and opening the link downloads the CV there. The prompt forbids sending
the CV or candidate data anywhere except the job's own form. Anyone with the link can read the CV.

