import { equalInConstantTime } from '../../shared/crypto';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { SCOPES } from '../api/auth';
import { onlyKeys, readJson } from '../api/body';
import { connectCodeHmac, readProjectProposal } from '../api/connect';
import { mustChange } from '../api/idempotency';
import { openProject, visibleProjects } from './access';
import { readAgentName } from './agents';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { stillOwner } from './settings';

const MANAGER = 4, DAY = 86_400_000, DEFAULT_DAYS = 90, MAX_PROJECTS = 20, MAX_KEYS = 100;
const WRONG_CODE_WINDOW = 600_000, MAX_WRONG_CODES = 5;

interface OpenConnectRow {
  id: string;
  code_hmac: string;
  client: string;
  machine: string;
  created_at: number;
  expires_at: number;
}

interface OpenProjectRequestRow {
  id: string;
  key_id: string;
  code_hmac: string;
  slug: string;
  name: string;
  created_at: number;
  expires_at: number;
}

async function managedProjects(ctx: SignedIn) {
  const projects = (await visibleProjects(ctx.env, ctx.person)).filter((p) => p.level >= MANAGER);
  if (!ctx.person.isOwner && projects.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');
  return projects;
}

const wrongCodeGuard = (env: SignedIn['env'], sessionId: string, cutoff: number) => env.DB.prepare(
  `SELECT CASE WHEN COALESCE(
     (SELECT COUNT(*) FROM idempotency i, json_each(i.response_json) j
      WHERE i.key_id = 'rl:connect-code' AND i.idem_key = ?1 AND j.value > ?2),
     0
   ) < ?3 THEN 1 ELSE json('[') END`,
).bind(sessionId, cutoff, MAX_WRONG_CODES);

const wrongCodeMissStatement = (env: SignedIn['env'], missExists: string, missParams: unknown[]) => env.DB.prepare(
  `INSERT INTO idempotency(key_id, idem_key, request_sha256, status, response_json, expires_at)
   SELECT 'rl:connect-code', ?1, '', 1, json_array(?2), ?3
   WHERE ${missExists}
   ON CONFLICT(key_id, idem_key) DO UPDATE SET
     response_json = (
       SELECT json_group_array(v) FROM (
         SELECT value AS v FROM json_each(idempotency.response_json) WHERE value > ?4
         UNION ALL SELECT ?2
       )
     ),
     status = (
       SELECT COUNT(*) FROM (
         SELECT 1 FROM json_each(idempotency.response_json) WHERE value > ?4
         UNION ALL SELECT 1
       )
     ),
     expires_at = ?3`,
).bind(...missParams);

/**
 * Atomically checks the 5-wrong-codes-per-10-min limit AND looks up either an open `agent_connects` row
 * or a standalone `project_requests` row in one serialized D1 batch.
 */
async function checkAndLookupAny(
  ctx: SignedIn,
  now: number,
  codeHmac: string,
): Promise<{ kind: 'connect'; row: OpenConnectRow } | { kind: 'project'; row: OpenProjectRequestRow } | null> {
  const { env, person } = ctx;
  if (!(await env.CODE_LIMIT.limit({ key: person.sessionId })).success) {
    throw new ApiError('rate_limited', 'Too many codes. Try again later.');
  }
  const cutoff = now - WRONG_CODE_WINDOW;
  const expiresAt = now + WRONG_CODE_WINDOW;
  const missExists = `NOT EXISTS (SELECT 1 FROM agent_connects WHERE code_hmac = ?5 AND expires_at > ?2 AND answered_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM project_requests WHERE code_hmac = ?5 AND key_id IS NOT NULL AND expires_at > ?2 AND answered_at IS NULL)`;

  try {
    const [, connectRes, projectRes] = await env.DB.batch([
      wrongCodeGuard(env, person.sessionId, cutoff),
      env.DB.prepare(
        'SELECT id, code_hmac, client, machine, created_at, expires_at FROM agent_connects WHERE code_hmac = ?1 AND expires_at > ?2 AND answered_at IS NULL',
      ).bind(codeHmac, now),
      env.DB.prepare(
        'SELECT id, key_id, code_hmac, slug, name, created_at, expires_at FROM project_requests WHERE code_hmac = ?1 AND key_id IS NOT NULL AND expires_at > ?2 AND answered_at IS NULL',
      ).bind(codeHmac, now),
      wrongCodeMissStatement(env, missExists, [person.sessionId, now, expiresAt, cutoff, codeHmac]),
    ]);
    const connectRow = connectRes!.results[0] as OpenConnectRow | undefined;
    if (connectRow) return { kind: 'connect', row: connectRow };
    const projectRow = projectRes!.results[0] as OpenProjectRequestRow | undefined;
    if (projectRow) return { kind: 'project', row: projectRow };
    return null;
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      throw new ApiError('rate_limited', 'Too many wrong codes. Try again later.');
    }
    throw error;
  }
}

