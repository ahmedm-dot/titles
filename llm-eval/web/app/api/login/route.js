// POST /api/login (form): checks the password and sets the session cookie.
// Redirects use relative Locations so the browser stays on the host it came from
// (on Netlify, request.url can be the internal branch-deploy host).
import { COOKIE, MAX_AGE, safeEqual, sessionToken, settings } from '../../../lib/auth';

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

export async function POST(request) {
  const form = await request.formData();
  const next = safeNext(form.get('next'));
  const { password, ok } = settings();
  const given = String(form.get('password') ?? '');

  if (!ok || !safeEqual(given, password)) {
    await new Promise((r) => setTimeout(r, 500)); // slow down guessing
    return new Response(null, { status: 303, headers: { Location: `/login?error=1&next=${encodeURIComponent(next)}` } });
  }
  const secure = request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: {
      Location: next,
      'Set-Cookie': `${COOKIE}=${await sessionToken(password)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
