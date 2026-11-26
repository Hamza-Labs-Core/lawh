import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../../src/app/index';
import { randomToken, sha256Hex } from '../../../src/shared/crypto';
import { Authenticator, type Change } from './authenticator';

export const sql = (...statements: string[]) => env.DB.batch(statements.map((s) => env.DB.prepare(s)));
export const one = <T>(query: string, ...values: unknown[]) => env.DB.prepare(query).bind(...values).first<T>();
export const count = async (table: string, where = '1') => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`))!.n;

export async function seed(instance = true, teams = true): Promise<void> {
  await sql(
    `INSERT INTO settings(key,value_json,updated_at) VALUES('instance','${instance}',1),('teams','${teams}',1)`,
    "INSERT INTO members(id,name,role,created_at) VALUES('o','Sara','owner',1)",
    "INSERT INTO members(id,name,created_by,created_at) VALUES('m','Mona','o',1),('x','Lina','o',1)",
    "UPDATE members SET joined_at=1 WHERE id='m'",
    "INSERT INTO teams(id,name,created_at) VALUES('t1','Design',1)",
  );
}

let calls = 0;
export interface Call { body?: unknown; cookie?: string | undefined; headers?: Record<string, string> }
export async function call(method: string, path: string, { body, cookie, headers }: Call = {}, bindings: Partial<Cloudflare.Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`http://localhost:8787${path}`, {
    method, ...(method !== 'GET' && method !== 'HEAD' && { body: JSON.stringify(body ?? {}) }),
    headers: { Origin: 'http://localhost:8787', 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `ip-${calls++}`, ...(cookie && { Cookie: cookie }), ...headers },
  });
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
export const api = (method: string, path: string, options?: Call, bindings?: Partial<Cloudflare.Env>) => call(method, `/app-api${path}`, options, bindings);
export const code = async (response: Response): Promise<[number, string]> => [response.status, response.status === 204 ? '' : (await response.json<{ code: string }>()).code];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (response: Response): Promise<any> => response.json();
export const cookieOf = (response: Response): string | undefined => response.headers.get('Set-Cookie')?.split(';')[0];

export async function makeLink(kind: 'owner' | 'invite' | 'reset', member: string, life = 600_000): Promise<string> {
  const token = randomToken();
  await env.DB.prepare('DELETE FROM access_links WHERE member_id = ? AND used_at IS NULL').bind(member).run();
  await env.DB.prepare('INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level) VALUES(?,?,?,?,1,?,?,?)')
    .bind(await sha256Hex(token), kind, member, kind === 'owner' ? null : 'o', Date.now() + life, kind === 'invite' ? 't1' : null, kind === 'invite' ? 2 : null).run();
  return token;
}

export async function register(token: string, authenticator: Authenticator, change: Change = {}): Promise<Response> {
  const offered = await api('POST', '/link/options', { body: { token } });
  if (!offered.ok) return offered;
  const { challengeId, options } = await json(offered);
  return api('POST', '/link', { body: { token, challengeId, response: await authenticator.register(options.challenge, change) } });
}

/** A person who registered a passkey from a link, and their session. */
export async function enter(member: string): Promise<{ authenticator: Authenticator; cookie: string }> {
  const authenticator = await Authenticator.make();
  const response = await register(await makeLink(member === 'o' ? 'owner' : member === 'x' ? 'invite' : 'reset', member), authenticator);
  if (response.status !== 204) throw new Error(`${response.status} ${await response.text()}`);
  return { authenticator, cookie: cookieOf(response)! };
}

export async function signIn(authenticator: Authenticator, change: Change = {}): Promise<Response> {
  const { challengeId, options } = await json(await api('POST', '/sign-in/options'));
  return api('POST', '/sign-in', { body: { challengeId, response: await authenticator.sign(options.challenge, change) } });
}
