import type { AppEnv } from '../../shared/env';
import { sha256Hex } from '../../shared/crypto';
import { invalid } from '../../shared/errors';
import type { Caller } from './auth';

const DAY = 86_400_000;

export interface Idempotent {
  key: string;
  requestHash: string;
}

/** The request's Idempotency-Key and what it stands for: method, path and body. */
export async function idempotent(request: Request, body: string): Promise<Idempotent> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || key.length > 100) throw invalid('An Idempotency-Key header of at most 100 characters is needed.');
  return { key, requestHash: await sha256Hex(`${request.method}\n${new URL(request.url).pathname}\n${body}`) };
}

export interface Stored { status: number; json: Record<string, unknown> }

/** The reply already given to this request, if any. */
export async function replay(env: AppEnv, caller: Caller, { key, requestHash }: Idempotent): Promise<Stored | null> {
  const row = await env.DB.prepare('SELECT request_sha256, status, response_json FROM idempotency WHERE key_id = ? AND idem_key = ? AND expires_at > ?')
    .bind(caller.keyId, key, Date.now()).first<{ request_sha256: string; status: number; response_json: string }>();
  if (!row) return null;
  if (row.request_sha256 !== requestHash) throw invalid('This Idempotency-Key was used for a different request.');
  return { status: row.status, json: JSON.parse(row.response_json) as Record<string, unknown> };
}

/**
 * Runs a write and records its reply in one transaction, so a request sent twice, even at once, happens once.
 * If the write fails because its twin won, the twin's reply is given.
 */
export async function writeOnce(env: AppEnv, caller: Caller, idem: Idempotent, stored: Stored, statements: D1PreparedStatement[]): Promise<Stored> {
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM idempotency WHERE key_id = ? AND idem_key = ? AND expires_at <= ?').bind(caller.keyId, idem.key, now),
      env.DB.prepare('INSERT INTO idempotency(key_id,idem_key,request_sha256,status,response_json,expires_at) VALUES(?,?,?,?,?,?)')
        .bind(caller.keyId, idem.key, idem.requestHash, stored.status, JSON.stringify(stored.json), now + DAY),
      ...statements,
    ]);
    return stored;
  } catch (error) {
    const twin = await replay(env, caller, idem);
    if (twin) return twin;
    throw error;
  }
}
