import type { AppEnv } from '../../shared/env';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isOn } from '../../shared/switches';
import { integer, onlyKeys, readJson, text } from '../api/body';
import { mustChange } from '../api/idempotency';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly, stillOwner } from './settings';

const MANAGER = 4;

async function needTeams(env: AppEnv): Promise<void> {
  if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
}

function readTeamName(value: unknown): string {
  const name = text(value, 'name', { min: 1, max: 60 }).trim().normalize('NFC');
  if (/[\n\r\t]/.test(name)) throw invalid('name must be one line.');
  return name;
}

/** Verify the caller is owner or manages at least one team, and optionally manages a specific team. */
async function checkTeamAccess(ctx: SignedIn, teamId?: string): Promise<void> {
  if (ctx.person.isOwner) return;
  const { results } = await ctx.env.DB.prepare(
    'SELECT team_id FROM team_members WHERE member_id = ? AND level = 4',
  ).bind(ctx.person.memberId).all<{ team_id: string }>();
  if (results.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');
  if (teamId !== undefined && !results.some((r) => r.team_id === teamId)) throw notFound();
}

/** GET /app-api/teams — owner sees all teams and projects; a team manager sees only the teams they manage. */
export async function listTeams(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  await checkTeamAccess(ctx);
  const { env, person } = ctx;

  const teamsStmt = person.isOwner
    ? env.DB.prepare('SELECT id, name, created_at FROM teams ORDER BY name, id LIMIT 200')
    : env.DB.prepare(
        `SELECT t.id, t.name, t.created_at FROM team_members m
         JOIN teams t ON t.id = m.team_id
         WHERE m.member_id = ? AND m.level = 4
         ORDER BY t.name, t.id LIMIT 200`,
      ).bind(person.memberId);

  const [teamsRes, availableMembersRes, availableProjectsRes] = await env.DB.batch([
    teamsStmt,
    env.DB.prepare(
      "SELECT id, name FROM members WHERE role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL ORDER BY name, id LIMIT 500",
    ),
    person.isOwner
      ? env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects ORDER BY slug LIMIT 1000')
      : env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE 1 = 0'),
  ]);

  const teams = teamsRes!.results as { id: string; name: string; created_at: number }[];
  const teamIds = teams.map((t) => t.id);

  let memberRows: { team_id: string; member_id: string; name: string | null; level: number; set_at: number }[] = [];
  let projectRows: { team_id: string; slug: string; name_en: string; name_ar: string }[] = [];

  if (teamIds.length > 0) {
    const [mRes, pRes] = await env.DB.batch([
      env.DB.prepare(
        `SELECT t.team_id, t.member_id, m.name, t.level, t.set_at
         FROM json_each(?) j
         CROSS JOIN team_members t ON t.team_id = j.value
         JOIN members m ON m.id = t.member_id
         ORDER BY t.team_id, m.name, t.member_id`,
      ).bind(JSON.stringify(teamIds)),
      env.DB.prepare(
        `SELECT t.team_id, p.slug, p.name_en, p.name_ar
         FROM json_each(?) j
         CROSS JOIN team_projects t ON t.team_id = j.value
         JOIN projects p ON p.id = t.project_id
         ORDER BY t.team_id, p.slug`,
      ).bind(JSON.stringify(teamIds)),
    ]);
    memberRows = mRes!.results as typeof memberRows;
    projectRows = pRes!.results as typeof projectRows;
  }

  return Response.json({
    items: teams.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.created_at,
      members: memberRows
        .filter((m) => m.team_id === t.id)
        .map((m) => ({ id: m.member_id, name: m.name, level: m.level, setAt: m.set_at })),
      projects: projectRows
        .filter((p) => p.team_id === t.id)
        .map((p) => ({ slug: p.slug, name: { en: p.name_en, ar: p.name_ar } })),
    })),
    availableMembers: (availableMembersRes!.results as { id: string; name: string }[]).map((m) => ({
      id: m.id,
      name: m.name,
    })),
    availableProjects: (availableProjectsRes!.results as { slug: string; name_en: string; name_ar: string }[]).map((p) => ({
      slug: p.slug,
      name: { en: p.name_en, ar: p.name_ar },
    })),
  });
}

