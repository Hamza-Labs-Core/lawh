import { hmacHex, readSecret } from '../../shared/crypto';
import { isOn } from '../../shared/switches';
import { ApiError, invalid, notFound } from '../../shared/errors';
import { onlyKeys, readJson } from '../api/body';
import type { SignedIn } from './router';
import { auditStatement, sessionCookie } from './session';
import { stillOwner } from './settings';

export async function whoAmI(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const manages = person.isOwner || (await env.DB.prepare('SELECT 1 FROM project_access WHERE member_id = ? AND level = 4 LIMIT 1').bind(person.memberId).first()) !== null;
  return Response.json({ id: person.memberId, name: person.name, isOwner: person.isOwner, instance: await isOn(env.DB, 'instance'), manages });
}

/** What the app calls a session. Not the stored hash, so a request log and a copy of the database can't be matched. */
const sessionHandle = (pepper: string, hash: string): Promise<string> => hmacHex(pepper, `session:${hash}`);

export async function listSessions(ctx: SignedIn): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT token_sha256, label, created_at, last_seen_at FROM sessions WHERE member_id = ? AND expires_at > ?')
    .bind(ctx.person.memberId, Date.now()).all<{ token_sha256: string; label: string; created_at: number; last_seen_at: number }>();
  const pepper = await readSecret(ctx.env.PEPPER);
  return Response.json({ items: await Promise.all(results.map(async (s) => ({
    id: await sessionHandle(pepper, s.token_sha256), label: s.label, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.token_sha256 === ctx.person.sessionId,
  }))) });
}

export async function endSession(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  let id = person.sessionId;
  if (ctx.params[0] !== 'current') {
    const { results } = await env.DB.prepare('SELECT token_sha256 FROM sessions WHERE member_id = ?').bind(person.memberId).all<{ token_sha256: string }>();
    const pepper = await readSecret(env.PEPPER);
    const handles = await Promise.all(results.map((s) => sessionHandle(pepper, s.token_sha256))), at = handles.indexOf(ctx.params[0]!);
    if (at === -1) throw notFound();
    id = results[at]!.token_sha256;
  }
  const gone = await env.DB.prepare('DELETE FROM sessions WHERE token_sha256 = ? AND member_id = ? RETURNING token_sha256').bind(id, person.memberId).first();
  if (!gone) throw notFound();
  await auditStatement(env, person.memberId, 'session.end', null).run();
  return new Response(null, { status: 204, headers: id === person.sessionId ? { 'Set-Cookie': sessionCookie(env, '', 0) } : {} });
}

/** The owner's alone, and reachable while the instance is off. */
export async function setInstance(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['on']);
  if (!person.isOwner) throw new ApiError('forbidden', 'Only the owner can do this.');
  if (typeof body.on !== 'boolean') throw invalid('on must be true or false.');
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('instance', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").bind(String(body.on), Date.now()),
      auditStatement(env, person.memberId, body.on ? 'instance.on' : 'instance.off', null),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return new Response(null, { status: 204 });
}
