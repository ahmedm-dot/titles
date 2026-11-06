// Minimal Rocket.Chat REST client (auth via Personal Access Token).
// Docs: https://developer.rocket.chat/apidocs

export class RocketChat {
  constructor({ url, userId, token, maxCallsPerEndpoint = Infinity }) {
    this.url = url.replace(/\/+$/, '');
    this.maxCallsPerEndpoint = maxCallsPerEndpoint;
    this.headers = {
      'X-User-Id': userId,
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
    };
  }

  // Requests made so far; the sync stops before Cloudflare's per-run limit.
  calls = 0;
  // Requests per endpoint this run. Rocket.Chat rate-limits each endpoint per user
  // (by default 10 calls a minute), so the sync paces itself below that.
  perEndpoint = {};
  limited = new Set();

  canCall(path) {
    return !this.limited.has(path) && (this.perEndpoint[path] || 0) < this.maxCallsPerEndpoint;
  }

  async get(path, params = {}) {
    this.calls++;
    this.perEndpoint[path] = (this.perEndpoint[path] || 0) + 1;
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    let res;
    try {
      // Never wait forever on a slow or unreachable server.
      res = await fetch(`${this.url}/api/v1/${path}${qs ? `?${qs}` : ''}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? 'no answer within 20 s' : err.message;
      throw new Error(`${path} → ${this.url} not reachable (${why})`);
    }
    if (res.status === 429) {
      // Rate limited: stop using this endpoint for the rest of the run; the caller
      // keeps what it has and continues next run.
      this.limited.add(path);
      const err = new Error(`${path} → rate limited by Rocket.Chat`);
      err.rateLimited = true;
      throw err;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(`${path} → HTTP ${res.status}: ${body.error || body.message || 'unknown error'}`);
    }
    return body;
  }

  me() {
    return this.get('me');
  }

  // Subscriptions = your membership in each room (name, type, unread, thread unread).
  subscriptions(updatedSince) {
    return this.get('subscriptions.get', { updatedSince });
  }

  // Rooms carry `lm` (last message time), which tells us which rooms have new messages.
  rooms(updatedSince) {
    return this.get('rooms.get', { updatedSince });
  }

  // History endpoint depends on room type: c = channel, p = private group, d = DM.
  historyPath(room) {
    return `${{ c: 'channels', p: 'groups', d: 'im' }[room.t] || 'channels'}.history`;
  }

  history(room, oldest, latest, count = 100) {
    return this.get(this.historyPath(room), { roomId: room._id, oldest, latest, count });
  }

  // One message by id, used to title a thread card with its first message.
  message(msgId) {
    return this.get('chat.getMessage', { msgId }).then((r) => r.message);
  }

  messageLink(room, msgId) {
    if (room.t === 'd') return `${this.url}/direct/${room._id}?msg=${msgId}`;
    const kind = room.t === 'p' ? 'group' : 'channel';
    return `${this.url}/${kind}/${encodeURIComponent(room.name)}?msg=${msgId}`;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
