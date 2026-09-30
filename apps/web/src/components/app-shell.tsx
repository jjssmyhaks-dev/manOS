'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [orgSlug, setOrgSlug] = useState<string | null>(null);

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
        <div className="border-t p-3 text-xs text-muted-foreground">
          P0 build · Next.js + AI SDK + AI Elements
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <ShadowBanner />
        {children}
      </main>
    </div>
  );
}

export { NAV };
