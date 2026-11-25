import { type AuthenticationResponseJSON, generateAuthenticationOptions, generateRegistrationOptions, type RegistrationResponseJSON, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { base64url, sha256Hex } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { origins } from '../../shared/origin';
import { membersAllowed } from '../../shared/switches';
import { isObject, onlyKeys, readJson } from '../api/body';
import type { AppContext, SignedIn } from './router';
import { auditStatement, deviceLabel, newSession, sessionCookie } from './session';

const FIVE_MINUTES = 300_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const unauthorized = (): ApiError => new ApiError('unauthorized', 'That passkey did not work.');

const rp = (env: AppEnv) => ({ origin: origins(env).app, id: new URL(origins(env).app).hostname });

/** Saves a challenge for five minutes. It is used once. */
async function saveChallenge(env: AppEnv, purpose: 'register' | 'sign_in', memberId: string | null, challenge: string): Promise<string> {
  const id = newId('cha');
  await env.DB.prepare('INSERT INTO auth_challenges(id, purpose, member_id, challenge, expires_at) VALUES(?,?,?,?,?)').bind(id, purpose, memberId, challenge, Date.now() + FIVE_MINUTES).run();
  return id;
}

async function takeChallenge(env: AppEnv, id: unknown, purpose: 'register' | 'sign_in', memberId: string | null): Promise<string> {
  if (typeof id !== 'string') throw invalid('challengeId is needed.');
  const row = await env.DB.prepare('DELETE FROM auth_challenges WHERE id = ? AND expires_at > ? AND purpose = ? AND member_id IS ? RETURNING challenge')
    .bind(id, Date.now(), purpose, memberId).first<{ challenge: string }>();
  if (!row) throw unauthorized();
  return row.challenge;
}

// ---- Signing in

export async function signInOptions(ctx: AppContext): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: rp(ctx.env).id, userVerification: 'required' });
  return Response.json({ challengeId: await saveChallenge(ctx.env, 'sign_in', null, options.challenge), options });
}

export async function signIn(ctx: AppContext): Promise<Response> {
  const { env } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['challengeId', 'response']);
  const challenge = await takeChallenge(env, body.challengeId, 'sign_in', null);
  if (!isObject(body.response) || typeof body.response.id !== 'string') throw unauthorized();
  const key = await env.DB.prepare(
    `SELECT k.credential_id, k.member_id, k.public_key, k.sign_count, m.role FROM passkeys k JOIN members m ON m.id = k.member_id
     WHERE k.credential_id = ? AND m.joined_at IS NOT NULL AND m.removed_at IS NULL`,
  ).bind(body.response.id).first<{ credential_id: string; member_id: string; public_key: number[]; sign_count: number; role: string }>();
  if (!key) throw unauthorized();
  // The authenticator says whose passkey it is; it must be the same person.
  const handle = isObject(body.response.response) ? body.response.response.userHandle : undefined;
  if (typeof handle === 'string' && handle !== '' && handle !== base64url(new TextEncoder().encode(key.member_id))) throw unauthorized();
  const result = await verifyAuthenticationResponse({
    response: body.response as unknown as AuthenticationResponseJSON, expectedChallenge: challenge, expectedOrigin: rp(env).origin, expectedRPID: rp(env).id, requireUserVerification: true,
    credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: key.sign_count },
  }).catch(() => null);
  if (!result?.verified) throw unauthorized();
  if (key.role !== 'owner' && !(await membersAllowed(env.DB))) throw new ApiError('feature_off', 'This feature is off.');
  const session = await newSession(env, ctx.request, key.member_id, { passkeyId: key.credential_id });
  await env.DB.batch([
    // Two sign-ins at once must not take the counter back.
    env.DB.prepare('UPDATE passkeys SET sign_count = MAX(sign_count, ?), last_used_at = ? WHERE credential_id = ?').bind(result.authenticationInfo.newCounter, Date.now(), key.credential_id),
    session.statement,
    auditStatement(env, key.member_id, 'session.start', null),
  ]).catch((error: unknown) => {
    // Removed, or the passkey replaced, at this moment.
    throw /not allowed|FOREIGN KEY/.test(String(error)) ? unauthorized() : error;
  });
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(env, session.token) } });
}

// ---- Registering, from a link

interface Link { kind: 'owner' | 'invite' | 'reset'; member_id: string; name: string; team: string | null; level: number | null; inviter: string | null; hash: string }

/** A link that works now. Its token is in the body, never in an address that reaches the server. */
async function findLink(env: AppEnv, token: unknown): Promise<Link> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw notFound();
  const hash = await sha256Hex(token);
  const link = await env.DB.prepare(
    `SELECT l.kind, l.member_id, m.name, t.name team, l.level, c.name inviter FROM access_links l JOIN members m ON m.id = l.member_id AND m.removed_at IS NULL
     LEFT JOIN teams t ON t.id = l.team_id LEFT JOIN members c ON c.id = l.created_by
     WHERE l.token_sha256 = ? AND l.used_at IS NULL AND l.expires_at > ?`,
  ).bind(hash, Date.now()).first<Omit<Link, 'hash'>>();
  if (!link) throw notFound();
  if (link.kind !== 'owner' && !(await membersAllowed(env.DB))) throw new ApiError('feature_off', 'This feature is off.');
  return { ...link, hash };
}

