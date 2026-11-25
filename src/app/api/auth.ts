import type { AppEnv } from '../../shared/env';
import { equalInConstantTime, hmacHex, readSecret, sha256Hex } from '../../shared/crypto';
import { ApiError, notFound } from '../../shared/errors';
import { isOn } from '../../shared/switches';

export const SCOPES = ['pages:read', 'pages:write', 'decisions:read', 'comments:read', 'comments:write'] as const;
export type Scope = (typeof SCOPES)[number];

/** The agent behind a request. */
export interface Caller {
  keyId: string;
  agentId: string;
  agentName: string;
  memberId: string;
  isOwner: boolean;
  allProjects: boolean;
  scopes: ReadonlySet<string>;
  expiresAt: number;
}

export interface Project {
  id: string;
  slug: string;
  name_en: string;
  name_ar: string;
}

const KEY = /^Bearer lawh_(key_[0-9A-HJKMNP-TV-Z]{26})_([A-Za-z0-9_-]{43})$/;
const HOUR = 3_600_000;

/** HMAC-SHA256(pepper, keyId + ':' + lowercase hex SHA-256 of the secret's text). */
export async function keyHmac(env: AppEnv, keyId: string, secret: string): Promise<string> {
  return hmacHex(await readSecret(env.PEPPER), `${keyId}:${await sha256Hex(secret)}`);
}

interface KeyRow {
  secret_hmac: string; scopes_json: string; all_projects: number; expires_at: number; last_used_at: number | null;
  agent_id: string; agent_name: string; member_id: string; role: string;
}

export async function authenticate(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Caller> {
  const match = KEY.exec(request.headers.get('Authorization') ?? '');
  const now = Date.now();
  if (match) {
    const [, keyId, secret] = match as unknown as [string, string, string];
    const row = await env.DB.prepare(
      `SELECT k.secret_hmac, k.scopes_json, k.all_projects, k.expires_at, k.last_used_at, k.agent_id, a.name agent_name, a.member_id, m.role
       FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = a.member_id
       WHERE k.id = ? AND k.revoked_at IS NULL AND a.disabled_at IS NULL AND m.removed_at IS NULL`,
    ).bind(keyId).first<KeyRow>();
    // Computed for an unknown key too, so a known id can't be told by its timing.
    const same = equalInConstantTime(await keyHmac(env, keyId, secret), row?.secret_hmac ?? '0'.repeat(64));
    if (row && same && row.expires_at > now) {
      if (!(await env.KEY_LIMIT.limit({ key: keyId })).success) throw new ApiError('rate_limited', 'Too many requests.');
      const isOwner = row.role === 'owner';
      if (!isOwner && !(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
      if (row.last_used_at === null || row.last_used_at < now - HOUR) {
        ctx.waitUntil(env.DB.prepare('UPDATE agent_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 3600000)')
          .bind(now, keyId).run().catch(() => undefined));
      }
      return {
        keyId, agentId: row.agent_id, agentName: row.agent_name, memberId: row.member_id, isOwner,
        allProjects: isOwner && row.all_projects === 1,
        scopes: new Set(JSON.parse(row.scopes_json) as string[]), expiresAt: row.expires_at,
      };
    }
  }
  // Only failures count, and after the lookup, so agents behind one address can't lock each other out.
  const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.AUTH_LIMIT.limit({ key: address })).success) throw new ApiError('rate_limited', 'Too many requests.');
  throw new ApiError('unauthorized', 'A valid agent key is needed.');
}

export function needScope(caller: Caller, scope: Scope | 'any'): void {
  if (scope !== 'any' && !caller.scopes.has(scope)) throw new ApiError('forbidden', `This key doesn't have ${scope}.`);
}

/** Whether the key works in a project now: it lists the project, and its person is the owner or manages it. */
async function canUse(env: AppEnv, caller: Caller, projectId: string): Promise<boolean> {
  if (caller.allProjects) return true;
  const query = caller.isOwner
    ? env.DB.prepare('SELECT 1 FROM agent_key_projects WHERE key_id = ? AND project_id = ?').bind(caller.keyId, projectId)
    : env.DB.prepare(
      `SELECT 1 FROM agent_key_projects kp CROSS JOIN project_access x ON x.member_id = ? AND x.project_id = kp.project_id AND x.level = 4
       WHERE kp.key_id = ? AND kp.project_id = ?`).bind(caller.memberId, caller.keyId, projectId);
  return (await query.first()) !== null;
}

/** 404, never 403: a key doesn't learn which other projects exist. */
export async function projectBySlug(env: AppEnv, caller: Caller, slug: string): Promise<Project> {
  const project = await env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE slug = ?').bind(slug).first<Project>();
  if (!project || !(await canUse(env, caller, project.id))) throw notFound();
  return project;
}

export async function projectById(env: AppEnv, caller: Caller, id: string): Promise<Project> {
  const project = await env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE id = ?').bind(id).first<Project>();
  if (!project || !(await canUse(env, caller, project.id))) throw notFound();
  return project;
}

/** The projects a key can use now. An `all projects` key reads every project: there are few, and no filter to index. */
export async function usableProjects(env: AppEnv, caller: Caller): Promise<Project[]> {
  const columns = 'p.id, p.slug, p.name_en, p.name_ar';
  const query = caller.allProjects
    ? env.DB.prepare(`SELECT ${columns} FROM projects p WHERE p.slug > '' ORDER BY p.slug LIMIT 1000`)
    : caller.isOwner
      ? env.DB.prepare(`SELECT ${columns} FROM agent_key_projects kp JOIN projects p ON p.id = kp.project_id WHERE kp.key_id = ?`).bind(caller.keyId)
      : env.DB.prepare(
        `SELECT ${columns} FROM agent_key_projects kp JOIN projects p ON p.id = kp.project_id
         WHERE kp.key_id = ? AND EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = ? AND x.project_id = kp.project_id AND x.level = 4)`)
        .bind(caller.keyId, caller.memberId);
  return (await query.all<Project>()).results.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export async function projectsById(env: AppEnv, ids: string[]): Promise<Project[]> {
  return (await env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(ids)])).all<Project>()).results;
}

export const projectJson = (p: Project) => ({ slug: p.slug, name: { en: p.name_en, ar: p.name_ar } });
