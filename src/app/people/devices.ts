import { equalInConstantTime, hmacHex, randomToken, readSecret, sha256Hex } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { membersAllowed } from '../../shared/switches';
import { onlyKeys, readJson } from '../api/body';
import type { AppContext, SignedIn } from './router';
import { auditStatement, deviceLabel, newSession, sessionCookie } from './session';

const FIVE_MINUTES = 300_000;
// No vowels, so no words; 20^8 codes.
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

function newCode(): string {
  let code = '';
  // Bytes from 240 on are left out, so each letter is as likely as any other.
  while (code.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < 8) code += LETTERS[byte % 20];
  return code;
}

/** Case, spaces and the dash don't matter. */
const codeHmac = async (env: AppEnv, code: string): Promise<string> => hmacHex(await readSecret(env.PEPPER), `device:${code.toUpperCase().replace(/[\s-]/g, '')}`);

/** A device without a passkey asks to be signed in from one that has one. It keeps the secret and shows the code. */
export async function startDevice(ctx: AppContext): Promise<Response> {
  const { env } = ctx, code = newCode(), secret = randomToken(), id = newId('dev'), now = Date.now();
  await env.DB.prepare('INSERT INTO device_approvals(id, code_hmac, secret_sha256, label, created_at, expires_at) VALUES(?,?,?,?,?,?)')
    .bind(id, await codeHmac(env, code), await sha256Hex(secret), deviceLabel(ctx.request), now, now + FIVE_MINUTES).run();
  return Response.json({ id, secret, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: now + FIVE_MINUTES }, { status: 201 });
}

/** The new device asks whether it was approved. The session is its own from then on. */
export async function claimDevice(ctx: AppContext): Promise<Response> {
  const { env } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['id', 'secret']);
  if (typeof body.id !== 'string' || typeof body.secret !== 'string') throw notFound();
  const row = await env.DB.prepare('SELECT secret_sha256, member_id, used_at FROM device_approvals WHERE id = ? AND expires_at > ?').bind(body.id, Date.now())
    .first<{ secret_sha256: string; member_id: string | null; used_at: number | null }>();
  if (!equalInConstantTime(await sha256Hex(body.secret), row?.secret_sha256 ?? '0'.repeat(64)) || !row || row.used_at !== null) throw notFound();
  if (row.member_id === null) return new Response(null, { status: 202 });
  const member = await env.DB.prepare('SELECT role FROM members WHERE id = ?').bind(row.member_id).first<{ role: string }>();
  if (member?.role !== 'owner' && !(await membersAllowed(env.DB))) throw new ApiError('feature_off', 'This feature is off.');
  const session = await newSession(env, ctx.request, row.member_id, { approvalId: body.id });
  try {
    await env.DB.batch([session.statement, auditStatement(env, row.member_id, 'session.device', body.id)]);
  } catch (error) {
    if (/not allowed|UNIQUE constraint failed: sessions/.test(String(error))) throw notFound();
    throw error;
  }
  return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie(env, session.token) } });
}

async function findByCode(ctx: SignedIn): Promise<{ id: string; label: string; created_at: number }> {
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['code']);
  if (!(await env.CODE_LIMIT.limit({ key: person.sessionId })).success) throw new ApiError('rate_limited', 'Too many codes. Wait a minute.');
  if (typeof body.code !== 'string' || body.code.length > 20) throw notFound();
  const row = await env.DB.prepare('SELECT id, label, created_at FROM device_approvals WHERE code_hmac = ? AND expires_at > ? AND approved_at IS NULL')
    .bind(await codeHmac(env, body.code), Date.now()).first<{ id: string; label: string; created_at: number }>();
  if (!row) throw notFound();
  return row;
}

/** What a typed code would sign in, so the person can compare before approving. */
export async function lookAtDevice(ctx: SignedIn): Promise<Response> {
  const device = await findByCode(ctx);
  return Response.json({ label: device.label, createdAt: device.created_at });
}

export async function approveDevice(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, device = await findByCode(ctx), now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE device_approvals SET approved_at = ?, member_id = ?, approver_session = ? WHERE id = ?').bind(now, person.memberId, person.sessionId, device.id),
      auditStatement(env, person.memberId, 'device.approve', device.id),
    ]);
  } catch (error) {
    if (String(error).includes('not allowed')) throw notFound();
    throw error;
  }
  return new Response(null, { status: 204 });
}