async function checkAndLookupConnect(
  ctx: SignedIn,
  now: number,
  lookup: { codeHmac: string; id: string },
): Promise<OpenConnectRow | null> {
  const { env, person } = ctx;
  if (!(await env.CODE_LIMIT.limit({ key: person.sessionId })).success) {
    throw new ApiError('rate_limited', 'Too many codes. Try again later.');
  }
  const cutoff = now - WRONG_CODE_WINDOW;
  const expiresAt = now + WRONG_CODE_WINDOW;
  const missExists = 'NOT EXISTS (SELECT 1 FROM agent_connects WHERE id = ?5 AND code_hmac = ?6 AND expires_at > ?2 AND answered_at IS NULL)';
  try {
    const [, foundRes] = await env.DB.batch([
      wrongCodeGuard(env, person.sessionId, cutoff),
      env.DB.prepare(
        'SELECT id, code_hmac, client, machine, created_at, expires_at FROM agent_connects WHERE id = ?1 AND code_hmac = ?2 AND expires_at > ?3 AND answered_at IS NULL',
      ).bind(lookup.id, lookup.codeHmac, now),
      wrongCodeMissStatement(env, missExists, [person.sessionId, now, expiresAt, cutoff, lookup.id, lookup.codeHmac]),
    ]);
    return (foundRes!.results[0] as OpenConnectRow | undefined) ?? null;
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      throw new ApiError('rate_limited', 'Too many wrong codes. Try again later.');
    }
    throw error;
  }
}

async function checkAndLookupProjectRequest(
  ctx: SignedIn,
  now: number,
  lookup: { codeHmac: string; id: string },
): Promise<OpenProjectRequestRow | null> {
  const { env, person } = ctx;
  if (!(await env.CODE_LIMIT.limit({ key: person.sessionId })).success) {
    throw new ApiError('rate_limited', 'Too many codes. Try again later.');
  }
  const cutoff = now - WRONG_CODE_WINDOW;
  const expiresAt = now + WRONG_CODE_WINDOW;
  const missExists = 'NOT EXISTS (SELECT 1 FROM project_requests WHERE id = ?5 AND code_hmac = ?6 AND key_id IS NOT NULL AND expires_at > ?2 AND answered_at IS NULL)';
  try {
    const [, foundRes] = await env.DB.batch([
      wrongCodeGuard(env, person.sessionId, cutoff),
      env.DB.prepare(
        'SELECT id, key_id, code_hmac, slug, name, created_at, expires_at FROM project_requests WHERE id = ?1 AND code_hmac = ?2 AND key_id IS NOT NULL AND expires_at > ?3 AND answered_at IS NULL',
      ).bind(lookup.id, lookup.codeHmac, now),
      wrongCodeMissStatement(env, missExists, [person.sessionId, now, expiresAt, cutoff, lookup.id, lookup.codeHmac]),
    ]);
    return (foundRes!.results[0] as OpenProjectRequestRow | undefined) ?? null;
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      throw new ApiError('rate_limited', 'Too many wrong codes. Try again later.');
    }
    throw error;
  }
}

