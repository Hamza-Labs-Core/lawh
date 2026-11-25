import { randomToken, sha256Hex } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError } from '../../shared/errors';
import { origins } from '../../shared/origin';
import { membersAllowed } from '../../shared/switches';

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** 30 days from the last use, 90 at most. */
const IDLE = 30 * DAY, LIFE = 90 * DAY;

export interface Person {
  memberId: string;
  name: string;
  isOwner: boolean;
  sessionId: string;
}

// Local copies run on plain http, where a `__Host-` cookie can't be set in every browser.
const cookieName = (env: AppEnv): string => (origins(env).app.startsWith('https:') ? '__Host-lawh' : 'lawh-local');

export function sessionCookie(env: AppEnv, token: string, maxAge = LIFE / 1000): string {
  const secure = origins(env).app.startsWith('https:') ? '; Secure' : '';
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** "Firefox on macOS": shown in the list of sessions, nothing more. */
export function deviceLabel(request: Request): string {
  const agent = request.headers.get('User-Agent') ?? '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} · ${system}` : browser;
}

/** A new session's token and the row that makes it valid. The row is refused unless its source allows it. */
export async function newSession(env: AppEnv, request: Request, memberId: string, source: { passkeyId: string } | { approvalId: string }): Promise<{ token: string; sessionId: string; statement: D1PreparedStatement }> {
  const token = randomToken(), sessionId = await sha256Hex(token), now = Date.now();
  const statement = env.DB.prepare('INSERT INTO sessions(token_sha256, member_id, label, created_at, last_seen_at, expires_at, passkey_id, approval_id) VALUES(?,?,?,?,?,?,?,?)')
    .bind(sessionId, memberId, deviceLabel(request), now, now, now + IDLE, 'passkeyId' in source ? source.passkeyId : null, 'approvalId' in source ? source.approvalId : null);
  return { token, sessionId, statement };
}

/** The person behind a request, or null. While `teams` or the instance is off, only the owner is anyone. */
export async function findPerson(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Person | null> {
  const token = readCookie(request, cookieName(env));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sessionId = await sha256Hex(token), now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.member_id, s.created_at, s.last_seen_at, m.name, m.role FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token_sha256 = ? AND s.expires_at > ? AND m.removed_at IS NULL`,
  ).bind(sessionId, now).first<{ member_id: string; created_at: number; last_seen_at: number; name: string; role: string }>();
  if (!row) return null;
  const isOwner = row.role === 'owner';
  if (!isOwner && !(await membersAllowed(env.DB))) throw new ApiError('feature_off', 'This feature is off.');
  if (row.last_seen_at < now - HOUR) {
    ctx.waitUntil(env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_sha256 = ? AND expires_at > ?')
      .bind(now, Math.min(now + IDLE, row.created_at + LIFE), sessionId, now).run().catch(() => undefined));
  }
  return { memberId: row.member_id, name: row.name, isOwner, sessionId };
}

/** Writes come only from the app's own pages. Both headers are set by the browser and can't be set by a page. */
export function checkSameOrigin(request: Request, env: AppEnv): void {
  if (request.method === 'GET') return;
  if (request.headers.get('Origin') !== origins(env).app || request.headers.get('Sec-Fetch-Site') !== 'same-origin') throw new ApiError('forbidden', 'Not from this app.');
}

export const auditStatement = (env: AppEnv, memberId: string | null, action: string, subjectId: string | null): D1PreparedStatement =>
  env.DB.prepare("INSERT INTO audit(at, actor_type, actor_id, action, subject_id) VALUES(?,'member',?,?,?)").bind(Date.now(), memberId, action, subjectId);
