# Official PostHog MCP server, tweaked for Claude Enterprise + self-hosted PostHog

This is PostHog's official MCP server (`github.com/PostHog/mcp`, MIT licence,
last upstream commit `13aaf2c`, January 2026), set up to run on a free
Cloudflare Worker and read from `https://ph.infrozix.com`.

You don't need a developer or access to the PostHog server. Cloudflare builds
and deploys it straight from this GitHub repo, all in the browser.

## What was changed from upstream (and nothing else)

| File | Change | Why |
|---|---|---|
| `typescript/src/integrations/mcp/index.ts` | When the `ACCESS_TOKEN` secret is set, the server accepts requests at `/mcp/<ACCESS_TOKEN>` and uses the `POSTHOG_API_KEY` secret. Any other path returns 404. | Claude Enterprise connectors can't send an API-key header, and our PostHog is too old for the OAuth login. Without `ACCESS_TOKEN`, upstream header auth works as before. |
| `typescript/src/integrations/mcp/utils/client.ts` | Telemetry turned into a no-op. | Upstream sends every tool call, **including its inputs, outputs and errors**, to PostHog Inc.'s US cloud as usage analytics. That would copy our data off our own server. |
| `typescript/src/integrations/mcp/index.ts` | `/status` page showing whether each secret is set (true/false only, never values). | Lets a non-developer confirm the Cloudflare settings. |
| `typescript/wrangler.jsonc` | Worker name `posthog-mcp`, `POSTHOG_BASE_URL=https://ph.infrozix.com`. | Point at our instance. |
| `typescript/worker-configuration.d.ts` | Added types for the two secrets. | Build. |

Every tool, API call and response format is upstream's. The server only lists
tools the API key has scopes for, so with a read-only key Claude gets only
read tools.

**Tools available with a read-only key:** dashboards (list, get), insights
(list, get, run query), SQL / HogQL queries, events and properties lists,
projects and organization info, and, if you grant those scopes, feature
flags, experiments and results, surveys and stats, and error tracking.

Verified here: installs from the lockfile, passes the type check, bundles with
`wrangler deploy --dry-run` (216 KB gzipped), rejects wrong or missing tokens
with 404, and on a correct token loads the stored key and calls PostHog.

Live-tested on 2026-09-23 against ph.infrozix.com (local Worker runtime, no
code changes needed). These read tools all returned real data: projects,
organization details, dashboards (list, get), insights (list, get, run saved
insight), `query-run` (HogQL and Trends), event definitions, event and person
properties, feature flags, experiments, surveys (list, get, stats), error
tracking and LLM costs. Known limit: `query-generate-hogql-from-question`
returns `ai/failure` because it needs PostHog AI, which isn't set up on our
instance. Claude can still write HogQL itself and run it with `query-run`.
No request goes to PostHog's cloud: `POSTHOG_BASE_URL` skips upstream's
US/EU region lookup, and telemetry is a no-op.

The server shows Claude exactly the tools the key's scopes allow. A key with
any **Write** scope also gets create, update and delete tools for that area,
so give only Read scopes (step 1 below).

---

## Setup (browser only, about 20 minutes)

### 1. Create a read-only PostHog key

1. Open https://ph.infrozix.com/settings/user-api-keys → **Create personal API key**.
2. **Label:** `Claude connector (read-only)`.
3. **Access:** project **1** only.
4. **Scopes:** set these to **Read**:
   User, Organization, Project, Dashboard, Insight, Query, Event definition,
   Property definition. Optionally also Feature flag, Experiment, Survey and
   Error tracking. Give no Write scopes.
5. Create the key and copy it (`phx_...`). Also delete the key that was pasted
   into chat earlier.

### 2. Deploy from GitHub with Cloudflare

1. Sign in at https://dash.cloudflare.com (a free account is fine).
2. Go to **Workers & Pages** → **Create** → **Import a repository**
   (sometimes shown as **Connect to Git**).
3. Connect GitHub when asked and allow access to **ahmedm-dot/titles**.
4. Fill in:
   - **Project / Worker name:** `posthog-mcp` (must match exactly)
   - **Branch:** the branch this folder is on (`claude/bold-carson-s0i7ux`,
     or `main` once it's merged)
   - **Root directory / Path:** `posthog-mcp/official/typescript`
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
5. Click **Deploy** and wait for the build to finish (about 1–2 minutes).

### 3. Add the two secrets

1. Open the `posthog-mcp` Worker → **Settings → Variables and Secrets** → **Add**:

   | Type | Name | Value |
   |---|---|---|
   | Secret | `POSTHOG_API_KEY` | the `phx_...` key from step 1 |
   | Secret | `ACCESS_TOKEN` | a random string of at least 32 letters and numbers |

2. Click **Deploy** / **Save**. Don't add `POSTHOG_BASE_URL` here, because it's
   already in the code.

Your connector address is:

```
https://posthog-mcp.<your-subdomain>.workers.dev/mcp/<ACCESS_TOKEN>
```

Treat it like a password.

### 4. Add it to Claude Enterprise (organization Owner)

**Admin settings → Connectors → Add custom connector**

- **Name:** `PostHog (Infrozix)`
- **URL:** the address above
- **Advanced settings (OAuth):** leave empty

### 5. Use it

Each person goes to **Settings → Connectors → PostHog (Infrozix) → Connect**
(no login), switches it on in a chat, and asks, for example:

- "List our dashboards and summarize dashboard 1."
- "Run a query: unique users with Resume Created per day, last 14 days."
- "Show the results of the Auto Apply offer experiment."

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with a message about the Worker name | The name in step 2 must be `posthog-mcp`. |
| Build fails with "root directory not found" | Cloudflare built the repo's default branch, which doesn't have this folder. In the Worker, go to **Settings → Build → Branch control**, set **Production branch** to this folder's branch, then push a commit or start a new build. **Retry build** reuses the old branch. |
| Claude can't connect, or "No token provided" | Open `https://posthog-mcp.<your-subdomain>.workers.dev/status`. Every `_set` value must be `true`. If one is `false`, add it under **Settings → Variables and Secrets** (runtime secrets, not **Build** variables) and click **Deploy**. If `/status` shows 404, Cloudflare is building an old commit or the wrong branch. |
| Claude can't connect / 404 | Check the URL ends with `/mcp/` plus the exact ACCESS_TOKEN. |
| "POSTHOG_API_KEY is not set" | Add the secret (step 3) and deploy again. |
| "Failed to get API key … 401" | The key is wrong or deleted. Create a new one. |
| A tool is missing | The key lacks that Read scope. Edit the key in PostHog. |
| "API key has access to multiple projects" | Limit the key to project 1 only. |

**If the address leaks:** change `ACCESS_TOKEN` in the Worker settings, then
update the URL in Claude's Admin settings. The old address stops working
immediately.

## Updating from upstream

PostHog has since moved active development of the server into its main repo
(`PostHog/posthog`, `services/mcp`). That newer version needs a Node.js server
and Redis and can't run on a Worker by itself. This folder tracks the last
Worker-native release. To pick up fixes, copy newer upstream files over this
folder and re-apply the four changes in the table above.
