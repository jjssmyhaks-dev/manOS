'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2Icon } from 'lucide-react';

export function SignupForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(fd.get('email') ?? ''),
          password: String(fd.get('password') ?? ''),
          name: String(fd.get('name') ?? ''),
          company: String(fd.get('company') ?? ''),
        }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (d.ok) {
        router.push('/dashboard');
        router.refresh();
      } else {
        setError(d.error ?? 'Could not create your workspace');
        setBusy(false);
      }
    } catch {
      setError('Network error — please try again.');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <div>
        <label htmlFor="company" className="text-xs font-medium text-muted-foreground">Company / factory name</label>
        <Input id="company" name="company" placeholder="Sharma Metal Works" className="mt-1" required />
      </div>
      <div>
        <label htmlFor="name" className="text-xs font-medium text-muted-foreground">Your name</label>
        <Input id="name" name="name" placeholder="Rahul Sharma" className="mt-1" />
      </div>
      <div>
        <label htmlFor="email" className="text-xs font-medium text-muted-foreground">Work email</label>
        <Input id="email" name="email" type="email" placeholder="rahul@sharmametal.in" className="mt-1" required />
      </div>
      <div>
        <label htmlFor="password" className="text-xs font-medium text-muted-foreground">Password (8+ characters)</label>
        <Input id="password" name="password" type="password" minLength={8} className="mt-1" required />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy && <Loader2Icon className="mr-1 h-4 w-4 animate-spin" />} Create workspace
      </Button>
    </form>
  );
}
