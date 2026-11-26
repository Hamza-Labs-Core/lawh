import { equalInConstantTime, hmacHex, readSecret } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { origins } from '../../shared/origin';
import { keyHmac, projectJson, usableProjects } from './auth';
import { onlyKeys, readJson, text } from './body';

const TEN_MINUTES = 600_000;
const MINUTE = 60_000;
const COPY_START_LIMIT_PER_MIN = 60;
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const KEY_HEADER = /^Bearer lawh_(key_[0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;
const SHA256 = /^[0-9a-f]{64}$/;

function newCode(): string {
  let code = '';
  while (code.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < 8) code += LETTERS[byte % 20];
    }
  }
  return code;
}

/** Case, spaces and dashes don't matter. */
export const connectCodeHmac = async (env: AppEnv, code: string): Promise<string> =>
  hmacHex(await readSecret(env.PEPPER), `connect:${code.toUpperCase().replace(/[\s-]/g, '')}`);

const singleLine = (value: unknown, name: string, max: number): string => {
  const out = text(value, name, { min: 1, max }).trim().normalize('NFC');
  if (!out || /[\n\r\t]/.test(out)) throw invalid(`${name} must be one line.`);
  return out;
};

/** POST /v1/connect — unauthenticated start of an agent connection request. */
export async function startConnect(request: Request, env: AppEnv): Promise<Response> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const [byIp, byCopy] = await Promise.all([
    env.AUTH_LIMIT.limit({ key: `connect:${address}` }),
    env.SIGNIN_LIMIT.limit({ key: 'connect:copy' }),
  ]);
  if (!byIp.success || !byCopy.success) throw new ApiError('rate_limited', 'Too many requests.');

  const { body } = await readJson(request);
  onlyKeys(body, ['secretSha256', 'client', 'machine']);
  if (typeof body.secretSha256 !== 'string' || !SHA256.test(body.secretSha256)) {
    throw invalid('secretSha256 must be 64 lowercase hex characters.');
  }
  const client = singleLine(body.client, 'client', 40);
  const machine = singleLine(body.machine, 'machine', 60);

  const now = Date.now(), expiresAt = now + TEN_MINUTES;
  const bucket = Math.floor(now / MINUTE);
  const copyRow = await env.DB.prepare(
    `INSERT INTO idempotency(key_id, idem_key, request_sha256, status, response_json, expires_at)
     VALUES('rl:connect-start', ?1, '', 1, '{}', ?2)
     ON CONFLICT(key_id, idem_key) DO UPDATE SET status = status + 1, expires_at = ?2
     RETURNING status`,
  ).bind(String(bucket), (bucket + 2) * MINUTE).first<{ status: number }>();
  if ((copyRow?.status ?? 0) > COPY_START_LIMIT_PER_MIN) {
    throw new ApiError('rate_limited', 'Too many requests.');
  }

  const id = newId('key', now);
  const code = newCode();
  const [codeHmac, secretHmac] = await Promise.all([
    connectCodeHmac(env, code),
    hmacHex(await readSecret(env.PEPPER), `${id}:${body.secretSha256}`),
  ]);

  await env.DB.prepare(
    'INSERT INTO agent_connects(id, code_hmac, secret_hmac, client, machine, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
  ).bind(id, codeHmac, secretHmac, client, machine, now, expiresAt).run();

  return Response.json({
    id,
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    url: `${origins(env).app}/connect`,
    expiresAt,
    interval: 3,
  }, { status: 201 });
}

interface LiveKeyRow {
  secret_hmac: string;
  scopes_json: string;
  all_projects: number;
  expires_at: number;
  revoked_at: number | null;
  agent_id: string;
  agent_name: string;
  disabled_at: number | null;
  member_id: string;
  role: string;
  removed_at: number | null;
}

interface ConnectRow {
  secret_hmac: string;
  expires_at: number;
  answered_at: number | null;
  agent_id: string | null;
}

/**
 * GET /v1/connect/{id} — polled by the agent client with its prospective key.
 * Checks agent_keys first so a key created in the last second still returns 200 after the connect row expires or is cleaned up.
 */
export async function getConnect(request: Request, env: AppEnv, id: string): Promise<Response> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.SIGNIN_LIMIT.limit({ key: `connect-poll:${address}` })).success) {
    throw new ApiError('rate_limited', 'Too many requests.');
  }

  const match = KEY_HEADER.exec(request.headers.get('Authorization') ?? '');
  if (!match || match[1] !== id) throw notFound();
  const secret = match[2]!;
  const now = Date.now();
  const computed = await keyHmac(env, id, secret);

  // Read live key, teams switch, and pending connect row in one atomic D1 batch snapshot so an approval
  // committing mid-poll can never yield a missing key alongside an already-answered connect row.
  const [keyRes, teamsRes, connectRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT k.secret_hmac, k.scopes_json, k.all_projects, k.expires_at, k.revoked_at,
              k.agent_id, a.name AS agent_name, a.disabled_at, a.member_id, m.role, m.removed_at
       FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = a.member_id
       WHERE k.id = ?`,
    ).bind(id),
    env.DB.prepare("SELECT value_json FROM settings WHERE key = 'teams'"),
    env.DB.prepare('SELECT secret_hmac, expires_at, answered_at, agent_id FROM agent_connects WHERE id = ?').bind(id),
  ]);

  const keyRow = (keyRes!.results[0] as LiveKeyRow | undefined) ?? null;
  const teamsOn = ((teamsRes!.results[0] as { value_json: string } | undefined)?.value_json) === 'true';
  const row = (connectRes!.results[0] as ConnectRow | undefined) ?? null;

  // 1) Check live key first (openapi.yaml & security.md §5).
  const keySame = equalInConstantTime(computed, keyRow?.secret_hmac ?? '0'.repeat(64));
  if (keyRow && keySame) {
    if (keyRow.revoked_at !== null || keyRow.disabled_at !== null || keyRow.removed_at !== null || keyRow.expires_at <= now) {
      throw notFound();
    }
    const isOwner = keyRow.role === 'owner';
    if (!isOwner && !teamsOn) throw new ApiError('feature_off', 'This feature is off.');
    const caller = {
      keyId: id,
      agentId: keyRow.agent_id,
      agentName: keyRow.agent_name,
      memberId: keyRow.member_id,
      isOwner,
      allProjects: isOwner && keyRow.all_projects === 1,
      scopes: new Set(JSON.parse(keyRow.scopes_json) as string[]),
      expiresAt: keyRow.expires_at,
    };
    const projects = await usableProjects(env, caller);
    return Response.json({
      agentId: caller.agentId,
      name: caller.agentName,
      scopes: [...caller.scopes],
      allProjects: caller.allProjects,
      projects: projects.map(projectJson),
      expiresAt: caller.expiresAt,
    });
  }

  // 2) Otherwise check the pending/refused connection request (expired requests always return 404).
  const connectSame = equalInConstantTime(computed, row?.secret_hmac ?? '0'.repeat(64));
  if (!row || !connectSame) throw notFound();
  if (row.expires_at <= now) throw notFound();
  if (row.answered_at !== null) {
    if (row.agent_id === null) throw new ApiError('forbidden', 'Connection request was refused.');
    throw notFound();
  }
  return new Response(null, { status: 202 });
}
