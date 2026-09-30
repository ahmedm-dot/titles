// POST /api/logout: clears the session cookie (relative redirect, see api/login).
import { COOKIE } from '../../../lib/auth';

export async function POST() {
  return new Response(null, {
    status: 303,
    headers: { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` },
  });
}
