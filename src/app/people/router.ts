import type { AppEnv } from '../../shared/env';
import { ApiError, notFound } from '../../shared/errors';
import { endSession, listSessions, setInstance, whoAmI } from './account';
import { approveDevice, claimDevice, lookAtDevice, startDevice } from './devices';
import { addPasskey, addPasskeyOptions, linkOptions, linkRegister, listPasskeys, removePasskey, signIn, signInOptions } from './passkeys';
import { checkSameOrigin, findPerson, type Person } from './session';

export interface AppContext {
  request: Request;
  env: AppEnv;
  ctx: ExecutionContext;
  url: URL;
  params: string[];
}
export interface SignedIn extends AppContext { person: Person }

/** `who`: anyone, or a signed-in person. `off`: reachable while `instance` is off. */
interface PeopleRoute { method: string; path: RegExp; who: 'anyone' | 'person'; off: boolean; handler: (ctx: SignedIn) => Promise<Response> }

const open = (method: string, path: string, off: boolean, handler: (ctx: AppContext) => Promise<Response>): PeopleRoute => ({ method, path: new RegExp(`^/app-api${path}$`), who: 'anyone', off, handler });
const person = (method: string, path: string, off: boolean, handler: (ctx: SignedIn) => Promise<Response>): PeopleRoute => ({ method, path: new RegExp(`^/app-api${path}$`), who: 'person', off, handler });

export const peopleRoutes: PeopleRoute[] = [
  open('POST', '/sign-in/options', true, signInOptions),
  open('POST', '/sign-in', true, signIn),
  open('POST', '/link/options', true, linkOptions),
  open('POST', '/link', true, linkRegister),
  open('POST', '/device', false, startDevice),
  open('POST', '/device/claim', false, claimDevice),
  person('GET', '/me', true, whoAmI),
  person('DELETE', '/sessions/(current|[0-9a-f]{64})', true, endSession),
  person('PUT', '/switches/instance', true, setInstance),
  person('GET', '/sessions', false, listSessions),
  person('GET', '/passkeys', false, listPasskeys),
  person('POST', '/passkeys/options', false, addPasskeyOptions),
  person('POST', '/passkeys', false, addPasskey),
  person('DELETE', '/passkeys/([A-Za-z0-9_-]{16,512})', false, removePasskey),
  person('POST', '/device/look', false, lookAtDevice),
  person('POST', '/device/approve', false, approveDevice),
];

const find = (request: Request) => {
  const { pathname } = new URL(request.url);
  for (const route of peopleRoutes) {
    const match = request.method === route.method ? route.path.exec(pathname) : null;
    if (match) return { route, params: match.slice(1) };
  }
  return null;
};

/** Reachable while the instance is off: sign-in, and the owner's own switch. */
export const appApiOpenWhenOff = (request: Request): boolean => find(request)?.route.off ?? false;

/** The app's own API. It takes a person's session only: an agent key gets 401. */
export async function appApi(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  try {
    const found = find(request);
    if (!found) throw (await findPerson(request, env, ctx)) ? notFound() : new ApiError('unauthorized', 'Sign in first.');
    checkSameOrigin(request, env);
    const context: AppContext = { request, env, ctx, url: new URL(request.url), params: found.params };
    if (found.route.who === 'anyone') {
      const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await env.SIGNIN_LIMIT.limit({ key: address })).success) throw new ApiError('rate_limited', 'Too many requests.');
      return await found.route.handler(context as SignedIn);
    }
    const signedIn = await findPerson(request, env, ctx);
    if (!signedIn) throw new ApiError('unauthorized', 'Sign in first.');
    return await found.route.handler({ ...context, person: signedIn });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    throw error;
  }
}
