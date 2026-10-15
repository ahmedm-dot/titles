// Minimal Rocket.Chat REST client (auth via Personal Access Token).
// Docs: https://developer.rocket.chat/apidocs

export class RocketChat {
  constructor({ url, userId, token }) {
    this.url = url.replace(/\/+$/, '');
    this.headers = {
      'X-User-Id': userId,
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
    };
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    const res = await fetch(`${this.url}/api/v1/${path}${qs ? `?${qs}` : ''}`, {
      headers: this.headers,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('x-ratelimit-reset')) - Date.now();
      await sleep(Math.min(Math.max(wait || 2000, 1000), 30000));
      return this.get(path, params);
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
  history(room, oldest, latest, count = 100) {
    const endpoint = { c: 'channels', p: 'groups', d: 'im' }[room.t] || 'channels';
    return this.get(`${endpoint}.history`, { roomId: room._id, oldest, latest, count });
  }

  messageLink(room, msgId) {
    if (room.t === 'd') return `${this.url}/direct/${room._id}?msg=${msgId}`;
    const kind = room.t === 'p' ? 'group' : 'channel';
    return `${this.url}/${kind}/${encodeURIComponent(room.name)}?msg=${msgId}`;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
