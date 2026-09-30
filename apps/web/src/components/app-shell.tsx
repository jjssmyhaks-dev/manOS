'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ShadowBanner } from '@/components/shadow-banner';
import {
  MessageSquareText, LayoutDashboard, FileText, ShoppingCart, BellRing,
  CalendarClock, Plug, ScrollText, Settings, Factory, ActivityIcon,
} from 'lucide-react';

const NAV = [
  { href: '/chat', label: 'Chat', icon: MessageSquareText },
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/activity', label: 'AI Activity', icon: ActivityIcon },
  { href: '/documents', label: 'Documents', icon: FileText },
  { href: '/procurement', label: 'Procurement', icon: ShoppingCart },
  { href: '/collections', label: 'Collections', icon: BellRing },
  { href: '/digest', label: 'Digest', icon: CalendarClock },
  { href: '/connectors', label: 'Connectors', icon: Plug },
  { href: '/audit', label: 'Audit log', icon: ScrollText },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface MeUser {
  email: string;
  name: string | null;
  org: { name: string; slug: string } | null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => setMe(d.user ?? null)).catch(() => {});
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r bg-card md:flex md:flex-col">
        <div className="flex items-center gap-2 px-4 py-4 border-b">
          <Factory className="h-6 w-6 text-primary" />
          <div className="font-semibold leading-tight">Factory AI OS</div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/chat' ? pathname === '/chat' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                  active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        {me ? (
          <div className="border-t p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {(me.name?.[0] ?? me.email[0] ?? 'F').toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{me.name?.trim() || me.email}</div>
                <div className="truncate text-[11px] text-muted-foreground">{me.org?.name ?? me.email}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                await fetch('/api/auth/signout', { method: 'POST' });
                router.push('/');
              }}
              className="mt-2 w-full rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="border-t p-3">
            <div className="flex gap-2">
              <Link
                href="/signin"
                className="flex-1 rounded-md border px-2 py-1 text-center text-xs text-muted-foreground hover:bg-muted"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="flex-1 rounded-md bg-primary px-2 py-1 text-center text-xs text-primary-foreground hover:bg-primary/90"
              >
                Get started
              </Link>
            </div>
          </div>
        )}
      </aside>
      <main className="flex-1 min-w-0">
        <ShadowBanner />
        {children}
      </main>
    </div>
  );
}

export { NAV };
