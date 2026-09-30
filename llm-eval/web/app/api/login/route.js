// POST /api/login (form): checks the password and sets the session cookie.
import { COOKIE, MAX_AGE, safeEqual, sessionToken, settings } from '../../../lib/auth';

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export async function POST(request) {
  const form = await request.formData();
  const next = safeNext(form.get('next'));
  const { password, ok } = settings();
  const given = String(form.get('password') ?? '');

  if (!ok || !safeEqual(given, password)) {
    await new Promise((r) => setTimeout(r, 500)); // slow down guessing
    return Response.redirect(new URL(`/login?error=1&next=${encodeURIComponent(next)}`, request.url), 303);
  }
  const res = Response.redirect(new URL(next, request.url), 303);
  const headers = new Headers(res.headers);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  headers.append('Set-Cookie', `${COOKIE}=${await sessionToken(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
  return new Response(null, { status: 303, headers });
}
