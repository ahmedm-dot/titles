// PostHog read-only MCP connector for Claude, as a single Cloudflare Worker.
//
// No server access to PostHog needed: it calls the PostHog API with a
// read-only personal API key stored as a Worker secret. Claude reaches it at
//   https://<worker>.workers.dev/mcp/<ACCESS_TOKEN>
// where ACCESS_TOKEN is a long random string only your organization knows.
//
// Worker settings (Settings -> Variables and Secrets):
//   POSTHOG_URL      e.g. https://ph.infrozix.com   (text)
//   POSTHOG_PROJECT  e.g. 1                         (text)
//   POSTHOG_API_KEY  phx_...                        (secret)
//   ACCESS_TOKEN     long random string            (secret)

const SERVER_INFO = { name: 'posthog-infrozix', version: '1.0.0' }
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_RESULT_CHARS = 90000

const TOOLS = [
    {
        name: 'list_dashboards',
        description: 'List PostHog dashboards in the project, optionally filtered by name.',
        inputSchema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Text to match in the dashboard name' },
                limit: { type: 'integer', description: 'Max results (default 50)' },
            },
        },
    },
    {
        name: 'get_dashboard',
        description:
            'Get one dashboard with every insight on it: name, description, query definition and latest cached results.',
        inputSchema: {
            type: 'object',
            properties: { dashboard_id: { type: 'integer', description: 'Dashboard ID (the number in its URL)' } },
            required: ['dashboard_id'],
        },
    },
    {
        name: 'list_insights',
        description: 'List saved insights (charts, funnels, retention tables), optionally filtered by name.',
        inputSchema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Text to match in the insight name' },
                limit: { type: 'integer', description: 'Max results (default 50)' },
            },
        },
    },
    {
        name: 'get_insight',
        description:
            'Get one saved insight with its query definition and results. Accepts the numeric ID or the short ID from the insight URL (/insights/<short_id>).',
        inputSchema: {
            type: 'object',
            properties: {
                insight_id: { type: 'string', description: 'Numeric ID or short ID' },
                refresh: { type: 'boolean', description: 'Recalculate instead of using cached results' },
            },
            required: ['insight_id'],
        },
    },
    {
        name: 'list_events',
        description: 'List tracked event names (event definitions), optionally filtered by text.',
        inputSchema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Text to match in the event name' },
                limit: { type: 'integer', description: 'Max results (default 100)' },
            },
        },
    },
    {
        name: 'list_properties',
        description: 'List event or person property names, optionally filtered by text.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['event', 'person'], description: 'Property type (default event)' },
                search: { type: 'string', description: 'Text to match in the property name' },
                limit: { type: 'integer', description: 'Max results (default 100)' },
            },
        },
    },
    {
        name: 'run_sql',
        description:
            'Run a read-only HogQL (SQL) query against PostHog data, e.g. "select event, count() from events where timestamp > now() - interval 7 day group by event order by 2 desc limit 20". Tables include events, persons, sessions. Always use a LIMIT.',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'HogQL query' } },
            required: ['query'],
        },
    },
    {
        name: 'run_insight_query',
        description:
            'Run a PostHog insight query object (TrendsQuery, FunnelsQuery, RetentionQuery, LifecycleQuery, etc.) without saving it. Pass the same JSON shape as an insight\'s "query.source".',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'object', description: 'Query object with a "kind" field' } },
            required: ['query'],
        },
    },
]

