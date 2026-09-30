// Password gate for the whole app (pages and API), using HTTP Basic Auth.
// Fails closed: if BASIC_AUTH_PASSWORD isn't set, nothing is served.
import { NextResponse } from 'next/server';

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(request) {
  const password = process.env.BASIC_AUTH_PASSWORD ?? '';
  if (password.length < 12) {
    return new NextResponse('BASIC_AUTH_PASSWORD is not set (min 12 characters).', { status: 503 });
  }
  const user = process.env.BASIC_AUTH_USER || 'team';
  const expected = `Basic ${btoa(`${user}:${password}`)}`;
  if (safeEqual(request.headers.get('authorization') ?? '', expected)) return NextResponse.next();
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="LLM eval", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
