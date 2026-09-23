#!/usr/bin/env bash
# Verifies everything Claude needs to connect to the self-hosted PostHog MCP
# server as a custom connector. Read-only: it creates nothing on either host.
#
#   POSTHOG_URL=https://ph.infrozix.com MCP_URL=https://mcp.infrozix.com/mcp ./scripts/check.sh
#
# Optional: MCP_TEST_KEY=phx_... also runs an authenticated MCP initialize.
set -uo pipefail

POSTHOG_URL="${POSTHOG_URL:-https://ph.infrozix.com}"
MCP_URL="${MCP_URL:-https://mcp.infrozix.com/mcp}"
MCP_ORIGIN="$(printf '%s' "$MCP_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
fails=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n       -> %s\n' "$1" "$2"; fails=$((fails + 1)); }

echo "PostHog instance: $POSTHOG_URL"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$POSTHOG_URL/_health")
[ "$code" = 200 ] && pass "instance is up" || fail "instance is up (got $code)" "check $POSTHOG_URL is reachable from the internet"

issuer=$(curl -s --max-time 20 "$POSTHOG_URL/.well-known/openid-configuration" |
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("issuer",""))' 2>/dev/null)
case "$issuer" in
    https://*) pass "OAuth issuer is https ($issuer)" ;;
    "") fail "OpenID discovery document" "upgrade PostHog to a version with the OAuth provider" ;;
    *) fail "OAuth issuer is https (got $issuer)" "set IS_BEHIND_PROXY=true and SITE_URL=$POSTHOG_URL on PostHog, and make the proxy send X-Forwarded-Proto: https" ;;
esac

meta=$(curl -s --max-time 20 "$POSTHOG_URL/.well-known/oauth-authorization-server")
if printf '%s' "$meta" | python3 -c 'import sys,json; json.load(sys.stdin)["token_endpoint"]' >/dev/null 2>&1; then
    pass "RFC 8414 authorization server metadata"
else
    fail "RFC 8414 authorization server metadata" "not served (redirects to /login): upgrade PostHog"
fi

# An empty body is rejected as invalid (400 JSON) when registration works, and
# never creates a client. A 403 CSRF page means registration is unavailable.
reg=$(curl -s -w '\n%{http_code}' --max-time 20 -X POST -H 'Content-Type: application/json' -d '{}' "$POSTHOG_URL/oauth/register/")
reg_code=$(printf '%s' "$reg" | tail -n1)
if [ "$reg_code" = 403 ] && printf '%s' "$reg" | grep -q CSRF; then
    fail "dynamic client registration" "blocked by CSRF: upgrade PostHog, or register an OAuth app by hand (README, option B)"
elif [ "$reg_code" = 400 ] || [ "$reg_code" = 201 ]; then
    pass "dynamic client registration"
else
    fail "dynamic client registration (got $reg_code)" "see README, option B"
fi

echo "MCP server: $MCP_URL"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$MCP_ORIGIN/healthz")
[ "$code" = 200 ] && pass "server is up" || fail "server is up (got $code)" "docker compose ps / docker compose logs mcp caddy"

hdr=$(curl -s -o /dev/null -D - --max-time 20 -X POST "$MCP_URL" | tr -d '\r')
if printf '%s' "$hdr" | grep -qi '^www-authenticate:.*resource_metadata'; then
    pass "unauthenticated /mcp returns 401 with resource_metadata"
else
    fail "unauthenticated /mcp returns 401 with resource_metadata" "check the reverse proxy forwards /mcp to the mcp container"
fi

as=$(curl -s --max-time 20 "$MCP_ORIGIN/.well-known/oauth-protected-resource/mcp" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["authorization_servers"][0])' 2>/dev/null)
if [ "${as%/}" = "${POSTHOG_URL%/}" ]; then
    pass "authorization server is $as"
else
    fail "authorization server is $POSTHOG_URL (got ${as:-nothing})" "set POSTHOG_PUBLIC_URL=$POSTHOG_URL in .env and restart"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$MCP_ORIGIN/metrics")
case "$code" in
    401 | 403 | 404) pass "/metrics is not public" ;;
    200) fail "/metrics is not public" "use the provided Caddyfile" ;;
    *) fail "/metrics is not public (got $code)" "server unreachable" ;;
esac

if [ -n "${MCP_TEST_KEY:-}" ]; then
    body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check.sh","version":"1"}}}'
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$MCP_URL" \
        -H "Authorization: Bearer $MCP_TEST_KEY" -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' -d "$body")
    [ "$code" = 200 ] && pass "authenticated initialize" || fail "authenticated initialize (got $code)" "check the key is valid and scoped to the project"
fi

echo
[ "$fails" = 0 ] && echo "All checks passed. Add the connector in Claude (README, step 3)." || echo "$fails check(s) failed."
exit "$fails"