/** POST /app-api/connect/look — look up an open agent connection or project creation request by its typed code. */
export async function lookAtConnect(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const projects = await managedProjects(ctx);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['code']);
  const now = Date.now();
  const codeHmac = typeof body.code === 'string' && body.code.length <= 40 ? await connectCodeHmac(env, body.code) : '__invalid__';
  const found = await checkAndLookupAny(ctx, now, codeHmac);
  if (!found) throw notFound();

  if (found.kind === 'project') {
    if (!person.isOwner) throw new ApiError('forbidden', 'Only the owner can approve a new project.');
    const keyInfo = await env.DB.prepare(
      `SELECT k.id, k.all_projects, k.label, a.name AS agent_name
       FROM agent_keys k JOIN agents a ON a.id = k.agent_id
       WHERE k.id = ? AND k.revoked_at IS NULL AND k.expires_at > ? AND a.disabled_at IS NULL AND a.member_id = ?`,
    ).bind(found.row.key_id, now, person.memberId).first<{ id: string; all_projects: number; label: string | null; agent_name: string }>();
    if (!keyInfo) throw notFound();
    return Response.json({
      kind: 'project',
      id: found.row.id,
      agentName: keyInfo.agent_name,
      machine: keyInfo.label ?? '',
      slug: found.row.slug,
      name: found.row.name,
      allProjects: keyInfo.all_projects === 1,
      createdAt: found.row.created_at,
      expiresAt: found.row.expires_at,
    });
  }

  const row = found.row;
  const [agentsRes, reqProjRes] = await env.DB.batch([
    env.DB.prepare(
      'SELECT id, name FROM agents WHERE member_id = ? AND disabled_at IS NULL ORDER BY name LIMIT 200',
    ).bind(person.memberId),
    env.DB.prepare(
      'SELECT slug, name FROM project_requests WHERE connect_id = ? AND answered_at IS NULL',
    ).bind(row.id),
  ]);
  const agents = agentsRes!.results as { id: string; name: string }[];
  const reqProj = (reqProjRes!.results[0] as { slug: string; name: string } | undefined) ?? null;

  return Response.json({
    kind: 'connect',
    id: row.id,
    client: row.client,
    machine: row.machine,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    agents,
    projects: projects.map((p) => ({ slug: p.slug, name: { en: p.name_en, ar: p.name_ar } })),
    requestedProject: person.isOwner && reqProj ? { slug: reqProj.slug, name: reqProj.name } : null,
  });
}

