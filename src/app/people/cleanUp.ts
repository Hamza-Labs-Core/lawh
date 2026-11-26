import type { AppEnv } from '../../shared/env';

const THIRTY_DAYS = 30 * 86_400_000;

/** Hourly: what is over. Unused invites stay in their team's list for 30 days, then are canceled automatically. */
export async function cleanUpPeople(env: AppEnv, now = Date.now()): Promise<void> {
  const inviteCutoff = now - THIRTY_DAYS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM device_approvals WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM agent_connects WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare("DELETE FROM access_links WHERE expires_at < ? AND (used_at IS NOT NULL OR kind <> 'invite')").bind(now),
    env.DB.prepare("UPDATE members SET removed_at = ? WHERE id IN (SELECT id FROM members WHERE role = 'member' AND joined_at IS NULL AND removed_at IS NULL AND created_at < ? LIMIT 500)").bind(now, inviteCutoff),
  ]);
}
