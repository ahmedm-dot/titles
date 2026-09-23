# Connect PostHog to Claude Enterprise, no developer needed

This sets up a small, free connector on Cloudflare that lets Claude read your
PostHog data (`https://ph.infrozix.com`, project 1). You don't need access to
the PostHog server. It takes about 15 minutes in a web browser, and you never
open a terminal.

Once it's done, anyone in your Claude organization can ask things like
"Summarize dashboard 1" or "How many resumes were created per day last week?"

**What Claude can do through it (read-only):** list and open dashboards and
insights, list events and properties, run SQL (HogQL) queries, and run trend,
funnel or retention queries. It can't change anything in PostHog.

---

## You'll need

- A PostHog login on `ph.infrozix.com` (you already have one).
- A free Cloudflare account. Sign up at https://dash.cloudflare.com/sign-up.
- The file `worker.js` from this folder.
- Admin access to your Claude Enterprise organization, or the name of whoever
  has it, for step 4.

---

## Step 1: Create a read-only PostHog key

1. Open https://ph.infrozix.com/settings/user-api-keys.
2. Click **Create personal API key**.
3. **Label:** `Claude connector (read-only)`
4. **Organization & project access:** choose only project **1**.
5. **Scopes:** set these to **Read** and leave everything else as No access:
   - Dashboard
   - Insight
   - Query
   - Event definition
   - Property definition
   - Project (if listed)
6. Click **Create key** and copy the key (it starts with `phx_`). Keep this tab
   open because you'll paste the key in step 3.

> The key you pasted in the earlier chat should be deleted on this same page.
> Create this new one in its place.

## Step 2: Create the Worker on Cloudflare

1. Log in at https://dash.cloudflare.com.
2. In the left menu, open **Workers & Pages** (under *Compute*), then click
   **Create** and choose **Start with Hello World** (or **Create Worker**).
3. **Name:** `posthog-mcp`. Click **Deploy**.
4. Click **Edit code**.
5. Delete everything in the editor. Open `worker.js` from this folder, copy
   **all** of it, and paste it in.
6. Click **Deploy** (top right).

## Step 3: Add the settings

1. Go back to the Worker's page and open **Settings → Variables and Secrets**.
2. Click **Add** four times:

   | Type | Name | Value |
   |---|---|---|
   | Text | `POSTHOG_URL` | `https://ph.infrozix.com` |
   | Text | `POSTHOG_PROJECT` | `1` |
   | Secret | `POSTHOG_API_KEY` | the `phx_...` key from step 1 |
   | Secret | `ACCESS_TOKEN` | a random password of **at least 32 letters and numbers** (from a password generator; no spaces or symbols) |

3. Click **Deploy** to save.
4. Your connector's address is:

   ```
   https://posthog-mcp.<your-subdomain>.workers.dev/mcp/<ACCESS_TOKEN>
   ```

   Find the first part (`https://posthog-mcp....workers.dev`) at the top of the
   Worker's page. Add `/mcp/` and your ACCESS_TOKEN to the end.

   **Treat this full address like a password.** Anyone who has it can read
   your PostHog data through the connector.

5. Quick check: open `https://posthog-mcp.<your-subdomain>.workers.dev/health`
   in your browser. It should say `ok`.

## Step 4: Add it to Claude Enterprise

This step needs a Claude organization **Owner**. If that isn't you, send them
the address from step 3 privately, along with these steps.

1. In Claude, open **Admin settings → Connectors**.
2. Click **Add custom connector**.
3. **Name:** `PostHog (Infrozix)`
4. **Remote MCP server URL:** the full address from step 3.
5. Leave the **Advanced settings** (OAuth) empty and click **Add**.

## Step 5: Use it

1. Each person opens **Settings → Connectors**, finds **PostHog (Infrozix)**,
   and clicks **Connect**. No login is needed.
2. In a chat, click the tools button (＋ or the sliders icon) and switch
   **PostHog (Infrozix)** on.
3. Try:
   - "Get dashboard 1 and summarize each insight."
   - "List our insights about Auto Apply."
   - "How many unique users triggered Resume Created each day for the last 14 days?"

---

## Troubleshooting

| What you see | Fix |
|---|---|
| Claude says it can't connect | Check the address ends with `/mcp/` plus your exact ACCESS_TOKEN, with no trailing slash or space. |
| `/health` doesn't say `ok` | The code wasn't deployed. Repeat step 2, parts 4–6. |
| "Connector is not configured" | A setting from step 3 is missing or misspelled (names are case-sensitive). Click **Deploy** after adding them. |
| "PostHog API 401" | The API key is wrong or was deleted. Create a new one (step 1) and replace `POSTHOG_API_KEY`. |
| "PostHog API 403 … missing a read scope" | Edit the key in PostHog and add the Read scope named in the error. |

## If the address leaks

On the Worker's page, go to **Settings → Variables and Secrets**, change
`ACCESS_TOKEN` to a new random value, and click **Deploy**. Then update the
URL in Claude's Admin settings → Connectors. The old address stops working
immediately.

## Why this approach

PostHog's official connector only supports PostHog Cloud. The full self-hosted
setup (see `../README.md`) needs a PostHog upgrade and server work from
developers. This Worker needs neither: it talks to PostHog's normal API with
one read-only key. The trade-off is that everyone uses that one key's access
instead of their own PostHog account, which is why the key is read-only and
limited to project 1.