export async function linkOptions(ctx: AppContext): Promise<Response> {
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['token']);
  const link = await findLink(ctx.env, body.token);
  const options = await registrationOptions(ctx.env, link.member_id, link.name, []);
  return Response.json({
    challengeId: await saveChallenge(ctx.env, 'register', link.member_id, options.challenge), options,
    link: { kind: link.kind, name: link.name, team: link.team, level: link.level, inviter: link.inviter },
  });
}

export async function linkRegister(ctx: AppContext): Promise<Response> {
  const { env } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['token', 'challengeId', 'response']);
  const link = await findLink(env, body.token);
  const credential = await verifyRegistration(ctx, body, link.member_id);
  const session = await newSession(env, ctx.request, link.member_id, { passkeyId: credential.id });
  try {
    // The link is used by the INSERT itself; a second use, an expired link or a removed person refuses it.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO passkeys(credential_id, member_id, public_key, sign_count, label, created_at, last_used_at, link_id) VALUES(?,?,?,?,?,?,?,?)')
        .bind(credential.id, link.member_id, credential.publicKey, credential.counter, deviceLabel(ctx.request), Date.now(), Date.now(), link.hash),
      session.statement,
      auditStatement(env, link.member_id, `link.${link.kind}`, link.member_id),
    ]);
  } catch (error) {
    if (/not allowed|UNIQUE constraint failed: passkeys/.test(String(error))) throw notFound();
    throw error;
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(env, session.token) } });
}

// ---- A person's own passkeys

async function registrationOptions(env: AppEnv, memberId: string, name: string, existing: string[]) {
  return generateRegistrationOptions({
    rpName: 'Lawh', rpID: rp(env).id, userID: new Uint8Array(new TextEncoder().encode(memberId)), userName: name, userDisplayName: name, attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: existing.map((id) => ({ id })),
  });
}

async function verifyRegistration(ctx: AppContext, body: Record<string, unknown>, memberId: string) {
  const challenge = await takeChallenge(ctx.env, body.challengeId, 'register', memberId);
  if (!isObject(body.response)) throw unauthorized();
  const result = await verifyRegistrationResponse({
    response: body.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: rp(ctx.env).origin, expectedRPID: rp(ctx.env).id, requireUserVerification: true,
  }).catch(() => null);
  if (!result?.verified) throw unauthorized();
  if (result.registrationInfo.credential.id.length > 1364) throw unauthorized();
  return result.registrationInfo.credential;
}

export async function listPasskeys(ctx: SignedIn): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT credential_id, label, created_at, last_used_at FROM passkeys WHERE member_id = ?').bind(ctx.person.memberId)
    .all<{ credential_id: string; label: string; created_at: number; last_used_at: number | null }>();
  return Response.json({ items: results.map((k) => ({ id: k.credential_id, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at })) });
}

export async function addPasskeyOptions(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const { results } = await env.DB.prepare('SELECT credential_id FROM passkeys WHERE member_id = ?').bind(person.memberId).all<{ credential_id: string }>();
  if (results.length >= 20) throw invalid('At most 20 passkeys.');
  const options = await registrationOptions(env, person.memberId, person.name, results.map((k) => k.credential_id));
  return Response.json({ challengeId: await saveChallenge(env, 'register', person.memberId, options.challenge), options });
}

export async function addPasskey(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['challengeId', 'response']);
  const credential = await verifyRegistration(ctx, body, person.memberId);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO passkeys(credential_id, member_id, public_key, sign_count, label, created_at, session_id) VALUES(?,?,?,?,?,?,?)')
        .bind(credential.id, person.memberId, credential.publicKey, credential.counter, deviceLabel(ctx.request), Date.now(), person.sessionId),
      auditStatement(env, person.memberId, 'passkey.add', null),
    ]);
  } catch (error) {
    // The session ended, or a recovery ran, while the browser was asking.
    if (/not allowed|UNIQUE constraint failed: passkeys/.test(String(error))) throw unauthorized();
    throw error;
  }
  return new Response(null, { status: 204 });
}

/** Removing a passkey also ends the sessions it started. The last one stays. */
export async function removePasskey(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const gone = await env.DB.prepare('DELETE FROM passkeys WHERE credential_id = ? AND member_id = ? AND EXISTS (SELECT 1 FROM passkeys o WHERE o.member_id = ? AND o.credential_id <> ?) RETURNING credential_id')
    .bind(ctx.params[0]!, person.memberId, person.memberId, ctx.params[0]!).first();
  if (!gone) throw new ApiError('conflict', 'The last passkey can\'t be removed.');
  await auditStatement(env, person.memberId, 'passkey.remove', null).run();
  return new Response(null, { status: 204 });
}
