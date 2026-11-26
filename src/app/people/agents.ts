import { hmacHex, readSecret } from '../../shared/crypto';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isOn } from '../../shared/switches';
import { type Scope, SCOPES } from '../api/auth';
import { integer, onlyKeys, readJson, text } from '../api/body';
import { mustChange } from '../api/idempotency';
import { openProject, visibleProjects } from './access';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly, stillOwner } from './settings';

/** A person's agents and their keys. Keys for CI and containers are made here; other agents connect (S11). */

const MANAGER = 4, DAY = 86_400_000, MAX_PROJECTS = 20, MAX_KEYS = 100;

/** The owner, or someone who manages a project: others have no use for an agent. */
async function managesSomething(ctx: SignedIn): Promise<void> {
  if (ctx.person.isOwner) return;
  if (!(await visibleProjects(ctx.env, ctx.person)).some((p) => p.level >= MANAGER)) throw new ApiError('forbidden', 'Your level does not allow this.');
}

interface KeyRow { id: string; agent_id: string; label: string | null; scopes_json: string; all_projects: number; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }

/** Keys that were revoked or ended are listed for 30 days. When teams is on, the owner sees every member's agents too. */
export async function listAgents(ctx: SignedIn): Promise<Response> {
  await managesSomething(ctx);
  const { env, person } = ctx, since = Date.now() - 30 * DAY;
  const allAgents = person.isOwner && (await isOn(env.DB, 'teams'));
  const [agents, keys, projects] = await env.DB.batch(
    allAgents
      ? [
          env.DB.prepare('SELECT a.id, a.name, a.created_at, a.disabled_at, a.member_id, m.name owner_name FROM agents a JOIN members m ON m.id = a.member_id ORDER BY a.name, a.id LIMIT 200'),
          env.DB.prepare(`SELECT k.id, k.agent_id, k.label, k.scopes_json, k.all_projects, k.created_at, k.expires_at, k.last_used_at, k.revoked_at FROM agent_keys k
            WHERE (k.revoked_at IS NULL OR k.revoked_at > ?) AND k.expires_at > ?`).bind(since, since),
          env.DB.prepare(`SELECT kp.key_id, p.slug, p.name_en, p.name_ar FROM agent_key_projects kp JOIN projects p ON p.id = kp.project_id`),
        ]
      : [
          env.DB.prepare('SELECT a.id, a.name, a.created_at, a.disabled_at, a.member_id, m.name owner_name FROM agents a JOIN members m ON m.id = a.member_id WHERE a.member_id = ? ORDER BY a.name LIMIT 200').bind(person.memberId),
          env.DB.prepare(`SELECT k.id, k.agent_id, k.label, k.scopes_json, k.all_projects, k.created_at, k.expires_at, k.last_used_at, k.revoked_at FROM agents a CROSS JOIN agent_keys k ON k.agent_id = a.id
            WHERE a.member_id = ? AND (k.revoked_at IS NULL OR k.revoked_at > ?) AND k.expires_at > ?`).bind(person.memberId, since, since),
          env.DB.prepare(`SELECT kp.key_id, p.slug, p.name_en, p.name_ar FROM agents a CROSS JOIN agent_keys k ON k.agent_id = a.id CROSS JOIN agent_key_projects kp ON kp.key_id = k.id CROSS JOIN projects p ON p.id = kp.project_id WHERE a.member_id = ?`).bind(person.memberId),
        ],
  );
  const of = new Map<string, { slug: string; name: { en: string; ar: string } }[]>();
  for (const row of projects!.results as { key_id: string; slug: string; name_en: string; name_ar: string }[]) of.set(row.key_id, [...(of.get(row.key_id) ?? []), { slug: row.slug, name: { en: row.name_en, ar: row.name_ar } }]);
  const rows = (keys!.results as KeyRow[]).sort((a, b) => b.created_at - a.created_at);
  return Response.json({
    items: (agents!.results as { id: string; name: string; created_at: number; disabled_at: number | null; member_id: string; owner_name: string | null }[]).map((a) => ({
      id: a.id, name: a.name, createdAt: a.created_at, disabledAt: a.disabled_at,
      owner: { id: a.member_id, name: a.owner_name }, isMine: a.member_id === person.memberId,
      keys: rows.filter((k) => k.agent_id === a.id).map((k) => ({
        id: k.id, label: k.label, scopes: JSON.parse(k.scopes_json) as string[], allProjects: k.all_projects === 1, projects: of.get(k.id) ?? [],
        createdAt: k.created_at, expiresAt: k.expires_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at,
      })),
    })),
  });
}

