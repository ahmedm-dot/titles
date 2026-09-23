# PostHog MCP connector for Claude Enterprise (self-hosted PostHog)

> **No developer or server access?** Pick one of these instead. Both run on a
> free Cloudflare Worker, are set up in a browser, and use one read-only
> PostHog API key:
>
> - [`official/`](official/README.md) (**recommended**): PostHog's official
>   MCP server with a small tweak. It has the full set of read tools and is
>   deployed from GitHub by Cloudflare.
> - [`worker/`](worker/README.md): a minimal single-file connector (8 tools)
>   you paste into Cloudflare's editor.
>
> The rest of this page is the per-user-login setup, which needs PostHog
> server changes.

Connects the organization's Claude Enterprise account to the self-hosted
PostHog instance at `https://ph.infrozix.com`. Claude's built-in PostHog
connector only works with PostHog Cloud, so this kit deploys PostHog's own MCP
server next to your instance and gives you the steps to add it as an
organization-wide custom connector.

```
Claude (claude.ai / Desktop / mobile)
   │  HTTPS, OAuth bearer token per user
   ▼
https://mcp.infrozix.com/mcp      ← this kit: Caddy (TLS) → posthog-mcp → Redis
   │  PostHog API, same token
   ▼
https://ph.infrozix.com           ← your PostHog: login page + OAuth server + API
```

Each person signs in with their own PostHog account, and Claude only sees what
that person can see in PostHog. No shared API key is stored anywhere.

## Current status of ph.infrozix.com

`./scripts/check.sh` was run against the instance on 2026-09-23:

| Check | Result |
|---|---|
| Instance reachable (`/_health`) | ✅ |
| OpenID discovery document | ✅ served |
| OAuth issuer uses https | ❌ reports `http://ph.infrozix.com` |
| RFC 8414 metadata (`/.well-known/oauth-authorization-server`) | ❌ redirects to `/login` |
| Dynamic client registration (`/oauth/register/`) | ❌ rejected with a CSRF error |
| MCP server at `mcp.infrozix.com` | ❌ not deployed yet |

The three PostHog failures mean the instance is running a PostHog version
older than the MCP login flow needs. Fix them in step 1 before adding the
connector, or Claude's "Connect" button will fail.

## Step 1: Prepare PostHog (server admin)

1. **Upgrade PostHog** to a current release. Recent versions serve
   `/.well-known/oauth-authorization-server` and accept dynamic client
   registration at `/oauth/register/`. Claude uses both to register itself and
   sign users in.
2. **Make PostHog report https URLs.** Set these on the PostHog web and worker
   containers:
   ```
   SITE_URL=https://ph.infrozix.com
   IS_BEHIND_PROXY=true
   ```
   Make sure your load balancer or reverse proxy sends
   `X-Forwarded-Proto: https`.
3. Run `./scripts/check.sh`. The three PostHog rows should pass.

If you can't upgrade yet, see **Option B** at the end.

## Step 2: Deploy the MCP server

You need a Linux host with Docker, ports 80 and 443 open to the internet, and a
DNS record `mcp.infrozix.com` pointing at it.

```bash
cd posthog-mcp
cp .env.example .env        # adjust MCP_DOMAIN if needed
docker compose up -d
docker compose logs -f mcp  # wait for "[MCP] Server started on 0.0.0.0:3001"
./scripts/check.sh          # every row should pass
```

Notes:
- The image is `ghcr.io/posthog/posthog-mcp`, which PostHog builds from
  `services/mcp/Dockerfile` in their monorepo. Once it works, pin
  `MCP_IMAGE_TAG` to a `sha-xxxxxxx` tag so updates don't catch you off guard.
- If the MCP host sits on the same private network as PostHog, you can point
  `POSTHOG_API_BASE_URL` at the internal address. `POSTHOG_PUBLIC_URL` must
  stay the public https URL, because users' browsers are sent there to log in.
- Caddy gets a Let's Encrypt certificate automatically and blocks `/metrics`.
- To test with a personal API key before the OAuth side is ready:
  `MCP_TEST_KEY=phx_... ./scripts/check.sh`

## Step 3: Add the connector in Claude Enterprise (org owner)

1. In Claude, open **Admin settings → Connectors**.
2. Click **Add custom connector** and fill in:
   - **Name:** `PostHog (Infrozix)`
   - **Remote MCP server URL:** `https://mcp.infrozix.com/mcp`
   - Leave the OAuth client ID and secret empty. Claude registers itself with
     PostHog automatically.
3. Save. The connector now shows up for everyone in the organization.

## Step 4: Each member connects

1. Go to **Settings → Connectors → PostHog (Infrozix) → Connect**.
2. Log in to `ph.infrozix.com` in the window that opens and approve access.
   For read-only use, approve only the read scopes.
3. In a chat, enable the connector from the tools menu and ask, for example:
   "Get dashboard 1 in project 1 and summarize each insight."

## Option B: stay on the current PostHog version for now

- **Individuals in Claude Code or Claude Desktop** can use the MCP server from
  step 2 with their own personal API key, without OAuth:
  ```json
  {
    "mcpServers": {
      "posthog-infrozix": {
        "command": "npx",
        "args": ["-y", "mcp-remote@latest", "https://mcp.infrozix.com/mcp",
                 "--header", "Authorization:${POSTHOG_AUTH_HEADER}"],
        "env": { "POSTHOG_AUTH_HEADER": "Bearer phx_YOUR_KEY" }
      }
    }
  }
  ```
  The key needs read access to dashboards, insights and queries
  (`dashboard:read`, `insight:read`, `query:read`) on project 1.
- **Org-wide without dynamic registration:** register an OAuth application by
  hand in PostHog (Django admin → OAuth applications) with redirect URI
  `https://claude.ai/api/mcp/auth_callback`, authorization-code grant and PKCE.
  Then enter its client ID and secret in the connector's **Advanced settings**
  in step 3. This still needs the https issuer from step 1.2, and whether it
  works depends on how far behind your PostHog version is. Upgrading is the
  reliable fix.

## Security notes

- Don't paste API keys into chats or commit them. `.env` is git-ignored.
- Revoke any key that has been shared in a chat and issue a new one.
- Tokens issued through the connector follow each user's PostHog permissions
  and can be revoked in PostHog under connected apps.