/** POST /app-api/teams — owner creates a team. */
export async function addTeam(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['name']);
  const name = readTeamName(body.name);
  const now = Date.now(), id = newId('tem', now);
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('INSERT INTO teams(id, name, created_at) VALUES(?,?,?)').bind(id, name, now),
      auditStatement(env, person.memberId, 'team.add', id),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed')) throw conflict('That team name is already used.');
    if (msg.includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ id, name, createdAt: now }, { status: 201 });
}

/** PATCH /app-api/teams/:id — owner renames a team. */
export async function renameTeam(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, id = ctx.params[0]!, { body } = await readJson(ctx.request);
  onlyKeys(body, ['name']);
  const name = readTeamName(body.name);
  const existing = await env.DB.prepare('SELECT id FROM teams WHERE id = ?').bind(id).first();
  if (!existing) throw notFound();
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, id),
      mustChange(env),
      auditStatement(env, person.memberId, 'team.rename', id),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed')) throw conflict('That team name is already used.');
    if (msg.includes('malformed JSON')) {
      const still = await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first();
      if (!still) throw notFound();
      throw new ApiError('forbidden', 'Only the owner can do this.');
    }
    throw error;
  }
  return Response.json({ id, name });
}

/** DELETE /app-api/teams/:id — owner deletes a team (cascades memberships/projects and cancels pending invites). */
export async function deleteTeam(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, id = ctx.params[0]!;
  const existing = await env.DB.prepare('SELECT id FROM teams WHERE id = ?').bind(id).first();
  if (!existing) throw notFound();
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('DELETE FROM teams WHERE id = ?').bind(id),
      mustChange(env),
      auditStatement(env, person.memberId, 'team.delete', id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      const still = await env.DB.prepare('SELECT 1 FROM teams WHERE id = ?').bind(id).first();
      if (!still) throw notFound();
      throw new ApiError('forbidden', 'Only the owner can do this.');
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}

/** POST /app-api/teams/:id/members — owner sets any level (1..4); team manager adds joined member up to decider (1..3). */
export async function addTeamMember(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, teamId = ctx.params[0]!;
  await checkTeamAccess(ctx, teamId);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['memberId', 'level']);
  const memberId = text(body.memberId, 'memberId', { min: 1, max: 64 }).trim();
  const level = integer(body.level, 'level', 1, MANAGER);
  if (!person.isOwner && level >= MANAGER) throw new ApiError('forbidden', 'Only the owner can make managers.');

  const team = await env.DB.prepare('SELECT id FROM teams WHERE id = ?').bind(teamId).first();
  if (!team) throw notFound();

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES(?,?,?,?,?)')
        .bind(teamId, memberId, level, person.memberId, now),
      auditStatement(env, person.memberId, 'team.member.add', `${teamId}:${memberId}`),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY')) throw conflict('That person is already in this team.');
    if (msg.includes('FOREIGN KEY constraint failed')) throw notFound();
    if (msg.includes('level not allowed')) {
      const target = await env.DB.prepare(
        "SELECT role, joined_at, removed_at, (SELECT COUNT(*) FROM team_members WHERE member_id = members.id) AS teams FROM members WHERE id = ?",
      ).bind(memberId).first<{ role: string; joined_at: number | null; removed_at: number | null; teams: number }>();
      if (!target || target.role !== 'member' || target.joined_at === null || target.removed_at !== null) throw notFound();
      if (target.teams >= 5) throw conflict('A person can be in at most 5 teams.');
      throw new ApiError('forbidden', 'Your level does not allow this.');
    }
    throw error;
  }
  return Response.json({ teamId, memberId, level }, { status: 201 });
}