export default {
    async fetch(request, env) {
        const url = new URL(request.url)
        const token = env.ACCESS_TOKEN || ''

        if (url.pathname === '/' || url.pathname === '/health') {
            return new Response('ok', { headers: { 'Content-Type': 'text/plain' } })
        }
        // Only the secret path is an MCP endpoint; everything else (including OAuth
        // discovery probes) is a plain 404 so Claude treats this as a no-login server.
        if (token.length < 24 || !safeEqual(url.pathname, `/mcp/${token}`)) {
            return new Response('Not found', { status: 404 })
        }
        if (request.method === 'GET' || request.method === 'DELETE') {
            return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } })
        }
        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 })
        }

        let body
        try {
            body = await request.json()
        } catch {
            return json(rpcError(null, -32700, 'Parse error'), 400)
        }

        if (Array.isArray(body)) {
            const replies = (await Promise.all(body.map((m) => handleMessage(m, env)))).filter(Boolean)
            return replies.length ? json(replies) : new Response(null, { status: 202 })
        }
        const reply = await handleMessage(body, env)
        return reply ? json(reply) : new Response(null, { status: 202 })
    },
}

async function handleMessage(msg, env) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return rpcError(msg?.id ?? null, -32600, 'Invalid request')
    }
    const isNotification = msg.id === undefined || msg.id === null
    if (isNotification) {
        return null
    }

    switch (msg.method) {
        case 'initialize': {
            const requested = msg.params?.protocolVersion
            return rpcResult(msg.id, {
                protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
                instructions:
                    `Read-only access to the PostHog instance ${env.POSTHOG_URL}, project ${env.POSTHOG_PROJECT}. ` +
                    'Start with list_dashboards / get_dashboard for existing reports, list_events to discover event names, ' +
                    'and run_sql for custom questions.',
            })
        }
        case 'ping':
            return rpcResult(msg.id, {})
        case 'tools/list':
            return rpcResult(msg.id, { tools: TOOLS })
        case 'tools/call': {
            const name = msg.params?.name
            const args = msg.params?.arguments || {}
            if (!TOOLS.some((t) => t.name === name)) {
                return rpcError(msg.id, -32602, `Unknown tool: ${name}`)
            }
            try {
                const result = await callTool(name, args, env)
                return rpcResult(msg.id, { content: [{ type: 'text', text: truncate(result) }] })
            } catch (err) {
                return rpcResult(msg.id, { content: [{ type: 'text', text: String(err.message || err) }], isError: true })
            }
        }
        case 'resources/list':
            return rpcResult(msg.id, { resources: [] })
        case 'prompts/list':
            return rpcResult(msg.id, { prompts: [] })
        default:
            return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
    }
}

