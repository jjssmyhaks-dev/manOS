import Link from 'next/link';
import { SignupForm } from '@/components/signup-form';

export const metadata = { title: 'Create your workspace — Factory AI OS' };

export default function SignupPage() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden flex-1 flex-col justify-between bg-brand-deep p-10 text-primary-foreground lg:flex">
        <Link href="/" className="text-lg font-semibold">Factory AI OS</Link>
        <div>
          <h1 className="max-w-md text-3xl font-semibold leading-tight">
            Your factory, with an AI operations team — that shows its work.
          </h1>
          <p className="mt-4 max-w-md text-sm text-white/70">
            Every action the AI takes lands on an activity log you can audit and undo.
            Start in shadow mode: it drafts everything, executes nothing, until you trust it.
          </p>
          <ul className="mt-8 space-y-2 text-sm text-white/80">
            <li>✓ Sample data loaded — useful from minute one</li>
            <li>✓ Tally, Zoho Books &amp; QuickBooks sync</li>
            <li>✓ WhatsApp approvals from your phone</li>
            <li>✓ AI included — you never paste an API key</li>
          </ul>
        </div>
        <p className="text-xs text-white/50">Built for scrap &amp; waste processors and export houses first.</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Create your workspace</h2>
          <p className="mt-1 text-xs text-muted-foreground">Free demo workspace · no card · AI included</p>
          <SignupForm />
          <p className="mt-4 text-xs text-muted-foreground">
            Already have an account? <Link href="/signin" className="text-primary underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