export const readAgentName = (value: unknown): string => {
  const name = text(value, 'agent', { min: 1, max: 60 }).trim().normalize('NFC');
  if (/[\n\r\t]/.test(name)) throw invalid('agent must be one line.');
  return name;
};

/** The browser makes the secret and sends only its SHA-256, so the server never has it. */
export async function addKey(ctx: SignedIn): Promise<Response> {
  await managesSomething(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['agent', 'secretSha256', 'scopes', 'projects', 'days', 'label']);
  const agent = readAgentName(body.agent), label = body.label === undefined ? '' : text(body.label, 'label', { max: 60 }).trim(), days = integer(body.days, 'days', 1, 365);
  if (typeof body.secretSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.secretSha256)) throw invalid('secretSha256 must be 64 lowercase hex characters.');
  if (!Array.isArray(body.scopes) || body.scopes.length === 0 || new Set(body.scopes).size !== body.scopes.length || !body.scopes.every((s) => SCOPES.includes(s as Scope))) throw invalid('scopes must be a list of scopes.');
  const all = body.projects === 'all';
  if (all && !person.isOwner) throw new ApiError('forbidden', 'Only the owner’s agents can have every project.');
  let projects: string[] = [];
  if (!all) {
    if (!Array.isArray(body.projects) || body.projects.length === 0 || body.projects.length > MAX_PROJECTS || !body.projects.every((p) => typeof p === 'string')) throw invalid(`projects must be "all" or a list of 1 to ${MAX_PROJECTS}.`);
    projects = await Promise.all([...new Set(body.projects as string[])].map(async (slug) => {
      const { project, level } = await openProject(env, person, slug, 1);
      if (level < MANAGER) throw new ApiError('forbidden', 'Your level does not allow this.');
      return project.id;
    }));
  }
  const now = Date.now(), keyId = newId('key', now), hmac = await hmacHex(await readSecret(env.PEPPER), `${keyId}:${body.secretSha256}`);
  const { results: live } = await env.DB.prepare('SELECT k.id FROM agents a CROSS JOIN agent_keys k ON k.agent_id = a.id WHERE a.member_id = ? AND k.revoked_at IS NULL AND k.expires_at > ? LIMIT ?').bind(person.memberId, now, MAX_KEYS).all();
  if (live.length >= MAX_KEYS) throw conflict('Too many keys. Revoke some first.');
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO agents(id, member_id, name, created_at) VALUES(?,?,?,?) ON CONFLICT(member_id, name) DO NOTHING').bind(newId('agt', now), person.memberId, agent, now),
      env.DB.prepare(`INSERT INTO agent_keys(id, agent_id, secret_hmac, scopes_json, all_projects, created_at, expires_at, label)
        SELECT ?, a.id, ?, ?, ?, ?, ?, ? FROM agents a WHERE a.member_id = ? AND a.name = ?
          AND (SELECT COUNT(*) FROM (
            SELECT 1 FROM agents a2 CROSS JOIN agent_keys k2 ON k2.agent_id = a2.id
            WHERE a2.member_id = ? AND k2.revoked_at IS NULL AND k2.expires_at > ? LIMIT ?
          )) < ?`)
        .bind(keyId, hmac, JSON.stringify(SCOPES.filter((s) => (body.scopes as string[]).includes(s))), all ? 1 : 0, now, now + days * DAY, label || null, person.memberId, agent, person.memberId, now, MAX_KEYS, MAX_KEYS),
      mustChange(env),
      env.DB.prepare('INSERT INTO agent_key_projects(key_id, project_id) SELECT ?, value FROM json_each(?)').bind(keyId, JSON.stringify(projects)),
      auditStatement(env, person.memberId, 'key.add', keyId),
    ]);
  } catch (error) {
    const msg = String(error);
    // The agent is disabled, the 100-key cap was reached concurrently, or the person lost the level since it was read.
    if (msg.includes('key not allowed')) throw conflict('The agent is off, or a project is not yours to give anymore.');
    if (msg.includes('malformed JSON')) throw conflict('Too many keys. Revoke some first.');
    throw error;
  }
  return Response.json({ id: keyId, expiresAt: now + days * DAY }, { status: 201 });
}

