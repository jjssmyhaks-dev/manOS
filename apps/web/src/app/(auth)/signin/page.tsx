import Link from 'next/link';
import { SigninForm } from '@/components/signin-form';

export const metadata = { title: 'Sign in — Factory AI OS' };

export default function SigninPage() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden flex-1 flex-col justify-between bg-brand-deep p-10 text-primary-foreground lg:flex">
        <Link href="/" className="text-lg font-semibold">Factory AI OS</Link>
        <div>
          <h1 className="max-w-md text-3xl font-semibold leading-tight">Welcome back.</h1>
          <p className="mt-4 max-w-md text-sm text-white/70">
            Your agent has been busy — check the AI Activity log for everything it did,
            and undo anything you don&apos;t like.
          </p>
        </div>
        <p className="text-xs text-white/50">Trust is the product, not a feature.</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="mt-1 text-xs text-muted-foreground">To your factory workspace</p>
          <SigninForm />
          <p className="mt-4 text-xs text-muted-foreground">
            New here? <Link href="/signup" className="text-primary underline">Create your workspace</Link> · or{' '}
            <Link href="/" className="text-primary underline">try the demo</Link> without an account
          </p>
        </div>
      </div>
    </div>
  );
}
