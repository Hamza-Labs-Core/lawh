import { ApiError, invalid } from '../../shared/errors';
import { versionsKept } from '../housekeeping';
import { onlyKeys, readJson } from '../api/body';
import type { SignedIn } from './router';
import { auditStatement } from './session';

/** The copy's own settings. The owner's alone. */

export function ownerOnly(ctx: SignedIn): void {
  if (!ctx.person.isOwner) throw new ApiError('forbidden', 'Only the owner can do this.');
}

export async function readSettings(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  return Response.json({ retention: await versionsKept(ctx.env) });
}

/** How many versions each page keeps; null keeps all. Fewer than now removes the older ones, some each hour. */
export async function setRetention(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['keep']);
  const { keep } = body;
  if (keep !== null && (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1 || keep > 1000)) throw invalid('keep must be null or a whole number from 1 to 1000.');
  const set = (key: string, value: unknown) => env.DB.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').bind(key, JSON.stringify(value), now);
  await env.DB.batch([
    set('retention', keep),
    // Every page is looked at once, from the start.
    keep === null ? env.DB.prepare("DELETE FROM settings WHERE key = 'retention_walk'") : set('retention_walk', ''),
    auditStatement(env, person.memberId, 'retention.set', null),
  ]);
  return Response.json({ retention: keep });
}
