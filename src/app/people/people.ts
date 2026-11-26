import { base64url, sha256Hex } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { origins } from '../../shared/origin';
import { isOn } from '../../shared/switches';
import { integer, onlyKeys, readJson, text } from '../api/body';
import { mustChange } from '../api/idempotency';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly, stillOwner } from './settings';

const DAY = 86_400_000;
const INVITE_TTL = 3 * DAY;
const RESET_TTL = DAY;
const MANAGER = 4;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function encodeCursor(parts: [string | number, string]): string {
  return base64url(new TextEncoder().encode(JSON.stringify(parts)));
}

function decodeMemberCursor(raw: string): [string, string] {
  try {
    const pad = raw.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch { /* fall through */ }
  throw invalid('membersCursor is not valid.');
}

function decodeInviteCursor(raw: string): [number, string] {
  try {
    const pad = raw.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'number' && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch { /* fall through */ }
  throw invalid('invitesCursor is not valid.');
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  return Math.min(Number(raw), MAX_LIMIT);
}

async function needTeams(env: AppEnv): Promise<void> {
  if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
}

function readPersonName(value: unknown): string {
  const name = text(value, 'name', { min: 1, max: 80 }).trim().normalize('NFC');
  // eslint-disable-next-line no-control-regex
  if (!name || [...name].length > 80 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw invalid('name must be 1 to 80 printable characters.');
  }
  return name;
}

function makeLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * GET /app-api/people
 * Owner sees all active joined members (paginated), all pending invites (paginated), and all teams.
 * A team manager sees pending invites for the teams they manage (paginated) and those teams.
 */
export async function listPeople(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx, now = Date.now();
  const limit = readLimit(url);
  const rawMembersCursor = url.searchParams.get('membersCursor');
  const rawInvitesCursor = url.searchParams.get('invitesCursor');
  const memberAfter = rawMembersCursor ? decodeMemberCursor(rawMembersCursor) : null;
  const inviteAfter = rawInvitesCursor ? decodeInviteCursor(rawInvitesCursor) : null;
  const switchStmt = env.DB.prepare("SELECT value_json FROM settings WHERE key = 'teams'");

  if (person.isOwner) {
    const memberWhere = memberAfter
      ? "role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL AND (name, id) > (?, ?)"
      : "role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL";
    const memberBinds: unknown[] = memberAfter ? [memberAfter[0], memberAfter[1]] : [];

    const inviteWhere = inviteAfter
      ? "m.role = 'member' AND m.joined_at IS NULL AND m.removed_at IS NULL AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))"
      : "m.role = 'member' AND m.joined_at IS NULL AND m.removed_at IS NULL";
    const inviteBinds: unknown[] = inviteAfter ? [inviteAfter[0], inviteAfter[0], inviteAfter[1]] : [];

    const [swRes, ownerRes, membersRes, membershipsRes, resetLinksRes, invitesRes, teamsRes] = await env.DB.batch([
      switchStmt,
      env.DB.prepare("SELECT 1 FROM members WHERE id = ? AND role = 'owner' AND removed_at IS NULL").bind(person.memberId),
      env.DB.prepare(
        `SELECT id, name, created_at, joined_at FROM members
         WHERE ${memberWhere}
         ORDER BY name, id LIMIT ?`,
      ).bind(...memberBinds, limit + 1),
      env.DB.prepare(
        `WITH member_page AS (
           SELECT id FROM members WHERE ${memberWhere} ORDER BY name, id LIMIT ?
         )
         SELECT tm.member_id, tm.team_id, t.name team_name, tm.level
         FROM member_page mp
         CROSS JOIN team_members tm ON tm.member_id = mp.id
         JOIN teams t ON t.id = tm.team_id
         ORDER BY tm.member_id, t.name, tm.team_id`,
      ).bind(...memberBinds, limit),
      env.DB.prepare(
        `WITH member_page AS (
           SELECT id FROM members WHERE ${memberWhere} ORDER BY name, id LIMIT ?
         )
         SELECT l.member_id, l.expires_at
         FROM member_page mp
         CROSS JOIN access_links l ON l.member_id = mp.id
         WHERE l.kind = 'reset' AND l.used_at IS NULL AND l.expires_at > ?`,
      ).bind(...memberBinds, limit, now),
      env.DB.prepare(
        `SELECT m.id, m.name, m.created_by, m.created_at,
                l.team_id, t.name team_name, l.level, l.expires_at, c.name inviter_name
         FROM members m
         LEFT JOIN access_links l ON l.member_id = m.id AND l.kind = 'invite' AND l.used_at IS NULL
         LEFT JOIN teams t ON t.id = l.team_id
         LEFT JOIN members c ON c.id = m.created_by
         WHERE ${inviteWhere}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      ).bind(...inviteBinds, limit + 1),
      env.DB.prepare('SELECT id, name FROM teams ORDER BY name, id LIMIT 1000'),
    ]);

    const teamsOn = (swRes!.results[0] as { value_json?: string } | undefined)?.value_json === 'true';
    if (!teamsOn) throw new ApiError('feature_off', 'This feature is off.');
    if (ownerRes!.results.length === 0) throw new ApiError('forbidden', 'Only the owner can do this.');

    const rawMembers = membersRes!.results as { id: string; name: string; created_at: number; joined_at: number }[];
    const hasMoreMembers = rawMembers.length > limit;
    const memberPage = hasMoreMembers ? rawMembers.slice(0, limit) : rawMembers;
    const membersNext = hasMoreMembers ? encodeCursor([memberPage.at(-1)!.name, memberPage.at(-1)!.id]) : null;

    const rawInvites = invitesRes!.results as {
      id: string; name: string; created_by: string | null; created_at: number;
      team_id: string | null; team_name: string | null; level: number | null; expires_at: number | null; inviter_name: string | null;
    }[];
    const hasMoreInvites = rawInvites.length > limit;
    const invitePage = hasMoreInvites ? rawInvites.slice(0, limit) : rawInvites;
    const invitesNext = hasMoreInvites ? encodeCursor([invitePage.at(-1)!.created_at, invitePage.at(-1)!.id]) : null;

    const memberships = membershipsRes!.results as { member_id: string; team_id: string; team_name: string; level: number }[];
    const resets = new Map<string, number>();
    for (const r of resetLinksRes!.results as { member_id: string; expires_at: number }[]) resets.set(r.member_id, r.expires_at);

    const members = memberPage.map((m) => ({
      id: m.id,
      name: m.name,
      createdAt: m.created_at,
      joinedAt: m.joined_at,
      resetExpiresAt: resets.get(m.id) ?? null,
      teams: memberships
        .filter((tm) => tm.member_id === m.id)
        .map((tm) => ({ id: tm.team_id, name: tm.team_name, level: tm.level })),
    }));

    const invites = invitePage.map((inv) => ({
      id: inv.id,
      name: inv.name,
      teamId: inv.team_id,
      teamName: inv.team_name,
      level: inv.level,
      inviter: inv.inviter_name,
      createdAt: inv.created_at,
      expiresAt: inv.expires_at,
      expired: inv.expires_at === null || inv.expires_at <= now,
      canRenew: inv.team_id !== null && inv.level !== null,
      canCancel: true,
    }));

    const teams = (teamsRes!.results as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }));
    return Response.json({ members, membersNext, invites, invitesNext, teams });
  }

  // Team manager: read switch, managed teams, and those teams' pending invites (paginated) in one snapshot.
  const managerInviteWhere = inviteAfter
    ? 'WHERE my.member_id = ? AND my.level = 4 AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))'
    : 'WHERE my.member_id = ? AND my.level = 4';
  const managerInviteBinds: unknown[] = inviteAfter
    ? [person.memberId, inviteAfter[0], inviteAfter[0], inviteAfter[1], limit + 1]
    : [person.memberId, limit + 1];

  const [swRes, teamsRes, invitesRes] = await env.DB.batch([
    switchStmt,
    env.DB.prepare(
      `SELECT t.id, t.name FROM team_members my
       JOIN teams t ON t.id = my.team_id
       WHERE my.member_id = ? AND my.level = 4
       ORDER BY t.name, t.id LIMIT 100`,
    ).bind(person.memberId),
    env.DB.prepare(
      `SELECT m.id, m.name, m.created_by, m.created_at,
              l.team_id, t.name team_name, l.level, l.expires_at, c.name inviter_name
       FROM team_members my
       CROSS JOIN access_links l ON l.team_id = my.team_id AND l.kind = 'invite' AND l.used_at IS NULL
       JOIN members m ON m.id = l.member_id AND m.role = 'member' AND m.joined_at IS NULL AND m.removed_at IS NULL
       JOIN teams t ON t.id = l.team_id
       LEFT JOIN members c ON c.id = m.created_by
       ${managerInviteWhere}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    ).bind(...managerInviteBinds),
  ]);

  const teamsOn = (swRes!.results[0] as { value_json?: string } | undefined)?.value_json === 'true';
  if (!teamsOn) throw new ApiError('feature_off', 'This feature is off.');
  const teams = (teamsRes!.results as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }));
  if (teams.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');

  const rawInvites = invitesRes!.results as {
    id: string; name: string; created_by: string | null; created_at: number;
    team_id: string; team_name: string; level: number; expires_at: number; inviter_name: string | null;
  }[];
  const hasMoreInvites = rawInvites.length > limit;
  const invitePage = hasMoreInvites ? rawInvites.slice(0, limit) : rawInvites;
  const invitesNext = hasMoreInvites ? encodeCursor([invitePage.at(-1)!.created_at, invitePage.at(-1)!.id]) : null;

  const invites = invitePage.map((inv) => ({
    id: inv.id,
    name: inv.name,
    teamId: inv.team_id,
    teamName: inv.team_name,
    level: inv.level,
    inviter: inv.inviter_name,
    createdAt: inv.created_at,
    expiresAt: inv.expires_at,
    expired: inv.expires_at <= now,
    // Per schema trigger access_links_allowed, a manager can only renew invites they created themselves (level < 4).
    canRenew: inv.created_by === person.memberId && inv.level < MANAGER,
    canCancel: true,
  }));

  return Response.json({ members: [], membersNext: null, invites, invitesNext, teams });
}

/**
 * POST /app-api/people/invite
 * Owner invites to any team at level 1..4; team manager invites to their own team at level 1..3.
 * Returns the one-time 3-day invite URL in the response body (never stored in plaintext).
 */
export async function invitePerson(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['name', 'teamId', 'level']);
  const name = readPersonName(body.name);
  const teamId = text(body.teamId, 'teamId', { min: 1, max: 64 }).trim();
  const level = integer(body.level, 'level', 1, MANAGER);

  if (!person.isOwner) {
    const { results: managed } = await env.DB.prepare(
      'SELECT team_id FROM team_members WHERE member_id = ? AND level = 4',
    ).bind(person.memberId).all<{ team_id: string }>();
    if (managed.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');
    if (!managed.some((r) => r.team_id === teamId)) throw notFound();
    if (level >= MANAGER) throw new ApiError('forbidden', 'Only the owner can invite managers.');
  }

  const team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?').bind(teamId).first<{ id: string; name: string }>();
  if (!team) throw notFound();

  const now = Date.now(), memberId = newId('mem', now), expiresAt = now + INVITE_TTL;
  const token = makeLinkToken(), hash = await sha256Hex(token);

  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('feature_off') END"),
      env.DB.prepare("INSERT INTO members(id, name, role, created_by, created_at) VALUES(?, ?, 'member', ?, ?)")
        .bind(memberId, name, person.memberId, now),
      env.DB.prepare(
        `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level)
         VALUES(?, 'invite', ?, ?, ?, ?, ?, ?)`,
      ).bind(hash, memberId, person.memberId, now, expiresAt, teamId, level),
      auditStatement(env, person.memberId, 'member.invite', memberId),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('malformed JSON')) throw new ApiError('feature_off', 'This feature is off.');
    if (msg.includes('FOREIGN KEY constraint failed')) throw notFound();
    if (msg.includes('member not allowed') || msg.includes('link not allowed')) {
      throw new ApiError('forbidden', 'Your level does not allow this.');
    }
    throw error;
  }

  return Response.json(
    { id: memberId, name, teamId, teamName: team.name, level, url: `${origins(env).app}/link#${token}`, expiresAt },
    { status: 201 },
  );
}

