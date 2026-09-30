// Protects every page and API route. Two ways in:
//   - browsers: the /login page sets a session cookie
//   - scripts (npm run upload): HTTP Basic Auth header
// Fails closed: if BASIC_AUTH_PASSWORD isn't set, nothing is served.
import { NextResponse } from 'next/server';
import { COOKIE, safeEqual, sessionToken, settings } from './lib/auth';

const PUBLIC = ['/login', '/api/login'];

export async function proxy(request) {
  const { user, password, ok } = settings();
  if (!ok) return new NextResponse('BASIC_AUTH_PASSWORD is not set (min 12 characters).', { status: 503 });

  const { pathname, search } = request.nextUrl;
  if (PUBLIC.includes(pathname)) return NextResponse.next();

  const cookie = request.cookies.get(COOKIE)?.value ?? '';
  if (cookie && safeEqual(cookie, await sessionToken(password))) return NextResponse.next();

  const header = request.headers.get('authorization') ?? '';
  if (header && safeEqual(header, `Basic ${btoa(`${user}:${password}`)}`)) return NextResponse.next();

  if (pathname.startsWith('/api/')) return new NextResponse('Authentication required', { status: 401 });
  const login = new URL('/login', request.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
