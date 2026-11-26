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
  const [retention, webhooks, webhookHosts, teams, live] = await Promise.all([
    versionsKept(ctx.env),
    isOn(ctx.env.DB, 'webhooks'),
    readAllowedHosts(ctx.env),
    isOn(ctx.env.DB, 'teams'),
    isOn(ctx.env.DB, 'live'),
  ]);
  return Response.json({ retention, webhooks, webhookHosts, teams, live });
}

/** Turn teams on or off. Turning teams off fires the settings_teams_off trigger which resets every project's answers_needed to 1. */
export async function setTeamsSwitch(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['on']);
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('teams', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .bind(String(body.on), now),
      auditStatement(env, person.memberId, body.on ? 'teams.on' : 'teams.off', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ teams: body.on });
}

/** Turn live WebSocket pings on or off. When off, `lawh wait` and `lawh listen` poll every 30 seconds. */
export async function setLiveSwitch(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['on']);
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('live', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
        .bind(String(body.on), now),
      auditStatement(env, person.memberId, body.on ? 'live.on' : 'live.off', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ live: body.on });
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

/** Turn outbound webhooks on or off. Turning them on records the current event high-water mark atomically so earlier history is never replayed. */
export async function setWebhooksSwitch(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request), now = Date.now();
  onlyKeys(body, ['on']);
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      ...(body.on
        ? [env.DB.prepare(`INSERT INTO settings(key, value_json, updated_at)
            SELECT 'webhooks_since', CAST(COALESCE((SELECT MAX(seq) FROM events), 0) AS TEXT), ?
            WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'webhooks' AND value_json = 'true')
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).bind(now)]
        : []),
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