/**
 * POST /app-api/people/:id/invite-link
 * Issues a fresh 3-day invite link for an unjoined pending member, replacing the previous unused link.
 * Owner can renew any pending invite; a manager can renew invites they created in a team they still manage (level < 4).
 */
export async function renewInviteLink(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, memberId = ctx.params[0]!;

  if (!person.isOwner) {
    const { results: managed } = await env.DB.prepare(
      'SELECT team_id FROM team_members WHERE member_id = ? AND level = 4',
    ).bind(person.memberId).all<{ team_id: string }>();
    if (managed.length === 0) throw new ApiError('forbidden', 'Your level does not allow this.');
  }

  const row = await env.DB.prepare(
    `SELECT m.id, m.role, m.created_by, m.joined_at, m.removed_at, l.team_id, l.level
     FROM members m
     JOIN access_links l ON l.member_id = m.id AND l.kind = 'invite' AND l.used_at IS NULL
     WHERE m.id = ?`,
  ).bind(memberId).first<{
    id: string; role: string; created_by: string | null; joined_at: number | null; removed_at: number | null;
    team_id: string; level: number;
  }>();

  if (!row || row.role !== 'member' || row.joined_at !== null || row.removed_at !== null) throw notFound();
  if (!person.isOwner) {
    const manages = await env.DB.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND member_id = ? AND level = 4')
      .bind(row.team_id, person.memberId).first();
    if (!manages) throw notFound();
    if (row.created_by !== person.memberId || row.level >= MANAGER) {
      throw new ApiError('forbidden', 'Your level does not allow this.');
    }
  }

  const now = Date.now(), expiresAt = now + INVITE_TTL;
  const token = makeLinkToken(), hash = await sha256Hex(token);

  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('feature_off') END"),
      env.DB.prepare("DELETE FROM access_links WHERE member_id = ? AND kind = 'invite' AND used_at IS NULL").bind(memberId),
      mustChange(env),
      env.DB.prepare(
        `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level)
         VALUES(?, 'invite', ?, ?, ?, ?, ?, ?)`,
      ).bind(hash, memberId, person.memberId, now, expiresAt, row.team_id, row.level),
      auditStatement(env, person.memberId, 'invite.renew', memberId),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
      throw notFound();
    }
    if (msg.includes('FOREIGN KEY constraint failed')) throw notFound();
    if (msg.includes('link not allowed')) {
      const latest = await env.DB.prepare('SELECT joined_at, removed_at FROM members WHERE id = ?')
        .bind(memberId).first<{ joined_at: number | null; removed_at: number | null }>();
      if (!latest || latest.removed_at !== null) throw notFound();
      if (latest.joined_at !== null) throw conflict('That person already joined.');
      throw new ApiError('forbidden', 'Your level does not allow this.');
    }
    throw error;
  }

  return Response.json({ id: memberId, url: `${origins(env).app}/link#${token}`, expiresAt });
}

