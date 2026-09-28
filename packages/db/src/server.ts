/**
 * Supabase production path — Postgres (Mumbai), pgvector, Auth, Storage.
 * Swap DATABASE_URL in env to move from PGlite dev to Supabase prod without
 * touching app code (PRD §7 tech stack).
 */
import { z } from 'zod';

export const EnvSchema = z.object({
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  return EnvSchema.safeParse(process.env).data ?? {};
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export function getSupabaseConfig(env: Env = loadEnv()): SupabaseConfig | null {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY };
  }
  return null;
}

/** Server-side Supabase client factory (service role — server only). */
export async function createSupabaseClient(cfg?: SupabaseConfig) {
  const c = cfg ?? getSupabaseConfig();
  if (!c) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(c.url, c.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
