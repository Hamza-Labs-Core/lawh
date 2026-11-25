import type { AppEnv } from '../../shared/env';
import { ApiError, notFound } from '../../shared/errors';
import { isOn } from '../../shared/switches';
import { endSession, listSessions, setInstance, whoAmI } from './account';
import { listMyPages, listMyProjects, listMyTags, listMyVersions, readPage } from './pages';
import { addComment, deleteComment, listMyThreads, listReplies, listThreads, reply, setResolved } from './comments';
import { answerDecision, countMyDecisions, listMyDecisions, listPageDecisions, readDecision } from './decisions';
import { addKey, listAgents, revokeKey, setAgentOff } from './agents';
import { exportFiles, exportPlan, exportRows } from './exportData';
import { deletePage, listDeleted, restorePage, setStatus } from './manage';
import { addProject, renameProject } from './projects';
import { readSettings, setRetention } from './settings';
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

const COMMENT = '(cmt_[0-9A-Z]{26})';
const DECISION = '(dec_[0-9A-Z]{26})';
const SLUG = '([a-z0-9][a-z0-9-]{0,79})';

export const peopleRoutes: PeopleRoute[] = [
  open('POST', '/sign-in/options', true, signInOptions),
  open('POST', '/sign-in', true, signIn),
  open('POST', '/link/options', true, linkOptions),
  open('POST', '/link', true, linkRegister),
  open('POST', '/device', false, startDevice),
  open('POST', '/device/claim', false, claimDevice),
  person('GET', '/me', true, whoAmI),
  person('DELETE', '/sessions/(current)', true, endSession),
  person('DELETE', '/sessions/([0-9a-f]{64})', false, endSession),
  person('PUT', '/switches/instance', true, setInstance),
  person('GET', '/sessions', false, listSessions),
  person('GET', '/passkeys', false, listPasskeys),
  person('POST', '/passkeys/options', false, addPasskeyOptions),
  person('POST', '/passkeys', false, addPasskey),
  person('DELETE', '/passkeys/([A-Za-z0-9_-]{1,1364})', false, removePasskey),
  person('GET', '/projects', false, listMyProjects),
  person('POST', '/projects', false, addProject),
  person('PATCH', `/projects/${SLUG}`, false, renameProject),
  person('PUT', `/projects/${SLUG}/pages/${SLUG}/status`, false, setStatus),
  person('DELETE', `/projects/${SLUG}/pages/${SLUG}`, false, deletePage),
  person('GET', '/deleted', false, listDeleted),
  person('POST', '/deleted/(pag_[0-9A-Z]{26})/restore', false, restorePage),
  person('GET', '/agents', false, listAgents),
  person('PUT', '/agents/(agt_[0-9A-Z]{26})/off', false, setAgentOff),
  person('POST', '/agent-keys', false, addKey),
  person('DELETE', '/agent-keys/(key_[0-9A-Z]{26})', false, revokeKey),
  person('GET', '/settings', false, readSettings),
  person('PUT', '/settings/retention', false, setRetention),
  person('GET', '/export', false, exportPlan),
  person('GET', '/export/rows', false, exportRows),
  person('GET', '/export/files', false, exportFiles),
  person('GET', '/pages', false, listMyPages),
  person('GET', '/tags', false, listMyTags),
  person('GET', `/projects/${SLUG}/pages/${SLUG}`, false, readPage),
  person('GET', `/projects/${SLUG}/pages/${SLUG}/versions`, false, listMyVersions),
  person('GET', `/projects/${SLUG}/pages/${SLUG}/decisions`, false, listPageDecisions),
  person('GET', `/projects/${SLUG}/pages/${SLUG}/comments`, false, listThreads),
  person('POST', `/projects/${SLUG}/pages/${SLUG}/comments`, false, addComment),
  person('GET', '/comments', false, listMyThreads),
  person('DELETE', `/comments/${COMMENT}`, false, deleteComment),
  person('GET', `/comments/${COMMENT}/replies`, false, listReplies),
  person('POST', `/comments/${COMMENT}/replies`, false, reply),
  person('PUT', `/comments/${COMMENT}/resolved`, false, setResolved),
  person('GET', '/decisions', false, listMyDecisions),
  person('GET', '/decisions/count', false, countMyDecisions),
  person('GET', `/decisions/${DECISION}`, false, readDecision),
  person('POST', `/decisions/${DECISION}/answers`, false, answerDecision),
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
    if (request.headers.has('Authorization')) throw new ApiError('unauthorized', 'Sign in first.');
    // Before anything is looked up, so another site learns nothing about which routes there are.
    checkSameOrigin(request, env);
    const found = find(request);
    const context: AppContext = { request, env, ctx, url: new URL(request.url), params: found?.params ?? [] };
    if (found?.route.who === 'anyone') {
      const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!(await env.SIGNIN_LIMIT.limit({ key: address })).success) throw new ApiError('rate_limited', 'Too many requests.');
      return await found.route.handler(context as SignedIn);
    }
    const signedIn = await findPerson(request, env, ctx);
    if (!signedIn) throw (await isOn(env.DB, 'instance')) ? new ApiError('unauthorized', 'Sign in first.') : new ApiError('feature_off', 'This feature is off.');
    if (!found) throw notFound();
    return await found.route.handler({ ...context, person: signedIn });
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse();
    throw error;
  }
}
