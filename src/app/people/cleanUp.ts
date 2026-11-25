import type { AppEnv } from '../../shared/env';

/** Hourly: what is over. Invites nobody used stay in their team's list until someone cancels them (S18). */
export async function cleanUpPeople(env: AppEnv, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM device_approvals WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare("DELETE FROM access_links WHERE expires_at < ? AND (used_at IS NOT NULL OR kind <> 'invite')").bind(now),
  ]);
}
