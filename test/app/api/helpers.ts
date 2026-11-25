import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../../src/app/index';
import { keyHmac, SCOPES } from '../../../src/app/api/auth';
import { hex } from '../../../src/shared/crypto';
import { newId } from '../../../src/shared/ids';

export const FAR = Date.now() + 86_400_000;
export const sql = (...statements: string[]) => env.DB.batch(statements.map((s) => env.DB.prepare(s)));
export const one = <T>(query: string, ...values: unknown[]) => env.DB.prepare(query).bind(...values).first<T>();

/** One owner, a manager (t1: p1, p2), a decider (t1) and projects p1 to p3. Teams are on. */
export async function seed(): Promise<void> {
  await sql(
    "INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1),('teams','true',1)",
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1),('p3','three','Three','ثلاثة',1)",
    "INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1)",
    "UPDATE members SET joined_at=1",
    "INSERT INTO members(id,name,created_by,created_at) VALUES('m','Mona','o',1),('d','Dina','o',1)",
    "UPDATE members SET joined_at=1",
    "INSERT INTO teams(id,name,created_at) VALUES('t1','Team',1)",
    "INSERT INTO team_projects(team_id,project_id) VALUES('t1','p1'),('t1','p2')",
    "INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',4,'o',1),('t1','d',3,'o',1)",
    "INSERT INTO agents(id,member_id,name,created_at) VALUES('ao','o','owner-bot',1),('am','m','mona-bot',1)",
  );
}

let count = 0;
export interface KeyOptions { agent?: 'ao' | 'am'; scopes?: readonly string[]; projects?: string[] | 'all'; expiresAt?: number }

export async function makeKey({ agent = 'ao', scopes = SCOPES, projects = 'all', expiresAt = FAR }: KeyOptions = {}): Promise<{ id: string; token: string }> {
  const id = newId('key'), secret = `${String(count++).padStart(6, '0')}${'s'.repeat(37)}`;
  await env.DB.prepare('INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,all_projects,created_at,expires_at) VALUES(?,?,?,?,?,1,?)')
    .bind(id, agent, await keyHmac(env, id, secret), JSON.stringify(scopes), projects === 'all' ? 1 : 0, expiresAt).run();
  if (projects !== 'all') for (const p of projects) await env.DB.prepare('INSERT INTO agent_key_projects VALUES(?,?)').bind(id, p).run();
  return { id, token: `lawh_${id}_${secret}` };
}

export interface Call { method?: string; token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; idem?: string; ip?: string }

/** Calls the Worker as a client would, and waits for what it does after answering. `bindings` can replace some. */
export async function call(path: string, { method = 'GET', token, json, body, headers, idem, ip }: Call = {}, bindings: Partial<Cloudflare.Env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const request = new Request(`https://lawh.example.com${path}`, {
    method,
    ...(json !== undefined ? { body: JSON.stringify(json) } : body !== undefined ? { body } : {}),
    headers: {
      ...(token !== undefined && { Authorization: `Bearer ${token}` }), ...(idem !== undefined && { 'Idempotency-Key': idem }),
      'CF-Connecting-IP': ip ?? `ip-${count++}`, ...headers,
    },
  });
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...env, ...bindings }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Response bodies are checked by the assertions that use them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (response: Response): Promise<any> => response.json();
export const code = async (response: Response): Promise<[number, string]> => [response.status, (await response.json<{ code: string }>()).code];

export const sha = async (content: string | Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', typeof content === 'string' ? new TextEncoder().encode(content) : content));

export type Files = Record<string, string | Uint8Array>;

export async function manifest(files: Files, extra: Record<string, unknown> = {}) {
  return {
    baseVersion: 0, entry: 'index.html', page: { title: 'Title' },
    files: await Promise.all(Object.entries(files).map(async ([path, content]) => ({
      path, sha256: await sha(content), bytes: typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength,
    }))),
    ...extra,
  };
}

export const start = (token: string, body: unknown, page = 'one/pages/page', idem = `s${count++}`) =>
  call(`/v1/projects/${page}/versions`, { method: 'POST', token, json: body, idem });
export const put = async (token: string, uploadId: string, content: string | Uint8Array, hash?: string) =>
  call(`/v1/uploads/${uploadId}/blobs/${hash ?? (await sha(content))}`, { method: 'PUT', token, body: content });
export const commit = (token: string, uploadId: string, idem = `c${count++}`) => call(`/v1/uploads/${uploadId}/commit`, { method: 'POST', token, idem });

/** Start, send what is missing, commit. */
export async function publish(token: string, files: Files, extra: Record<string, unknown> = {}, page = 'one/pages/page'): Promise<Response> {
  const started = await start(token, await manifest(files, extra), page);
  if (started.status !== 201) return started;
  const { uploadId, missing } = await json(started);
  for (const content of Object.values(files)) if (missing.includes(await sha(content))) await put(token, uploadId, content);
  return commit(token, uploadId);
}
