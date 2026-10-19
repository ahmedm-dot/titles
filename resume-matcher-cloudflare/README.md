# Resume Matcher on Cloudflare

Deploys [srbhr/Resume-Matcher](https://github.com/srbhr/Resume-Matcher) to
Cloudflare using **Workers + Containers**.

Resume Matcher is a Python FastAPI backend, a Next.js frontend and headless
Chromium (for PDF export). It can't run inside a plain V8 Worker. Instead, the
Worker here is a thin edge layer (optional auth, then routing) in front of a
Cloudflare Container that runs upstream's official Docker image unchanged.

```
browser ──▶ Worker (src/index.ts) ──▶ Container: ghcr.io/srbhr/resume-matcher
            basic auth (optional)      :3000 Next.js ──▶ :8000 FastAPI ──▶ LLM API
                                                                     └──▶ DATABASE_URL (Postgres)
```

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Containers needs it).
- Docker running locally. Wrangler builds the image and pushes it to Cloudflare's registry.
- Node 20 or later.
- An LLM API key (OpenAI, Anthropic, OpenRouter, Gemini, DeepSeek or Groq).
- **A hosted Postgres database** (Neon, Supabase, etc.), strongly recommended. See "Persistence".

## Deploy

```bash
cd resume-matcher-cloudflare
npm install
npx wrangler login

# Secrets
npx wrangler secret put LLM_API_KEY
npx wrangler secret put DATABASE_URL          # postgresql://user:pass@host:5432/db?sslmode=require
npx wrangler secret put BASIC_AUTH_PASSWORD   # gates the whole app (user: BASIC_AUTH_USER, default "admin")

npm run deploy
```

After the first deploy, set `FRONTEND_BASE_URL` in `wrangler.jsonc` to the URL
Wrangler printed (or to your custom domain), then run `npm run deploy` again.
The backend rejects any host it doesn't recognise (DNS-rebinding guard), and it
allows this one automatically.

The first request after a deploy, or after the container has slept, is a cold
start of roughly 20–40 seconds while the backend and frontend boot. Later
requests are fast. `SLEEP_AFTER` (default `30m`) controls how long the
container stays up after the last request.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `FRONTEND_BASE_URL` | var | Public URL. Required for the host guard and CORS. |
| `LLM_PROVIDER` | var | `openai`, `anthropic`, `openrouter`, `gemini`, `deepseek`, `groq`, `openai_compatible` |
| `LLM_MODEL` | var | Empty means the upstream default for the provider. |
| `LLM_API_KEY` | secret | Provider key. Prefer this to entering the key in the Settings UI (see below). |
| `LLM_API_BASE` | secret | Optional custom endpoint (`openai_compatible` / self-hosted). |
| `DATABASE_URL` | secret | Postgres connection string. |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | var / secret | Basic auth in front of the app. Auth is off when no password is set. |
| `SLEEP_AFTER` | var | Idle time before the container sleeps. |

## Persistence: read this before you rely on it

Cloudflare Containers have **ephemeral disk**. Anything written to
`/app/backend/data` is lost whenever the container sleeps, restarts or is
redeployed. That includes the default SQLite database and `data/.secret_key`.

- Set `DATABASE_URL` so resumes, jobs and cover letters live in Postgres.
- Give the LLM key as the `LLM_API_KEY` secret, **not** through the Settings
  page. Keys saved in the UI are encrypted with `data/.secret_key`, which is
  regenerated on every fresh container, so a saved key becomes unreadable
  after a restart.
- Without `DATABASE_URL` the app still runs, but all data vanishes on each
  cold start. That's only acceptable for a demo.

## Security

Resume Matcher is single-user and has no accounts. Anyone who can open the URL
can read every stored resume and spend your LLM credits. Keep
`BASIC_AUTH_PASSWORD` set, or put the Worker behind **Cloudflare Access**
(Zero Trust → Access → Applications) and remove the password. Access gives you
SSO and per-user allow lists.

## Pinning a version

The `Dockerfile` uses `ghcr.io/srbhr/resume-matcher:latest`. For reproducible
deploys, pin a release tag such as `:1.2.3` and bump it on purpose.

## Local run

`npm run dev` runs the Worker and the container locally through Docker
(`wrangler dev`), on http://localhost:8787. For local dev, set
`FRONTEND_BASE_URL` to `http://localhost:8787` in a `.dev.vars` file.