/**
 * DELETE /app-api/people/:id/invite
 * Cancels an unused pending invite (marks member removed, which deletes its link via trigger).
 * Allowed for the owner, a manager of the invite's team, or the person who created the invite.
 */
export async function cancelInvite(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  const { env, person } = ctx, memberId = ctx.params[0]!, now = Date.now();

  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('feature_off') END"),
      env.DB.prepare(
        `UPDATE members SET removed_at = ?1
         WHERE id = ?2 AND role = 'member' AND joined_at IS NULL AND removed_at IS NULL
           AND (
             EXISTS (SELECT 1 FROM members o WHERE o.id = ?3 AND o.role = 'owner' AND o.removed_at IS NULL)
             OR created_by = ?3
             OR EXISTS (
               SELECT 1 FROM access_links l
               JOIN team_members b ON b.team_id = l.team_id AND b.member_id = ?3 AND b.level = 4
               WHERE l.member_id = members.id AND l.kind = 'invite' AND l.used_at IS NULL
             )
           )`,
      ).bind(now, memberId, person.memberId),
      mustChange(env),
      auditStatement(env, person.memberId, 'invite.cancel', memberId),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
      const pending = await env.DB.prepare(
        "SELECT 1 FROM members WHERE id = ? AND role = 'member' AND joined_at IS NULL AND removed_at IS NULL",
      ).bind(memberId).first();
      if (pending) throw new ApiError('forbidden', 'Your level does not allow this.');
      throw notFound();
    }
    throw error;
  }

  return new Response(null, { status: 204 });
}

