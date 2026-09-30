// POST /api/logout: clears the session cookie.
import { COOKIE } from '../../../lib/auth';

export async function POST(request) {
  return new Response(null, {
    status: 303,
    headers: { Location: new URL('/login', request.url).toString(), 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` },
  });
}
