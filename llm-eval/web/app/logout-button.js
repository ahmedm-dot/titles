'use client';
import { usePathname } from 'next/navigation';

export default function LogoutButton() {
  if (usePathname() === '/login') return null;
  return (
    <form method="post" action="/api/logout">
      <button className="link" type="submit">Log out</button>
    </form>
  );
}