/**
 * POST /app-api/people/:id/reset
 * Owner-only: creates a 1-day single-use reset link for a joined member, replacing any unused link.
 */
export async function makeResetLink(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, memberId = ctx.params[0]!, now = Date.now(), expiresAt = now + RESET_TTL;
  const token = makeLinkToken(), hash = await sha256Hex(token);

  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('feature_off') END"),
      stillOwner(env, person.memberId),
      env.DB.prepare('DELETE FROM access_links WHERE member_id = ? AND used_at IS NULL').bind(memberId),
      env.DB.prepare(
        `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at)
         VALUES(?, 'reset', ?, ?, ?, ?)`,
      ).bind(hash, memberId, person.memberId, now, expiresAt),
      auditStatement(env, person.memberId, 'member.reset', memberId),
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
      throw new ApiError('forbidden', 'Only the owner can do this.');
    }
    if (msg.includes('FOREIGN KEY constraint failed') || msg.includes('link not allowed')) throw notFound();
    throw error;
  }

  return Response.json({ id: memberId, url: `${origins(env).app}/link#${token}`, expiresAt });
}

/**
 * DELETE /app-api/people/:id
 * Owner-only: permanently removes a joined non-owner member.
 * Trigger `members_remove` atomically ends sessions, passkeys, approvals, challenges, links,
 * team memberships, pending invites they created, and revokes their agents' keys.
 */
export async function removePerson(ctx: SignedIn): Promise<Response> {
  await needTeams(ctx.env);
  ownerOnly(ctx);
  const { env, person } = ctx, memberId = ctx.params[0]!, now = Date.now();

  try {
    await env.DB.batch([
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('feature_off') END"),
      stillOwner(env, person.memberId),
      env.DB.prepare(
        "UPDATE members SET removed_at = ? WHERE id = ? AND role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL",
      ).bind(now, memberId),
      mustChange(env),
      auditStatement(env, person.memberId, 'member.remove', memberId),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'teams'))) throw new ApiError('feature_off', 'This feature is off.');
      const still = await env.DB.prepare(
        "SELECT 1 FROM members WHERE id = ? AND role = 'member' AND joined_at IS NOT NULL AND removed_at IS NULL",
      ).bind(memberId).first();
      if (still) throw new ApiError('forbidden', 'Only the owner can do this.');
      throw notFound();
    }
    throw error;
  }

  return new Response(null, { status: 204 });
}
