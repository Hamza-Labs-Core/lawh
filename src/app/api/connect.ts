import { equalInConstantTime, hmacHex, readSecret } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { origins } from '../../shared/origin';
import { keyHmac, projectJson, usableProjects } from './auth';
import { isObject, onlyKeys, readJson, text } from './body';
import type { Context } from './router';

const TEN_MINUTES = 600_000;
const MINUTE = 60_000;
const COPY_START_LIMIT_PER_MIN = 60;
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const KEY_HEADER = /^Bearer lawh_(key_[0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

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

export const slugifyProject = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');

export function readProjectProposal(value: unknown, prefix = ''): { slug: string; name: string } {
  if (!isObject(value)) throw invalid(`${prefix || 'project'} must be an object.`);
  onlyKeys(value, ['name', 'slug']);
  const name = singleLine(value.name, `${prefix}name`, 80);
  let slug: string;
  if (value.slug !== undefined && value.slug !== '') {
    if (typeof value.slug !== 'string' || !SLUG_RE.test(value.slug)) {
      throw invalid(`${prefix}slug must be 1 to 80 lowercase letters, digits or dashes, and start with a letter or digit.`);
    }
    slug = value.slug;
  } else {
    slug = slugifyProject(name);
    if (!slug) throw invalid(`${prefix}slug is required when ${prefix}name has no ASCII letters or digits.`);
  }
  return { slug, name };
}

/** POST /v1/connect — unauthenticated start of an agent connection request. */
export async function startConnect(request: Request, env: AppEnv): Promise<Response> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const [byIp, byCopy] = await Promise.all([
    env.AUTH_LIMIT.limit({ key: `connect:${address}` }),
    env.SIGNIN_LIMIT.limit({ key: 'connect:copy' }),
  ]);
  if (!byIp.success || !byCopy.success) throw new ApiError('rate_limited', 'Too many requests.');

  const { body } = await readJson(request);
  onlyKeys(body, ['secretSha256', 'client', 'machine', 'project']);
  if (typeof body.secretSha256 !== 'string' || !SHA256.test(body.secretSha256)) {
    throw invalid('secretSha256 must be 64 lowercase hex characters.');
  }
  const client = singleLine(body.client, 'client', 40);
  const machine = singleLine(body.machine, 'machine', 60);
  const requestedProject = body.project !== undefined ? readProjectProposal(body.project, 'project.') : null;

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

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO agent_connects(id, code_hmac, secret_hmac, client, machine, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(id, codeHmac, secretHmac, client, machine, now, expiresAt),
  ];
  if (requestedProject) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO project_requests(id, connect_id, slug, name, created_at, expires_at) VALUES(?,?,?,?,?,?)',
      ).bind(newId('prq', now), id, requestedProject.slug, requestedProject.name, now, expiresAt),
    );
  }
  await env.DB.batch(statements);

  return Response.json({
    id,
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    url: `${origins(env).app}/connect`,
    expiresAt,
    interval: 3,
    ...(requestedProject ? { project: requestedProject } : {}),
  }, { status: 201 });
}

/** POST /v1/projects/requests — an owner's connected agent asks the owner to approve creating a new project. */
export async function startProjectRequest(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  if (!caller.isOwner) throw new ApiError('forbidden', 'Only the owner’s agents can request new projects.');
  const [byKey, byCopy] = await Promise.all([
    env.AUTH_LIMIT.limit({ key: `project-req:${caller.keyId}` }),
    env.SIGNIN_LIMIT.limit({ key: 'project-req:copy' }),
  ]);
  if (!byKey.success || !byCopy.success) throw new ApiError('rate_limited', 'Too many requests.');

  const { body } = await readJson(ctx.request);
  const { slug, name } = readProjectProposal(body);

  const now = Date.now(), expiresAt = now + TEN_MINUTES;
  const id = newId('prq', now);
  const code = newCode();
  const codeHmac = await connectCodeHmac(env, code);

  await env.DB.prepare(
    'INSERT INTO project_requests(id, key_id, code_hmac, slug, name, created_at, expires_at) VALUES(?,?,?,?,?,?,?)',
  ).bind(id, caller.keyId, codeHmac, slug, name, now, expiresAt).run();

  return Response.json({
    id,
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    url: `${origins(env).app}/connect`,
    slug,
    name,
    expiresAt,
    interval: 3,
  }, { status: 201 });
}

/** GET /v1/projects/requests/{id} — polled by the requesting agent key until approved (200), refused (403), or expired (404). */
export async function getProjectRequest(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  const id = ctx.params[0]!;
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT id, key_id, slug, name, expires_at, answered_at, project_id FROM project_requests WHERE id = ?',
  ).bind(id).first<{
    id: string;
    key_id: string | null;
    slug: string;
    name: string;
    expires_at: number;
    answered_at: number | null;
    project_id: string | null;
  }>();
  if (!row || row.key_id !== caller.keyId) throw notFound();
  if (row.project_id !== null) {
    const proj = await env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE id = ?')
      .bind(row.project_id).first<{ id: string; slug: string; name_en: string; name_ar: string }>();
    if (!proj) throw notFound();
    return Response.json({
      id: row.id,
      status: 'approved',
      project: projectJson(proj),
    });
  }
  if (row.answered_at !== null) throw new ApiError('forbidden', 'Project request was refused.');
  if (row.expires_at <= now) throw notFound();
  return new Response(null, { status: 202 });
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