async function answerProjectRequest(ctx: SignedIn, body: Record<string, unknown>, now: number): Promise<Response> {
  const { env, person } = ctx;
  if (!person.isOwner) throw new ApiError('forbidden', 'Only the owner can approve a new project.');
  if (body.refuse === true) {
    onlyKeys(body, ['kind', 'id', 'code', 'refuse']);
  } else {
    onlyKeys(body, ['kind', 'id', 'code', 'refuse', 'name', 'slug']);
  }
  if (body.refuse !== undefined && typeof body.refuse !== 'boolean') throw invalid('refuse must be true or false.');
  const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : '__invalid__';
  const codeHmac = typeof body.code === 'string' && body.code.length <= 40 ? await connectCodeHmac(env, body.code) : '__invalid__';
  const reqRow = await checkAndLookupProjectRequest(ctx, now, { id, codeHmac });
  if (!reqRow || !equalInConstantTime(codeHmac, reqRow.code_hmac)) throw notFound();

  if (body.refuse === true) {
    try {
      await env.DB.batch([
        stillOwner(env, person.memberId),
        env.DB.prepare('UPDATE project_requests SET answered_at = ?, member_id = ?, approver_session = ? WHERE id = ? AND answered_at IS NULL')
          .bind(now, person.memberId, person.sessionId, reqRow.id),
        mustChange(env),
        auditStatement(env, person.memberId, 'project.request.refuse', reqRow.id),
      ]);
    } catch (error) {
      if (/not allowed|malformed JSON/.test(String(error))) throw notFound();
      throw error;
    }
    return new Response(null, { status: 204 });
  }

  const proposed = readProjectProposal({
    name: body.name !== undefined ? body.name : reqRow.name,
    slug: body.slug !== undefined ? body.slug : reqRow.slug,
  });
  const projectId = newId('prj', now);

  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM agent_keys k JOIN agents a ON a.id = k.agent_id
           WHERE k.id = ?1 AND k.revoked_at IS NULL AND k.expires_at > ?2 AND a.disabled_at IS NULL AND a.member_id = ?3
         ) THEN 1 ELSE json('[') END`,
      ).bind(reqRow.key_id, now, person.memberId),
      env.DB.prepare('INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES(?,?,?,?,?)')
        .bind(projectId, proposed.slug, proposed.name, proposed.name, now),
      env.DB.prepare(
        'INSERT OR IGNORE INTO agent_key_projects(key_id, project_id) SELECT k.id, ?1 FROM agent_keys k WHERE k.id = ?2 AND k.all_projects = 0',
      ).bind(projectId, reqRow.key_id),
      env.DB.prepare(
        'UPDATE project_requests SET answered_at = ?, member_id = ?, approver_session = ?, project_id = ?, slug = ?, name = ? WHERE id = ? AND answered_at IS NULL',
      ).bind(now, person.memberId, person.sessionId, projectId, proposed.slug, proposed.name, reqRow.id),
      mustChange(env),
      auditStatement(env, person.memberId, 'project.add', projectId),
      auditStatement(env, person.memberId, 'project.request.approve', reqRow.id),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed: projects.slug')) throw conflict('That address is taken.', { reason: 'slug_taken' });
    if (msg.includes('key not allowed')) throw conflict('The agent is off, or its key is no longer active.');
    if (/not allowed|malformed JSON/.test(msg)) throw notFound();
    throw error;
  }

  return Response.json({
    id: reqRow.id,
    project: { slug: proposed.slug, name: { en: proposed.name, ar: proposed.name } },
  });
}

/** POST /app-api/connect/answer — approve or refuse an agent connection request or standalone project creation request. */
export async function answerConnect(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  await managedProjects(ctx);
  const { body } = await readJson(ctx.request);
  const now = Date.now();
  if (body.kind !== undefined && body.kind !== 'connect' && body.kind !== 'project') {
    throw invalid('kind must be "connect" or "project".');
  }
  if (body.kind === 'project') {
    return answerProjectRequest(ctx, body, now);
  }

  if (body.refuse === true) {
    onlyKeys(body, ['kind', 'id', 'code', 'refuse']);
  } else {
    onlyKeys(body, ['kind', 'id', 'code', 'refuse', 'agentId', 'agentName', 'projects', 'createProject']);
  }
  if (body.refuse !== undefined && typeof body.refuse !== 'boolean') throw invalid('refuse must be true or false.');
  const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : '__invalid__';
  const codeHmac = typeof body.code === 'string' && body.code.length <= 40 ? await connectCodeHmac(env, body.code) : '__invalid__';
  const reqRow = await checkAndLookupConnect(ctx, now, { id, codeHmac });
  if (!reqRow || !equalInConstantTime(codeHmac, reqRow.code_hmac)) throw notFound();

  if (body.refuse === true) {
    try {
      const statements: D1PreparedStatement[] = [
        env.DB.prepare('UPDATE agent_connects SET answered_at = ?, member_id = ?, approver_session = ? WHERE id = ? AND answered_at IS NULL')
          .bind(now, person.memberId, person.sessionId, reqRow.id),
        mustChange(env),
        auditStatement(env, person.memberId, 'connect.refuse', reqRow.id),
      ];
      if (person.isOwner) {
        statements.push(
          env.DB.prepare('UPDATE project_requests SET answered_at = ?, member_id = ?, approver_session = ? WHERE connect_id = ? AND answered_at IS NULL')
            .bind(now, person.memberId, person.sessionId, reqRow.id),
        );
      }
      await env.DB.batch(statements);
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

  const createProject = body.createProject !== undefined ? readProjectProposal(body.createProject, 'createProject.') : null;
  if (createProject && !person.isOwner) {
    throw new ApiError('forbidden', 'Only the owner can create a project.');
  }
  const newProjectId = createProject ? newId('prj', now) : null;

  const all = body.projects === 'all';
  if (all && !person.isOwner) throw new ApiError('forbidden', 'Only the owner’s agents can have every project.');
  let projectIds: string[] = [];
  if (!all) {
    const rawList = body.projects === undefined && createProject ? [] : body.projects;
    const minCount = createProject ? 0 : 1;
    const maxExisting = createProject ? MAX_PROJECTS - 1 : MAX_PROJECTS;
    if (!Array.isArray(rawList) || rawList.length < minCount || rawList.length > maxExisting || !rawList.every((p) => typeof p === 'string')) {
      throw invalid(`projects must be "all" or a list of 1 to ${MAX_PROJECTS}.`);
    }
    projectIds = await Promise.all([...new Set(rawList as string[])].map(async (slug) => {
      const { project, level } = await openProject(env, person, slug, 1);
      if (level < MANAGER) throw new ApiError('forbidden', 'Your level does not allow this.');
      return project.id;
    }));
    if (newProjectId) projectIds.push(newProjectId);
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
    if (createProject && newProjectId) {
      statements.push(
        stillOwner(env, person.memberId),
        env.DB.prepare('INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES(?,?,?,?,?)')
          .bind(newProjectId, createProject.slug, createProject.name, createProject.name, now),
        auditStatement(env, person.memberId, 'project.add', newProjectId),
      );
    }
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
    statements.push(
      mustChange(env),
      // Enforce the 100-key cap atomically inside the same D1 transaction (after trigger inserts the new key).
      env.DB.prepare(
        `SELECT CASE WHEN (
           SELECT COUNT(*) FROM (
             SELECT 1 FROM agents a CROSS JOIN agent_keys k ON k.agent_id = a.id
             WHERE a.member_id = ?1 AND k.revoked_at IS NULL AND k.expires_at > ?2
             LIMIT ?3
           )
         ) <= ?4 THEN 1 ELSE json('[') END`,
      ).bind(person.memberId, now, MAX_KEYS + 1, MAX_KEYS),
      auditStatement(env, person.memberId, 'connect.approve', reqRow.id),
    );
    if (person.isOwner) {
      if (createProject && newProjectId) {
        statements.push(
          env.DB.prepare(
            'UPDATE project_requests SET answered_at = ?, member_id = ?, approver_session = ?, project_id = ?, slug = ?, name = ? WHERE connect_id = ? AND answered_at IS NULL',
          ).bind(now, person.memberId, person.sessionId, newProjectId, createProject.slug, createProject.name, reqRow.id),
        );
      } else {
        statements.push(
          env.DB.prepare(
            'UPDATE project_requests SET answered_at = ?, member_id = ?, approver_session = ? WHERE connect_id = ? AND answered_at IS NULL',
          ).bind(now, person.memberId, person.sessionId, reqRow.id),
        );
      }
    }
    await env.DB.batch(statements);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed: projects.slug')) throw conflict('That address is taken.', { reason: 'slug_taken' });
    if (msg.includes('key not allowed')) throw conflict('The agent is off, or a project is not yours to give anymore.');
    if (msg.includes('malformed JSON')) {
      const stillOpen = await env.DB.prepare(
        'SELECT 1 AS ok FROM agent_connects WHERE id = ? AND answered_at IS NULL AND expires_at > ?',
      ).bind(reqRow.id, now).first<{ ok: number }>();
      if (stillOpen) throw conflict('Too many keys. Revoke some first.');
      throw notFound();
    }
    if (/connect not allowed|project request not allowed|CHECK constraint failed/.test(msg)) throw notFound();
    throw error;
  }

  return Response.json({
    id: reqRow.id,
    agentName,
    expiresAt: keyExpiresAt,
    ...(createProject ? { createdProject: { slug: createProject.slug, name: { en: createProject.name, ar: createProject.name } } } : {}),
  });
}
