# Chat Tracker for Rocket.Chat

A small web app that keeps scanning your Rocket.Chat account and turns what
needs you into cards on a board, with browser alerts:

- **@mentions** of you, **DMs**, **replies in threads you follow**, and
  `@all` / `@here` (optional)
- **Keyword hits** from any room (`WATCH_KEYWORDS`, e.g. `requirement, blocker, ats`)
- Each card gets a **type** (task / requirement / bug / question / fyi), a
  **priority** (high / medium / low) and an **urgent** flag. The keyword rules
  cover English and Arabic.
- Board columns: **Inbox → To do → Doing → Waiting on others → Done**, with
  drag and drop, notes, snooze (1h / 3h / tomorrow / Monday) and *Open in chat ↗*
- Several messages from the same person in a row (within 30 min) merge into one card
- When you reply in the chat, the card shows **✓ replied**. Questions and FYIs
  you answered move to Done automatically.
- Desktop notifications for high-priority items and when a snooze ends. The
  tab title shows the Inbox count.

No dependencies, no build step. Run it on your computer (Node 20.12+), or host it
on Cloudflare to get a link that works anywhere (see below).

## Run it on your computer

1. Rocket.Chat → avatar → **Profile → Personal Access Tokens** → create one.
   Copy the **token** and **user ID** (they are shown only once).
2. In this folder:
   ```bash
   cp .env.example .env     # then paste RC_USER_ID and RC_TOKEN into .env
   npm start                # or: node server.js
   ```
3. Open http://localhost:3000 and click **Enable alerts**.

`.env` and `data/` are git-ignored, so the token and your cards never get committed.

## Host it on Cloudflare (free, a link you can open anywhere)

Runs as a Cloudflare Worker: a Cron Trigger syncs Rocket.Chat **every minute even when
the board is closed**, D1 keeps your cards and notes, and the board is protected by a
password. Everything fits in the free plan.

You need a free Cloudflare account and Node 20+ on your computer. From this folder:

```bash
npx wrangler login                          # opens the browser to sign in to Cloudflare
npx wrangler d1 create chat-tracker         # prints a database_id
#   → paste that id into wrangler.toml, replacing REPLACE_WITH_YOUR_D1_DATABASE_ID
npx wrangler secret put RC_USER_ID          # paste your Rocket.Chat user ID
npx wrangler secret put RC_TOKEN            # paste your Personal Access Token
npx wrangler secret put BOARD_PASSWORD      # choose a password, 8+ characters
npx wrangler deploy                         # prints https://chat-tracker.<you>.workers.dev
```

Open the printed link. The browser asks for the password; any username works. The
tables are created automatically on the first run. Other settings (keywords, muted rooms)
live under `[vars]` in `wrangler.toml`; run `npx wrangler deploy` again after changing them.

**Or deploy from GitHub, with nothing to install:** add the repository secrets
`CLOUDFLARE_API_TOKEN`, `RC_USER_ID`, `RC_TOKEN` and
`BOARD_PASSWORD` (Settings → Secrets and variables → Actions). The
*Deploy Chat Tracker* workflow then creates the database, sets the Worker's secrets
and deploys on every push to `rocketchat-tracker/`. The link is in the run summary.

Notes:
- **If Rocket.Chat is behind Cloudflare with Bot Fight Mode or a WAF**, allow the
  Worker's requests to `/api/v1/*`, or the sync shows an error on the board.
- Free plan limit: 50 outbound requests per run. A busy first sync is spread over the
  next few minutes, and the board shows "catching up on N rooms" meanwhile.
- Logs: `npx wrangler tail`.
- Instead of the password you can put the link behind Cloudflare Access (Zero Trust,
  free for up to 50 users) for Google or email sign-in.

## How it works

```
Rocket.Chat REST API ──(every minute)──► server.js or worker.js ──(every 20 s)──► board
  rooms.get?updatedSince     → which rooms have new messages
  subscriptions.get          → room names, followed threads with unread replies
  channels|groups|im.history → new messages since the last check, per room
                                   │
           lib/tracker.js + lib/classify.js (rules) → cards → data/state.json or D1
```

- The token stays on the server and is never sent to the browser.
- The local server listens on `127.0.0.1` only. To open it to the network
  (`HOST=0.0.0.0`), you must set `BOARD_PASSWORD`; the server refuses to start
  without one. The Cloudflare Worker always requires `BOARD_PASSWORD`.
- On the first run it scans the last `LOOKBACK_HOURS` (default 48).

## Tuning

| Setting | What it does |
|---|---|
| `WATCH_KEYWORDS` | Words that create a card from any room even without a mention |
| `MUTED_ROOMS` | Rooms skipped for keyword matching (mentions and DMs still count) |
| `INCLUDE_GROUP_MENTIONS` | `false` to ignore `@all` / `@here` |
| `POLL_SECONDS` | How often to check (minimum 15) |

The type and urgency keyword lists are at the top of `lib/classify.js`.

## Next ideas

- AI extraction (title / owner / due date) for messages the rules can't classify
- Daily 9:00 digest (open asks, overdue, new requirements)
- "Send to Jira / ClickUp" button on a card
