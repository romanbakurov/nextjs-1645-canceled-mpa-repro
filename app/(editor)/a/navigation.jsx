'use client';
import Link from 'next/link';

export default function Navigation() {
  return (
    <nav>
      <Link id="to-b" href="/b" prefetch={false}>
        Navigate to root-layout B
      </Link>
    </nav>
  );
}