async function callTool(name, args, env) {
    const p = `/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT)}`
    const limit = clampInt(args.limit, name.startsWith('list_events') || name === 'list_properties' ? 100 : 50)

    switch (name) {
        case 'list_dashboards': {
            const d = await ph(env, `${p}/dashboards/`, { limit: args.search ? 500 : limit, search: args.search })
            return (d.results || [])
                .filter((x) => !x.deleted)
                .filter((x) => !args.search || (x.name || '').toLowerCase().includes(args.search.toLowerCase()))
                .map((x) => ({ id: x.id, name: x.name, description: x.description || undefined, pinned: x.pinned }))
        }
        case 'get_dashboard': {
            const d = await ph(env, `${p}/dashboards/${clampInt(args.dashboard_id, 0)}/`)
            return {
                id: d.id,
                name: d.name,
                description: d.description || undefined,
                url: `${env.POSTHOG_URL}/project/${env.POSTHOG_PROJECT}/dashboard/${d.id}`,
                tiles: (d.tiles || [])
                    .filter((t) => !t.deleted)
                    .map((t) => (t.insight ? summarizeInsight(t.insight, env) : t.text ? { text: t.text.body } : null))
                    .filter(Boolean),
            }
        }
        case 'list_insights': {
            const d = await ph(env, `${p}/insights/`, { limit, search: args.search, saved: 'true', basic: 'true' })
            return (d.results || []).map((x) => ({
                id: x.id,
                short_id: x.short_id,
                name: x.name || x.derived_name,
                description: x.description || undefined,
                last_modified_at: x.last_modified_at,
            }))
        }
        case 'get_insight': {
            const id = String(args.insight_id || '').trim()
            if (!id) throw new Error('insight_id is required')
            const refresh = args.refresh ? 'blocking' : undefined
            let insight
            if (/^\d+$/.test(id)) {
                insight = await ph(env, `${p}/insights/${id}/`, { refresh })
            } else {
                const d = await ph(env, `${p}/insights/`, { short_id: id, refresh })
                insight = (d.results || [])[0]
                if (!insight) throw new Error(`No insight with short ID ${id}`)
            }
            return summarizeInsight(insight, env)
        }
        case 'list_events': {
            const d = await ph(env, `${p}/event_definitions/`, { limit, search: args.search })
            return (d.results || []).map((x) => ({ name: x.name, last_seen_at: x.last_seen_at || undefined }))
        }
        case 'list_properties': {
            const type = args.type === 'person' ? 'person' : 'event'
            const d = await ph(env, `${p}/property_definitions/`, { limit, search: args.search, type })
            return (d.results || []).map((x) => ({ name: x.name, property_type: x.property_type || undefined }))
        }
        case 'run_sql': {
            if (!args.query || typeof args.query !== 'string') throw new Error('query is required')
            const r = await ph(env, `${p}/query/`, null, { query: { kind: 'HogQLQuery', query: args.query } })
            return { columns: r.columns, rows: r.results, hasMore: r.hasMore || undefined }
        }
        case 'run_insight_query': {
            if (!args.query || typeof args.query !== 'object' || !args.query.kind) {
                throw new Error('query must be an object with a "kind" field')
            }
            const r = await ph(env, `${p}/query/`, null, { query: args.query })
            return compactResult(r.results ?? r.result ?? r)
        }
    }
    throw new Error(`Unhandled tool ${name}`)
}

function summarizeInsight(i, env) {
    return {
        id: i.id,
        short_id: i.short_id,
        name: i.name || i.derived_name,
        description: i.description || undefined,
        url: i.short_id ? `${env.POSTHOG_URL}/project/${env.POSTHOG_PROJECT}/insights/${i.short_id}` : undefined,
        last_refresh: i.last_refresh || undefined,
        query: i.query?.source || i.query || i.filters || undefined,
        result: compactResult(i.result),
    }
}

// Drops bulky fields PostHog repeats on every series so results fit in Claude's context.
function compactResult(result) {
    if (!result) return result
    const DROP = new Set(['filter', 'action', 'persons_urls', 'people', 'persons', 'days', 'people_url', 'converted_people_url', 'dropped_people_url'])
    const walk = (v, depth) => {
        if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
        if (v && typeof v === 'object') {
            const out = {}
            for (const [k, val] of Object.entries(v)) {
                if (!DROP.has(k)) out[k] = walk(val, depth + 1)
            }
            return out
        }
        return v
    }
    return walk(result, 0)
}

async function ph(env, path, params, body) {
    if (!env.POSTHOG_URL || !env.POSTHOG_PROJECT || !env.POSTHOG_API_KEY) {
        throw new Error('Connector is not configured: set POSTHOG_URL, POSTHOG_PROJECT and POSTHOG_API_KEY on the Worker.')
    }
    const url = new URL(env.POSTHOG_URL.replace(/\/$/, '') + path)
    for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: {
            Authorization: `Bearer ${env.POSTHOG_API_KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
        let detail = text.slice(0, 500)
        try {
            detail = JSON.parse(text).detail || detail
        } catch {}
        if (res.status === 403) {
            detail += ' (the PostHog API key is missing a read scope for this; see the setup guide)'
        }
        throw new Error(`PostHog API ${res.status}: ${detail}`)
    }
    return JSON.parse(text)
}

function truncate(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > MAX_RESULT_CHARS
        ? text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated ${text.length - MAX_RESULT_CHARS} chars; narrow the request]`
        : text
}

function clampInt(v, fallback) {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : fallback
}

function safeEqual(a, b) {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
