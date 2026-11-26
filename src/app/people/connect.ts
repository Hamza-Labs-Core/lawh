import { equalInConstantTime } from '../../shared/crypto';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { SCOPES } from '../api/auth';
import { onlyKeys, readJson } from '../api/body';
import { connectCodeHmac } from '../api/connect';
import { mustChange } from '../api/idempotency';
import { openProject, visibleProjects } from './access';
import { readAgentName } from './agents';
import type { SignedIn } from './router';
import { auditStatement } from './session';

const MANAGER = 4, DAY = 86_400_000, DEFAULT_DAYS = 90, MAX_PROJECTS = 20, MAX_KEYS = 100;

async function managedProjects(ctx: SignedIn) {
  const projects = (await visibleProjects(ctx.env, ctx.person)).filter((p) => p.level >= MANAGER);
  if (!ctx.person.isOwner && projects.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');
  return projects;
}

/** POST /app-api/connect/look — look up an open agent connection request by its typed code. */
export async function lookAtConnect(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const projects = await managedProjects(ctx);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['code']);
  if (!(await env.CODE_LIMIT.limit({ key: person.sessionId })).success) throw new ApiError('rate_limited', 'Too many codes. Wait a minute.');
  if (typeof body.code !== 'string' || body.code.length > 40) throw notFound();

  const row = await env.DB.prepare(
    'SELECT id, client, machine, created_at, expires_at FROM agent_connects WHERE code_hmac = ? AND expires_at > ? AND answered_at IS NULL',
  ).bind(await connectCodeHmac(env, body.code), Date.now()).first<{
    id: string; client: string; machine: string; created_at: number; expires_at: number;
  }>();
  if (!row) throw notFound();

  const { results: agents } = await env.DB.prepare(
    'SELECT id, name FROM agents WHERE member_id = ? AND disabled_at IS NULL ORDER BY name LIMIT 200',
  ).bind(person.memberId).all<{ id: string; name: string }>();

  return Response.json({
    id: row.id,
    client: row.client,
    machine: row.machine,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    agents,
    projects: projects.map((p) => ({ slug: p.slug, name: { en: p.name_en, ar: p.name_ar } })),
  });
}

