# Chat Tracker for Rocket.Chat

A small web app that keeps scanning your Rocket.Chat account and turns the
**conversations** that need you into cards on a board, with browser alerts.

- **One card per conversation, not per message:** a thread, a DM conversation
  (until 8 hours of silence) or a channel discussion that involves you (until 2 hours
  of silence). Every message in it stays on the card as context, your replies included.
- A card starts from an **@mention of you**, or from an **ask** (task, requirement, bug,
  question, urgent) in a DM, a thread you follow, or with a watched keyword. Small talk
  never makes a card.
- On Cloudflare, **Workers AI** gives each card a topic title and one line saying what
  is being asked of you. The keyword rules cover English and Arabic.
- When you reply, the card leaves Inbox: your high-priority work goes to **To do**,
  everything else to **Done**. A new ask in the same conversation reopens it, or marks
  it **new activity** if it is already in progress.
- Board columns: **Inbox → To do → Doing → Waiting on others → Done**, with drag and
  drop, notes, snooze, *Open in chat ↗* and **Mark all done** on the Inbox.
- Desktop notifications for new high-priority asks, reopened conversations and ended
  snoozes. The tab title shows the Inbox count.

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
Run the workflow by hand with **rebuild** ticked to re-scan chat with the current rules
(cards with your notes and cards you added yourself are kept).

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
- On the first run it scans the last `LOOKBACK_HOURS` (default 24).

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
