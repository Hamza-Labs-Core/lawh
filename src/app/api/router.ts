import type { AppEnv } from '../../shared/env';
import { ApiError, notFound } from '../../shared/errors';
import { authenticate, type Caller, needScope, type Scope } from './auth';
import { getDecision, listDecisions } from './decisions';
import { getPage, getVersion, listPages, listProjects, listVersions, me, readFile, updatePage } from './pages';
import { commitPublish, putBlob, startPublish } from './publish';

export interface Context {
  request: Request;
  env: AppEnv;
  ctx: ExecutionContext;
  url: URL;
  params: string[];
  caller: Caller;
}

export interface Route {
  method: string;
  path: RegExp;
  scope: Scope | 'any';
  handler: (ctx: Context) => Promise<Response>;
}

const P = '([a-z0-9][a-z0-9-]{0,79})', S = P, N = '([1-9][0-9]{0,9})', ID = '([a-z]{3}_[0-9A-Z]{26})';
const route = (method: string, path: string, scope: Route['scope'], handler: Route['handler']): Route => ({ method, path: new RegExp(`^/v1${path}$`), scope, handler });

export const routes: Route[] = [
  route('GET', '/me', 'any', me),
  route('GET', '/projects', 'pages:read', listProjects),
  route('GET', '/pages', 'pages:read', listPages),
  route('GET', `/projects/${P}/pages/${S}`, 'pages:read', getPage),
  route('PATCH', `/projects/${P}/pages/${S}`, 'pages:write', updatePage),
  route('GET', `/projects/${P}/pages/${S}/versions`, 'pages:read', listVersions),
  route('POST', `/projects/${P}/pages/${S}/versions`, 'pages:write', startPublish),
  route('GET', `/projects/${P}/pages/${S}/versions/${N}`, 'pages:read', getVersion),
  route('GET', `/projects/${P}/pages/${S}/versions/${N}/file`, 'pages:read', readFile),
  route('PUT', `/uploads/${ID}/blobs/([0-9a-f]{64})`, 'pages:write', putBlob),
  route('POST', `/uploads/${ID}/commit`, 'pages:write', commitPublish),
  route('GET', '/decisions', 'decisions:read', listDecisions),
  route('GET', `/decisions/${ID}`, 'decisions:read', getDecision),
];

/** The agent API. The key is checked before anything else, so an unknown path tells nothing without one. */
export async function api(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const caller = await authenticate(request, env, ctx);
    for (const { method, path, scope, handler } of routes) {
      const match = request.method === method ? path.exec(url.pathname) : null;
      if (!match) continue;
      needScope(caller, scope);
      return await handler({ request, env, ctx, url, params: match.slice(1), caller });
    }
    throw notFound();
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    throw error;
  }
}
