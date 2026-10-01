import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { query } from '@factory/db';
import { seedDemoData } from '@factory/db';
import { setShadowMode, startOnboarding } from '@factory/core';

/**
 * Email + password auth (PRD F1 workspaces, now real): scrypt password
 * hashing, server-side sessions in the `sessions` table, httpOnly cookie.
 * Signup creates a dedicated workspace seeded with sample data under the
 * subscriber's own company name, so the product works on minute one.
 */

export const SESSION_COOKIE = 'factory_session';
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  company?: string;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  userId?: string;
  orgSlug?: string;
}

function slugify(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base || 'workspace';
}

/** Create a workspace + owner, seed sample data under their company name, start a session. */
export async function signup(input: SignupInput): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (input.password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const existing = await query<{ id: string }>('select id from users where email = $1 limit 1', [email]);
  if (existing[0]) return { ok: false, error: 'An account with this email already exists — sign in instead.' };

  const company = input.company?.trim() || `${email.split('@')[0]}'s factory`;
  const slug = `${slugify(company)}-${crypto.randomBytes(3).toString('hex')}`;

  // dedicated workspace with sample data under their own company name
  const seeded = await seedDemoData(slug, { name: company, vertical: 'fabrication' });

  // pilot defaults (PRD v2): shadow mode on — the agent drafts, never executes
  // until the owner flips the switch; stamp the guided-setup start.
  await setShadowMode(seeded.orgId, true);
  await startOnboarding(seeded.orgId);

  const userRows = await query<{ id: string }>(
    `insert into users (org_id, email, name, role, password_hash) values ($1,$2,$3,'owner',$4) returning id`,
    [seeded.orgId, email, input.name?.trim() || company, hashPassword(input.password)]
  );

  await startSession(userRows[0]!.id, seeded.orgId);
  return { ok: true, userId: userRows[0]!.id, orgSlug: slug };
}

export async function signin(email: string, password: string): Promise<AuthResult> {
  const rows = await query<{ id: string; org_id: string; password_hash: string | null }>(
    'select id, org_id, password_hash from users where email = $1 limit 1',
    [email.trim().toLowerCase()]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, error: 'Email or password is incorrect.' };
  }
  await startSession(user.id, user.org_id);
  return { ok: true, userId: user.id };
}

async function startSession(userId: string, orgId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `insert into sessions (token, user_id, org_id, expires_at) values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [token, userId, orgId, String(SESSION_DAYS)]
  );
  const jar = await cookies();
  // secure=true in production — over plain http (local dev) the browser would
  // drop the cookie entirely, so it is conditional
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export interface SessionUser {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  orgId: string;
}

/** Resolve the signed-in user from the session cookie (null when demo/anon). */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const rows = await query<{ user_id: string; email: string; name: string | null; role: string; org_id: string }>(
      `select s.user_id, u.email, u.name, u.role, s.org_id
       from sessions s join users u on u.id = s.user_id
       where s.token = $1 and s.expires_at > now() limit 1`,
      [token]
    );
    if (!rows[0]) return null;
    return { userId: rows[0].user_id, email: rows[0].email, name: rows[0].name, role: rows[0].role, orgId: rows[0].org_id };
  } catch {
    return null;
  }
}

/** Sign out: kill the server-side session and clear the cookie. */
export async function signout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await query('delete from sessions where token = $1', [token]).catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
}

/** Housekeeping: drop expired sessions (wired into the daily cron via /api/jobs/daily). */
export async function purgeExpiredSessions(): Promise<number> {
  const r = await query<{ id: string }>('delete from sessions where expires_at <= now() returning id');
  return r.length;
}

/** Brute-force backstop: prune a user's stale sessions after a successful signin. */
export async function pruneUserSessions(userId: string, keep = 10): Promise<void> {
  await query(
    `delete from sessions where user_id = $1 and token not in (
       select token from sessions where user_id = $1 order by expires_at desc limit $2
     )`,
    [userId, keep]
  ).catch(() => {});
}
