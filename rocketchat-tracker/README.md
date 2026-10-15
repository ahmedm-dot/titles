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

No dependencies, no build step. Needs Node 20.12+ (`node --version`).

## Setup

1. Rocket.Chat → avatar → **Profile → Personal Access Tokens** → create one.
   Copy the **token** and **user ID** (they are shown only once).
2. In this folder:
   ```bash
   cp .env.example .env     # then paste RC_USER_ID and RC_TOKEN into .env
   npm start                # or: node server.js
   ```
3. Open http://localhost:3000 and click **Enable alerts**.

`.env` and `data/` are git-ignored, so the token and your cards never get committed.

## Get a link you can open anywhere (Render, free)

1. Go to https://render.com, sign in with GitHub, then **New → Blueprint** and pick
   this repo and branch. It reads `render.yaml` at the repo root.
2. Fill in `RC_USER_ID`, `RC_TOKEN` and `BOARD_PASSWORD` (8+ characters) when asked.
3. Open the `https://chat-tracker-xxxx.onrender.com` link. The browser asks for the
   password; any username works.

Free plan notes: the service sleeps after about 15 minutes with no visitors and
wakes when you open the link. The disk is temporary, so board moves and notes
reset on a redeploy, while the cards themselves come back from the chat history
(`LOOKBACK_HOURS`). For always-on polling and kept notes, use a paid instance
with a persistent disk mounted at `rocketchat-tracker/data`.

## How it works

```
Rocket.Chat REST API  ──(every POLL_SECONDS)──►  server.js  ──SSE──►  browser board
  rooms.get?updatedSince     → which rooms have new messages
  subscriptions.get          → room names, followed threads with unread replies
  channels|groups|im.history → new messages since the last check, per room
                                   │
                         lib/classify.js (rules) → cards → data/state.json
```

- The token stays on the server and is never sent to the browser.
- By default the server listens on `127.0.0.1` only. To open it to the network
  (`HOST=0.0.0.0`), you must set `BOARD_PASSWORD`; the server refuses to start
  without one.
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
