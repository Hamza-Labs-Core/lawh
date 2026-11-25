import { isOn } from '../../shared/switches';
import { ApiError, invalid, notFound } from '../../shared/errors';
import { onlyKeys, readJson } from '../api/body';
import type { SignedIn } from './router';
import { auditStatement, sessionCookie } from './session';

export async function whoAmI(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  return Response.json({ id: person.memberId, name: person.name, isOwner: person.isOwner, instance: await isOn(env.DB, 'instance') });
}

export async function listSessions(ctx: SignedIn): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT token_sha256, label, created_at, last_seen_at FROM sessions WHERE member_id = ? AND expires_at > ?')
    .bind(ctx.person.memberId, Date.now()).all<{ token_sha256: string; label: string; created_at: number; last_seen_at: number }>();
  return Response.json({ items: results.map((s) => ({ id: s.token_sha256, label: s.label, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.token_sha256 === ctx.person.sessionId })) });
}

export async function endSession(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0] === 'current' ? person.sessionId : ctx.params[0]!;
  const gone = await env.DB.prepare('DELETE FROM sessions WHERE token_sha256 = ? AND member_id = ? RETURNING token_sha256').bind(id, person.memberId).first();
  if (!gone) throw notFound();
  await auditStatement(env, person.memberId, 'session.end', null).run();
  return new Response(null, { status: 204, headers: id === person.sessionId ? { 'Set-Cookie': sessionCookie(env, '', 0) } : {} });
}

/** The owner's alone, and reachable while the instance is off. Other switches come with Settings (S10). */
export async function setInstance(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['on']);
  if (!person.isOwner) throw new ApiError('forbidden', 'Only the owner can do this.');
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('instance', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").bind(String(body.on), Date.now()),
    auditStatement(env, person.memberId, body.on ? 'instance.on' : 'instance.off', null),
  ]);
  return new Response(null, { status: 204 });
}