export async function revokeKey(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!, now = Date.now();
  const key = await env.DB.prepare('SELECT k.revoked_at, a.member_id FROM agent_keys k JOIN agents a ON a.id = k.agent_id WHERE k.id = ?').bind(id).first<{ revoked_at: number | null; member_id: string }>();
  if (!key || (key.member_id !== person.memberId && !person.isOwner)) throw notFound();
  if (key.revoked_at === null) {
    try {
      await env.DB.batch([
        env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = ?1 WHERE k.id = ?2 AND m.removed_at IS NULL AND (a.member_id = m.id OR m.role = 'owner')) THEN 1 ELSE json('forbidden') END").bind(person.memberId, id),
        env.DB.prepare('UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now, id),
        env.DB.prepare("INSERT INTO audit(at, actor_type, actor_id, action, subject_id) SELECT ?, 'member', ?, 'key.revoke', ? WHERE changes() = 1").bind(now, person.memberId, id),
      ]);
    } catch (error) {
      if (String(error).includes('malformed JSON')) throw notFound();
      throw error;
    }
  }
  return new Response(null, { status: 204 });
}

/** Off: none of its keys work. On again: those that weren't revoked do. */
export async function setAgentOff(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!, { body } = await readJson(ctx.request);
  onlyKeys(body, ['off']);
  if (typeof body.off !== 'boolean') throw invalid('off must be true or false.');
  const agent = await env.DB.prepare('SELECT member_id FROM agents WHERE id = ?').bind(id).first<{ member_id: string }>();
  if (!agent || (agent.member_id !== person.memberId && !person.isOwner)) throw notFound();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM agents a JOIN members m ON m.id = ?1 WHERE a.id = ?2 AND m.removed_at IS NULL AND (a.member_id = m.id OR m.role = 'owner')) THEN 1 ELSE json('forbidden') END").bind(person.memberId, id),
      env.DB.prepare(`UPDATE agents SET disabled_at = ? WHERE id = ? AND disabled_at IS ${body.off ? '' : 'NOT '}NULL`).bind(body.off ? now : null, id),
      env.DB.prepare("INSERT INTO audit(at, actor_type, actor_id, action, subject_id) SELECT ?, 'member', ?, ?, ? WHERE changes() = 1").bind(now, person.memberId, body.off ? 'agent.off' : 'agent.on', id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw notFound();
    throw error;
  }
  return new Response(null, { status: 204 });
}

/** Owner takes over another member's agent to keep its history; trigger revokes all its old keys atomically. */
export async function takeOverAgent(ctx: SignedIn): Promise<Response> {
  if (!(await isOn(ctx.env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
  ownerOnly(ctx);
  const { env, person } = ctx, id = ctx.params[0]!;
  const agent = await env.DB.prepare('SELECT id, member_id, name FROM agents WHERE id = ?').bind(id).first<{ id: string; member_id: string; name: string }>();
  if (!agent) throw notFound();
  if (agent.member_id === person.memberId) throw conflict('This agent is already yours.');

  const collision = await env.DB.prepare('SELECT 1 FROM agents WHERE member_id = ? AND name = ?').bind(person.memberId, agent.name).first();
  const suffix = ` (${agent.id})`;
  const nextName = collision ? `${[...agent.name].slice(0, Math.max(1, 60 - suffix.length)).join('')}${suffix}` : agent.name;

  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('UPDATE agents SET member_id = ?, name = ? WHERE id = ? AND member_id <> ?').bind(person.memberId, nextName, id, person.memberId),
      mustChange(env),
      auditStatement(env, person.memberId, 'agent.takeover', id),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed')) throw conflict('That agent name is already used.');
    if (msg.includes('malformed JSON')) throw conflict('This agent could not be taken over.');
    throw error;
  }
  return Response.json({ id, name: nextName });
}
