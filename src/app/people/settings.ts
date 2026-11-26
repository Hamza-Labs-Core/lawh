import type { AppEnv } from '../../shared/env';
import { ApiError, invalid } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isOn } from '../../shared/switches';
import { versionsKept } from '../housekeeping';
import { onlyKeys, readJson } from '../api/body';
import { MAX_WEBHOOK_HOSTS, normalizeHost, readAllowedHosts } from '../webhooks/crypto';
import type { SignedIn } from './router';
import { auditStatement } from './session';

/** The copy's own settings. The owner's alone. */

export function ownerOnly(ctx: SignedIn): void {
  if (!ctx.person.isOwner) throw new ApiError('forbidden', 'Only the owner can do this.');
}

/** Fails the batch unless this member is still the active owner at write time. */
export const stillOwner = (env: AppEnv, memberId: string): D1PreparedStatement =>
  env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'owner' AND removed_at IS NULL) THEN 1 ELSE json('forbidden') END").bind(memberId);

export async function readSettings(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const [retention, webhooks, webhookHosts] = await Promise.all([
    versionsKept(ctx.env),
    isOn(ctx.env.DB, 'webhooks'),
    readAllowedHosts(ctx.env),
  ]);
  return Response.json({ retention, webhooks, webhookHosts });
}

/** How many versions each page keeps; null keeps all. Fewer than now removes the older ones, some each hour. */
export async function setRetention(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['keep']);
  const { keep } = body;
  if (keep !== null && (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 1 || keep > 1000)) throw invalid('keep must be null or a whole number from 1 to 1000.');
  const set = (key: string, value: unknown) => env.DB.prepare('INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at').bind(key, JSON.stringify(value), now);
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      set('retention', keep),
      // Every page is looked at once, from the start, with a unique walk id so an older walk can never erase a newer one.
      keep === null ? env.DB.prepare("DELETE FROM settings WHERE key = 'retention_walk'") : set('retention_walk', { id: newId('wlk', now), after: '' }),
      auditStatement(env, person.memberId, 'retention.set', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ retention: keep });
}

/** Turn outbound webhooks on or off. Turning them on skips earlier events so old history is not replayed. */
export async function setWebhooksSwitch(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['on']);
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  if (body.on && !(await isOn(env.DB, 'webhooks'))) {
    // Drain un-enqueued pre-switch events in bounded indexed slices so enabling webhooks only sends new events.
    for (let i = 0; i < 50; i++) {
      const res = await env.DB.prepare('UPDATE events SET enqueued_at = ? WHERE seq IN (SELECT seq FROM events WHERE enqueued_at IS NULL ORDER BY seq LIMIT 100)').bind(now).run();
      if ((res.meta.changes ?? 0) < 100) break;
    }
  }
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('webhooks', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .bind(String(body.on), now),
      auditStatement(env, person.memberId, body.on ? 'webhooks.on' : 'webhooks.off', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ webhooks: body.on });
}

/** Owner-set allowlist of HTTPS hostnames that webhooks may call. */
export async function setWebhookHosts(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['hosts']);
  if (!Array.isArray(body.hosts) || body.hosts.length > MAX_WEBHOOK_HOSTS) throw invalid(`hosts must be a list of at most ${MAX_WEBHOOK_HOSTS}.`);
  const hosts = [...new Set(body.hosts.map(normalizeHost))].sort();
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('webhook_hosts', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .bind(JSON.stringify(hosts), now),
      auditStatement(env, person.memberId, 'webhook_hosts.set', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ webhookHosts: hosts });
}