/** PATCH /app-api/teams/:id/members/:memberId — owner changes any level; manager changes non-managers up to decider. */
export async function setTeamMemberLevel(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, teamId = ctx.params[0]!, memberId = ctx.params[1]!;
  await checkTeamAccess(ctx, teamId);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['level']);
  const level = integer(body.level, 'level', 1, MANAGER);
  if (!person.isOwner && level >= MANAGER) throw new ApiError('forbidden', 'Only the owner can make managers.');

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE team_members SET level = ?, set_by = ?, set_at = ? WHERE team_id = ? AND member_id = ?')
        .bind(level, person.memberId, now, teamId, memberId),
      mustChange(env),
      auditStatement(env, person.memberId, 'team.member.level', `${teamId}:${memberId}`),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('level not allowed')) throw new ApiError('forbidden', 'Your level does not allow this.');
    if (msg.includes('malformed JSON')) throw notFound();
    throw error;
  }
  return Response.json({ teamId, memberId, level });
}

/**
 * DELETE /app-api/teams/:id/members/:memberId — guarded DELETE per teams.md so a manager's removal
 * can never race a promotion to manager or a demotion of the manager.
 */
export async function removeTeamMember(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, teamId = ctx.params[0]!, memberId = ctx.params[1]!;
  await checkTeamAccess(ctx, teamId);

  const deleteStmt = person.isOwner
    ? env.DB.prepare(
        `DELETE FROM team_members
         WHERE team_id = ?1 AND member_id = ?2
           AND EXISTS (SELECT 1 FROM members WHERE id = ?3 AND role = 'owner' AND removed_at IS NULL)`,
      ).bind(teamId, memberId, person.memberId)
    : env.DB.prepare(
        `DELETE FROM team_members
         WHERE team_id = ?1 AND member_id = ?2 AND level < 4
           AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = ?1 AND m.member_id = ?3 AND m.level = 4)`,
      ).bind(teamId, memberId, person.memberId);

  try {
    await env.DB.batch([
      deleteStmt,
      mustChange(env),
      auditStatement(env, person.memberId, 'team.member.remove', `${teamId}:${memberId}`),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      const existing = await env.DB.prepare('SELECT level FROM team_members WHERE team_id = ? AND member_id = ?')
        .bind(teamId, memberId).first<{ level: number }>();
      if (existing) throw new ApiError('forbidden', 'Your level does not allow this.');
      throw notFound();
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}

/** POST /app-api/teams/:id/projects — owner assigns a project to a team (max 10 projects per team). */
export async function addTeamProject(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, teamId = ctx.params[0]!, { body } = await readJson(ctx.request);
  onlyKeys(body, ['project']);
  const slug = text(body.project, 'project', { min: 1, max: 80 }).trim();

  const [team, project] = await Promise.all([
    env.DB.prepare('SELECT id FROM teams WHERE id = ?').bind(teamId).first<{ id: string }>(),
    env.DB.prepare('SELECT id, slug FROM projects WHERE slug = ?').bind(slug).first<{ id: string; slug: string }>(),
  ]);
  if (!team || !project) throw notFound();

  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('INSERT INTO team_projects(team_id, project_id) VALUES(?,?)').bind(teamId, project.id),
      auditStatement(env, person.memberId, 'team.project.add', `${teamId}:${project.slug}`),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('too many projects')) throw conflict('A team can have at most 10 projects.');
    if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY')) throw conflict('That project is already in this team.');
    if (msg.includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ teamId, project: project.slug }, { status: 201 });
}

/** DELETE /app-api/teams/:id/projects/:slug — owner removes a project from a team. */
export async function removeTeamProject(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, teamId = ctx.params[0]!, slug = ctx.params[1]!;
  const project = await env.DB.prepare('SELECT id, slug FROM projects WHERE slug = ?').bind(slug).first<{ id: string; slug: string }>();
  if (!project) throw notFound();

  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('DELETE FROM team_projects WHERE team_id = ? AND project_id = ?').bind(teamId, project.id),
      mustChange(env),
      auditStatement(env, person.memberId, 'team.project.remove', `${teamId}:${project.slug}`),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      const still = await env.DB.prepare('SELECT 1 FROM team_projects WHERE team_id = ? AND project_id = ?').bind(teamId, project.id).first();
      if (still) throw new ApiError('forbidden', 'Only the owner can do this.');
      throw notFound();
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}
