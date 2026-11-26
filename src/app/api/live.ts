import { base64url, equalInConstantTime, hmacHex, readSecret } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, invalid } from '../../shared/errors';
import { origins } from '../../shared/origin';
import { isOn } from '../../shared/switches';
import { projectBySlug } from './auth';
import { onlyKeys, readJson, text } from './body';
import type { Context } from './router';

const TICKET_TTL_MS = 60_000;
const MAX_CONNECTION_MS = 3_600_000;
const TICKET_FORMAT = /^([A-Za-z0-9_-]{8,512})\.([0-9a-f]{64})$/;

interface TicketPayload {
  k: string;
  p: string;
  e: number;
}

function decodeBase64Url(input: string): string {
  const pad = input.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** POST /v1/events/ticket — issues a 60-second signed WebSocket ticket for one project, behind the `live` switch. */
export async function getLiveTicket(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  if (!(await isOn(env.DB, 'live'))) throw new ApiError('feature_off', 'This feature is off.');
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['project']);
  const slug = text(body.project, 'project', { min: 1, max: 80 }).trim();
  const project = await projectBySlug(env, caller, slug);

  const expiresAt = Date.now() + TICKET_TTL_MS;
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ k: caller.keyId, p: project.id, e: expiresAt } satisfies TicketPayload)));
  const sig = await hmacHex(await readSecret(env.LIVE_KEY), `live:${payload}`);
  const ticket = `${payload}.${sig}`;
  const wsOrigin = origins(env).app.replace(/^http/, 'ws');
  const url = `${wsOrigin}/v1/events/live?ticket=${encodeURIComponent(ticket)}`;
  return Response.json({ url, expiresAt }, { status: 201 });
}

/** GET /v1/events/live?ticket=... — verifies the short-lived HMAC ticket and upgrades via the project's LiveProject DO. */
export async function connectLive(request: Request, env: AppEnv): Promise<Response> {
  if (!(await isOn(env.DB, 'live'))) throw new ApiError('feature_off', 'This feature is off.');
  const url = new URL(request.url);
  const ticket = url.searchParams.get('ticket') ?? '';
  const match = TICKET_FORMAT.exec(ticket);
  const failAuth = async (): Promise<never> => {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await env.AUTH_LIMIT.limit({ key: ip })).success) {
      throw new ApiError('rate_limited', 'Too many requests.');
    }
    throw new ApiError('unauthorized', 'Invalid or expired ticket.');
  };
  if (!match) await failAuth();

  const [, encoded, sig] = match!;
  const expectedSig = await hmacHex(await readSecret(env.LIVE_KEY), `live:${encoded!}`);
  if (!equalInConstantTime(sig!, expectedSig)) await failAuth();

  let parsed: Partial<TicketPayload>;
  try {
    parsed = JSON.parse(decodeBase64Url(encoded!)) as Partial<TicketPayload>;
  } catch {
    await failAuth();
    throw new ApiError('unauthorized', 'Invalid or expired ticket.');
  }
  const now = Date.now();
  if (
    typeof parsed.k !== 'string' || !parsed.k ||
    typeof parsed.p !== 'string' || !parsed.p ||
    typeof parsed.e !== 'number' || !Number.isSafeInteger(parsed.e) || parsed.e <= now
  ) {
    await failAuth();
  }

  // Re-verify the key is still active and can still access this project before opening a long-lived socket.
  const keyRow = await env.DB.prepare(
    `SELECT k.all_projects, k.expires_at, a.member_id, m.role
     FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = a.member_id
     WHERE k.id = ? AND k.revoked_at IS NULL AND a.disabled_at IS NULL AND m.removed_at IS NULL`,
  ).bind(parsed.k!).first<{ all_projects: number; expires_at: number; member_id: string; role: string }>();
  if (!keyRow || keyRow.expires_at <= now) await failAuth();
  const isOwner = keyRow!.role === 'owner';
  if (!isOwner && !(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
  const hasAccess = isOwner && keyRow!.all_projects === 1
    ? (await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?').bind(parsed.p!).first()) !== null
    : isOwner
      ? (await env.DB.prepare('SELECT 1 FROM agent_key_projects WHERE key_id = ? AND project_id = ?').bind(parsed.k!, parsed.p!).first()) !== null
      : (await env.DB.prepare(
        `SELECT 1 FROM agent_key_projects kp CROSS JOIN project_access x ON x.member_id = ? AND x.project_id = kp.project_id AND x.level = 4
         WHERE kp.key_id = ? AND kp.project_id = ?`,
      ).bind(keyRow!.member_id, parsed.k!, parsed.p!).first()) !== null;
  if (!hasAccess) await failAuth();

  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw invalid('WebSocket upgrade required.');
  }

  const stub = env.LIVE.get(env.LIVE.idFromName(parsed.p!));
  const headers = new Headers(request.headers);
  headers.set('X-Lawh-Key-Id', parsed.k!);
  headers.set('X-Lawh-Expires-At', String(Math.min(now + MAX_CONNECTION_MS, keyRow!.expires_at)));
  return stub.fetch('https://live/connect', { method: 'GET', headers });
}

/** Sends a best-effort `{ seq }` ping to the project's LiveProject DO when the `live` switch is on. */
export async function notifyLive(env: AppEnv, projectId: string): Promise<void> {
  if (!(await isOn(env.DB, 'live'))) return;
  const row = await env.DB.prepare('SELECT MAX(seq) AS seq FROM events WHERE project_id = ?').bind(projectId).first<{ seq: number | null }>();
  if (!row?.seq || row.seq < 1) return;
  const stub = env.LIVE.get(env.LIVE.idFromName(projectId));
  await stub.fetch('https://live/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seq: row.seq }),
  });
}

export async function notifyLiveBySlug(env: AppEnv, slug: string): Promise<void> {
  if (!(await isOn(env.DB, 'live'))) return;
  const project = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(slug).first<{ id: string }>();
  if (project) await notifyLive(env, project.id);
}
