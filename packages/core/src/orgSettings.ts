import { query } from '@factory/db';

/**
 * Per-org feature settings stored on organizations.settings (JSONB) —
 * no extra table needed. Shadow mode is the PRD v2 pilot default: the agent
 * drafts everything but executes nothing until the owner flips the switch.
 */

export async function isShadowMode(orgId: string): Promise<boolean> {
  try {
    const rows = await query<{ shadow: string | null }>(
      `select coalesce(settings->>'shadow_mode', 'false') as shadow from organizations where id = $1 limit 1`,
      [orgId]
    );
    return rows[0]?.shadow === 'true';
  } catch {
    return false; // settings lookup must never block the policy engine
  }
}

export async function setShadowMode(orgId: string, enabled: boolean): Promise<void> {
  await query(
    `update organizations set settings = coalesce(settings,'{}'::jsonb) || $2::jsonb where id = $1`,
    [orgId, JSON.stringify({ shadow_mode: enabled })]
  );
}
