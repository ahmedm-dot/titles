// Shared auth helpers (Web Crypto only, so they run in Netlify's proxy runtime too).
export const COOKIE = 'eval_session';
export const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function settings() {
  const password = process.env.BASIC_AUTH_PASSWORD ?? '';
  return { user: process.env.BASIC_AUTH_USER || 'team', password, ok: password.length >= 12 };
}

export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Session token = HMAC(password, "eval-session-v1"). Changing the password logs everyone out.
export async function sessionToken(password) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('eval-session-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
