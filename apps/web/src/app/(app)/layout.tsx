import { AppShell } from '@/components/app-shell';

/** Route group layout: every workspace page renders inside the sidebar shell. */
export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