/** POST /app-api/connect/answer — approve (creating the key via DB trigger) or refuse an agent connection request. */
export async function answerConnect(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  await managedProjects(ctx);
  const { body } = await readJson(ctx.request);
  if (body.refuse === true) {
    onlyKeys(body, ['id', 'code', 'refuse']);
  } else {
    onlyKeys(body, ['id', 'code', 'refuse', 'agentId', 'agentName', 'projects']);
  }
  if (typeof body.id !== 'string' || typeof body.code !== 'string' || body.code.length > 40) throw notFound();
  if (body.refuse !== undefined && typeof body.refuse !== 'boolean') throw invalid('refuse must be true or false.');

  const now = Date.now();
  const reqRow = await env.DB.prepare(
    'SELECT id, code_hmac, client FROM agent_connects WHERE id = ? AND expires_at > ? AND answered_at IS NULL',
  ).bind(body.id, now).first<{ id: string; code_hmac: string; client: string }>();
  if (!reqRow || !equalInConstantTime(await connectCodeHmac(env, body.code), reqRow.code_hmac)) throw notFound();

  if (body.refuse === true) {
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE agent_connects SET answered_at = ?, member_id = ?, approver_session = ? WHERE id = ? AND answered_at IS NULL')
          .bind(now, person.memberId, person.sessionId, reqRow.id),
        mustChange(env),
        auditStatement(env, person.memberId, 'connect.refuse', reqRow.id),
      ]);
    } catch (error) {
      if (/not allowed|malformed JSON/.test(String(error))) throw notFound();
      throw error;
    }
    return new Response(null, { status: 204 });
  }

  // Approve: either an existing agent id owned by this person, or a new/existing agent name.
  const hasId = body.agentId !== undefined && body.agentId !== null && body.agentId !== '';
  const hasName = body.agentName !== undefined && body.agentName !== null && body.agentName !== '';
  if (hasId === hasName) throw invalid('Provide either agentId or agentName.');
  let agentId: string | null = null;
  let agentName: string | null = null;
  if (hasId) {
    if (typeof body.agentId !== 'string' || body.agentId.length === 0 || body.agentId.length > 64) throw invalid('Invalid agentId.');
    const existing = await env.DB.prepare('SELECT id, name, disabled_at FROM agents WHERE id = ? AND member_id = ?')
      .bind(body.agentId, person.memberId).first<{ id: string; name: string; disabled_at: number | null }>();
    if (!existing) throw notFound();
    if (existing.disabled_at !== null) throw conflict('This agent is off.');
    agentId = existing.id;
    agentName = existing.name;
  } else {
    agentName = readAgentName(body.agentName);
  }

  const all = body.projects === 'all';
  if (all && !person.isOwner) throw new ApiError('forbidden', 'Only the owner’s agents can have every project.');
  let projectIds: string[] = [];
  if (!all) {
    if (!Array.isArray(body.projects) || body.projects.length === 0 || body.projects.length > MAX_PROJECTS || !body.projects.every((p) => typeof p === 'string')) {
      throw invalid(`projects must be "all" or a list of 1 to ${MAX_PROJECTS}.`);
    }
    projectIds = await Promise.all([...new Set(body.projects as string[])].map(async (slug) => {
      const { project, level } = await openProject(env, person, slug, 1);
      if (level < MANAGER) throw new ApiError('forbidden', 'Your level does not allow this.');
      return project.id;
    }));
  }

  const { results: live } = await env.DB.prepare(
    'SELECT k.id FROM agents a CROSS JOIN agent_keys k ON k.agent_id = a.id WHERE a.member_id = ? AND k.revoked_at IS NULL AND k.expires_at > ? LIMIT ?',
  ).bind(person.memberId, now, MAX_KEYS).all();
  if (live.length >= MAX_KEYS) throw conflict('Too many keys. Revoke some first.');

  const keyExpiresAt = now + DEFAULT_DAYS * DAY;
  const scopesJson = JSON.stringify(SCOPES);
  const projectsJson = JSON.stringify(projectIds);

  try {
    const statements: D1PreparedStatement[] = [];
    if (agentId === null) {
      // Only creates the agent while the connect request is still open and in date (security.md §5).
      statements.push(
        env.DB.prepare(
          `INSERT INTO agents(id, member_id, name, provider, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM agent_connects WHERE id = ? AND answered_at IS NULL AND expires_at > ?)
           ON CONFLICT(member_id, name) DO NOTHING`,
        ).bind(newId('agt', now), person.memberId, agentName, reqRow.client, now, reqRow.id, now),
        env.DB.prepare(
          `UPDATE agent_connects
           SET answered_at = ?, member_id = ?, approver_session = ?,
               agent_id = (SELECT id FROM agents WHERE member_id = ? AND name = ?),
               scopes_json = ?, all_projects = ?, projects_json = ?, key_expires_at = ?
           WHERE id = ? AND answered_at IS NULL`,
        ).bind(now, person.memberId, person.sessionId, person.memberId, agentName, scopesJson, all ? 1 : 0, projectsJson, keyExpiresAt, reqRow.id),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `UPDATE agent_connects
           SET answered_at = ?, member_id = ?, approver_session = ?,
               agent_id = ?, scopes_json = ?, all_projects = ?, projects_json = ?, key_expires_at = ?
           WHERE id = ? AND answered_at IS NULL`,
        ).bind(now, person.memberId, person.sessionId, agentId, scopesJson, all ? 1 : 0, projectsJson, keyExpiresAt, reqRow.id),
      );
    }
    statements.push(mustChange(env), auditStatement(env, person.memberId, 'connect.approve', reqRow.id));
    await env.DB.batch(statements);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('key not allowed')) throw conflict('The agent is off, or a project is not yours to give anymore.');
    if (/connect not allowed|malformed JSON|CHECK constraint failed/.test(msg)) throw notFound();
    throw error;
  }

  return Response.json({ id: reqRow.id, agentName, expiresAt: keyExpiresAt });
}
