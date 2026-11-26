import { beforeEach, describe, expect, it } from 'vitest';
import { peopleRoutes } from '../../../src/app/people/router';
import { json, makeKey, publish, seed as seedAgents, sql } from '../api/helpers';
import { api, enter } from './helpers';

/**
 * Exhaustive every-route × every-level test matrix required by docs/spec/teams.md and S17.
 * Fails automatically if any route in `peopleRoutes` is missing an entry here.
 *
 * Levels:
 *   0 = member in no team (no access to project `one`)
 *   1 = viewer on project `one`
 *   2 = commenter on project `one`
 *   3 = decider on project `one`
 *   4 = manager on team `t1` (which has project `one`)
 *   5 = owner
 */
type StatusCheck = number | number[];
interface MatrixRow {
  method: string;
  pattern: string;
  request: (fx: Fixture) => { path: string; body?: unknown };
  /** Expected HTTP status per level [0, 1, 2, 3, 4, 5]. */
  expected: [StatusCheck, StatusCheck, StatusCheck, StatusCheck, StatusCheck, StatusCheck];
  /** Skip teams-off check for unauthenticated/open routes. */
  open?: boolean;
}

interface Fixture {
  pageId: string;
  deletedPageId: string;
  decisionId: string;
  commentId: string;
  agentId: string;
  keyId: string;
  webhookId: string;
  teamId: string;
  otherMemberId: string;
  teamMemberId: string;
  pendingInviteId: string;
  ownerInviteId: string;
  connectId: string;
  connectCode: string;
}

const routeKey = (method: string, path: RegExp | string) => `${method} ${(typeof path === 'string' ? path : path.source).replaceAll('\\/', '/')}`;

const MATRIX: MatrixRow[] = [
  // Open / unauthenticated auth & device routes
  { method: 'POST', pattern: '^/app-api/sign-in/options$', open: true, request: () => ({ path: '/sign-in/options', body: {} }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/sign-in$', open: true, request: () => ({ path: '/sign-in', body: {} }), expected: [422, 422, 422, 422, 422, 422] },
  { method: 'POST', pattern: '^/app-api/link/options$', open: true, request: () => ({ path: '/link/options', body: {} }), expected: [404, 404, 404, 404, 404, 404] },
  { method: 'POST', pattern: '^/app-api/link$', open: true, request: () => ({ path: '/link', body: {} }), expected: [404, 404, 404, 404, 404, 404] },
  { method: 'POST', pattern: '^/app-api/device$', open: true, request: () => ({ path: '/device', body: {} }), expected: [201, 201, 201, 201, 201, 201] },
  { method: 'POST', pattern: '^/app-api/device/claim$', open: true, request: () => ({ path: '/device/claim', body: {} }), expected: [404, 404, 404, 404, 404, 404] },

  // Account & own sessions/passkeys/device approval (any signed-in person)
  { method: 'GET', pattern: '^/app-api/me$', request: () => ({ path: '/me' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/sessions/(current)$', request: () => ({ path: '/sessions/current' }), expected: [204, 204, 204, 204, 204, 204] },
  { method: 'DELETE', pattern: '^/app-api/sessions/([0-9a-f]{64})$', request: () => ({ path: `/sessions/${'0'.repeat(64)}` }), expected: [404, 404, 404, 404, 404, 404] },
  { method: 'PUT', pattern: '^/app-api/switches/instance$', request: () => ({ path: '/switches/instance', body: { on: true } }), expected: [403, 403, 403, 403, 403, 204] },
  { method: 'GET', pattern: '^/app-api/sessions$', request: () => ({ path: '/sessions' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/passkeys$', request: () => ({ path: '/passkeys' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/passkeys/options$', request: () => ({ path: '/passkeys/options', body: {} }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/passkeys$', request: () => ({ path: '/passkeys', body: {} }), expected: [422, 422, 422, 422, 422, 422] },
  { method: 'DELETE', pattern: '^/app-api/passkeys/([A-Za-z0-9_-]{1,1364})$', request: () => ({ path: '/passkeys/missing-cred' }), expected: [409, 409, 409, 409, 409, 409] },
  { method: 'POST', pattern: '^/app-api/device/look$', request: () => ({ path: '/device/look', body: { code: 'BBBB-CCCC' } }), expected: [404, 404, 404, 404, 404, 404] },
  { method: 'POST', pattern: '^/app-api/device/approve$', request: () => ({ path: '/device/approve', body: { id: 'dev_01', code: 'BBBB-CCCC' } }), expected: [404, 404, 404, 404, 404, 404] },

  // Projects (list any, create/rename owner only)
  { method: 'GET', pattern: '^/app-api/projects$', request: () => ({ path: '/projects' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/projects$', request: () => ({ path: '/projects', body: { slug: 'mx-new', name: { en: 'N', ar: 'ج' } } }), expected: [403, 403, 403, 403, 403, 201] },
  { method: 'PATCH', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})$', request: () => ({ path: '/projects/one', body: { name: { en: 'One2', ar: 'واحد٢' } } }), expected: [404, 403, 403, 403, 403, 200] },

  // Page management (manager+)
  { method: 'PUT', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})/status$', request: () => ({ path: '/projects/one/pages/page/status', body: { status: 'archived' } }), expected: [404, 403, 403, 403, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})$', request: () => ({ path: '/projects/one/pages/page' }), expected: [404, 403, 403, 403, 204, 204] },
  { method: 'GET', pattern: '^/app-api/deleted$', request: () => ({ path: '/deleted' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/deleted/(pag_[0-9A-Z]{26})/restore$', request: (fx) => ({ path: `/deleted/${fx.deletedPageId}/restore` }), expected: [404, 403, 403, 403, 200, 200] },

  // Agents & keys (manager+; owner sees/controls all agents; a member can always disable/revoke their own agent/key)
  { method: 'GET', pattern: '^/app-api/agents$', request: () => ({ path: '/agents' }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'GET', pattern: '^/app-api/account/keys$', request: () => ({ path: '/account/keys' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'PUT', pattern: '^/app-api/agents/(agt_[0-9A-Z]{26})/off$', request: (fx) => ({ path: `/agents/${fx.agentId}/off`, body: { off: true } }), expected: [204, 204, 204, 204, 204, 204] },
  { method: 'POST', pattern: '^/app-api/agents/(agt_[0-9A-Z]{26})/take-over$', request: (fx) => ({ path: `/agents/${fx.agentId}/take-over` }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'POST', pattern: '^/app-api/agent-keys$', request: () => ({ path: '/agent-keys', body: { agent: 'mx-bot', secretSha256: 'a'.repeat(64), scopes: ['pages:read'], projects: ['one'], days: 30 } }), expected: [403, 403, 403, 403, 201, 201] },
  { method: 'DELETE', pattern: '^/app-api/agent-keys/(key_[0-9A-Z]{26})$', request: (fx) => ({ path: `/agent-keys/${fx.keyId}` }), expected: [204, 204, 204, 204, 204, 204] },
  { method: 'POST', pattern: '^/app-api/connect/look$', request: (fx) => ({ path: '/connect/look', body: { code: fx.connectCode } }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'POST', pattern: '^/app-api/connect/answer$', request: (fx) => ({ path: '/connect/answer', body: { id: fx.connectId, code: fx.connectCode, refuse: true } }), expected: [403, 403, 403, 403, 204, 204] },

  // Teams (list/members manager+; team CRUD & projects owner only)
  { method: 'GET', pattern: '^/app-api/teams$', request: () => ({ path: '/teams' }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'POST', pattern: '^/app-api/teams$', request: () => ({ path: '/teams', body: { name: 'New Team' } }), expected: [403, 403, 403, 403, 403, 201] },
  { method: 'PATCH', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})$', request: (fx) => ({ path: `/teams/${fx.teamId}`, body: { name: 'Renamed' } }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'DELETE', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})$', request: (fx) => ({ path: `/teams/${fx.teamId}` }), expected: [403, 403, 403, 403, 403, 204] },
  { method: 'POST', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})/members$', request: (fx) => ({ path: `/teams/${fx.teamId}/members`, body: { memberId: fx.otherMemberId, level: 2 } }), expected: [403, 403, 403, 403, 201, 201] },
  { method: 'PATCH', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})/members/([a-zA-Z0-9_-]{1,64})$', request: (fx) => ({ path: `/teams/${fx.teamId}/members/${fx.teamMemberId}`, body: { level: 3 } }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})/members/([a-zA-Z0-9_-]{1,64})$', request: (fx) => ({ path: `/teams/${fx.teamId}/members/${fx.teamMemberId}` }), expected: [403, 403, 403, 403, 204, 204] },
  { method: 'POST', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})/projects$', request: (fx) => ({ path: `/teams/${fx.teamId}/projects`, body: { project: 'three' } }), expected: [403, 403, 403, 403, 403, 201] },
  { method: 'DELETE', pattern: '^/app-api/teams/([a-zA-Z0-9_-]{1,64})/projects/([a-z0-9][a-z0-9-]{0,79})$', request: (fx) => ({ path: `/teams/${fx.teamId}/projects/one` }), expected: [403, 403, 403, 403, 403, 204] },

  // People & invites (list/invite/renew/cancel manager+; reset/remove/teams-switch owner only)
  { method: 'GET', pattern: '^/app-api/people$', request: () => ({ path: '/people' }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'POST', pattern: '^/app-api/people/invite$', request: (fx) => ({ path: '/people/invite', body: { name: 'New Person', teamId: fx.teamId, level: 2 } }), expected: [403, 403, 403, 403, 201, 201] },
  { method: 'POST', pattern: '^/app-api/people/([a-zA-Z0-9_-]{1,64})/invite-link$', request: (fx) => ({ path: `/people/${fx.pendingInviteId}/invite-link` }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/people/([a-zA-Z0-9_-]{1,64})/invite$', request: (fx) => ({ path: `/people/${fx.ownerInviteId}/invite` }), expected: [403, 403, 403, 403, 204, 204] },
  { method: 'POST', pattern: '^/app-api/people/([a-zA-Z0-9_-]{1,64})/reset$', request: (fx) => ({ path: `/people/${fx.otherMemberId}/reset` }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'DELETE', pattern: '^/app-api/people/([a-zA-Z0-9_-]{1,64})$', request: (fx) => ({ path: `/people/${fx.otherMemberId}` }), expected: [403, 403, 403, 403, 403, 204] },
  { method: 'PUT', pattern: '^/app-api/switches/teams$', request: () => ({ path: '/switches/teams', body: { on: true } }), expected: [403, 403, 403, 403, 403, 200] },

  // Settings, switches, export (owner only)
  { method: 'GET', pattern: '^/app-api/settings$', request: () => ({ path: '/settings' }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'PUT', pattern: '^/app-api/settings/retention$', request: () => ({ path: '/settings/retention', body: { keep: 10 } }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'PUT', pattern: '^/app-api/switches/live$', request: () => ({ path: '/switches/live', body: { on: true } }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'PUT', pattern: '^/app-api/switches/webhooks$', request: () => ({ path: '/switches/webhooks', body: { on: true } }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'PUT', pattern: '^/app-api/settings/webhook-hosts$', request: () => ({ path: '/settings/webhook-hosts', body: { hosts: ['hooks.example.com'] } }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'GET', pattern: '^/app-api/export$', request: () => ({ path: '/export' }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'GET', pattern: '^/app-api/export/rows$', request: () => ({ path: '/export/rows' }), expected: [403, 403, 403, 403, 403, 200] },
  { method: 'GET', pattern: '^/app-api/export/files$', request: () => ({ path: '/export/files' }), expected: [403, 403, 403, 403, 403, 422] },

  // Webhooks (manager+ on project, behind webhooks switch)
  { method: 'GET', pattern: '^/app-api/webhooks$', request: () => ({ path: '/webhooks' }), expected: [403, 403, 403, 403, 200, 200] },
  { method: 'POST', pattern: '^/app-api/webhooks$', request: () => ({ path: '/webhooks', body: { project: 'one', url: 'https://hooks.example.com/a', eventTypes: ['page.published'] } }), expected: [404, 403, 403, 403, 201, 201] },
  { method: 'PATCH', pattern: '^/app-api/webhooks/(whk_[0-9A-Z]{26})$', request: (fx) => ({ path: `/webhooks/${fx.webhookId}`, body: { enabled: false } }), expected: [404, 403, 403, 403, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/webhooks/(whk_[0-9A-Z]{26})$', request: (fx) => ({ path: `/webhooks/${fx.webhookId}` }), expected: [404, 403, 403, 403, 204, 204] },
  { method: 'POST', pattern: '^/app-api/webhooks/(whk_[0-9A-Z]{26})/deliveries/([1-9][0-9]{0,18})/resend$', request: (fx) => ({ path: `/webhooks/${fx.webhookId}/deliveries/1/resend` }), expected: [404, 403, 403, 403, 404, 404] },

  // Pages & tags (viewer+ on project; 404 when level 0)
  { method: 'GET', pattern: '^/app-api/pages$', request: () => ({ path: '/pages' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/tags$', request: () => ({ path: '/tags' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})$', request: () => ({ path: '/projects/one/pages/page' }), expected: [404, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})/versions$', request: () => ({ path: '/projects/one/pages/page/versions' }), expected: [404, 200, 200, 200, 200, 200] },

  // Comments (read viewer+, write/reply commenter+, resolve/delete-any decider+/manager+)
  { method: 'GET', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})/comments$', request: () => ({ path: '/projects/one/pages/page/comments' }), expected: [404, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})/comments$', request: () => ({ path: '/projects/one/pages/page/comments', body: { id: 'cmt_01MATRIXNEW000000000000001', versionN: 1, body: 'hi' } }), expected: [404, 403, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/comments$', request: () => ({ path: '/comments' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'DELETE', pattern: '^/app-api/comments/(cmt_[0-9A-Z]{26})$', request: (fx) => ({ path: `/comments/${fx.commentId}` }), expected: [404, 403, 403, 403, 204, 204] },
  { method: 'GET', pattern: '^/app-api/comments/(cmt_[0-9A-Z]{26})/replies$', request: (fx) => ({ path: `/comments/${fx.commentId}/replies` }), expected: [404, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/comments/(cmt_[0-9A-Z]{26})/replies$', request: (fx) => ({ path: `/comments/${fx.commentId}/replies`, body: { id: 'cmt_01MATRIXREP000000000000001', body: 'reply' } }), expected: [404, 403, 200, 200, 200, 200] },
  { method: 'PUT', pattern: '^/app-api/comments/(cmt_[0-9A-Z]{26})/resolved$', request: (fx) => ({ path: `/comments/${fx.commentId}/resolved`, body: { resolved: true } }), expected: [404, 403, 403, 200, 200, 200] },

  // Decisions (read viewer+, answer decider+)
  { method: 'GET', pattern: '^/app-api/projects/([a-z0-9][a-z0-9-]{0,79})/pages/([a-z0-9][a-z0-9-]{0,79})/decisions$', request: () => ({ path: '/projects/one/pages/page/decisions' }), expected: [404, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/decisions$', request: () => ({ path: '/decisions' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/decisions/count$', request: () => ({ path: '/decisions/count' }), expected: [200, 200, 200, 200, 200, 200] },
  { method: 'GET', pattern: '^/app-api/decisions/(dec_[0-9A-Z]{26})$', request: (fx) => ({ path: `/decisions/${fx.decisionId}` }), expected: [404, 200, 200, 200, 200, 200] },
  { method: 'POST', pattern: '^/app-api/decisions/(dec_[0-9A-Z]{26})/answers$', request: (fx) => ({ path: `/decisions/${fx.decisionId}/answers`, body: { revision: 1, seq: 0, optionId: 'a', notes: '' } }), expected: [404, 403, 403, 200, 200, 200] },
];

async function setupFixture(): Promise<Fixture> {
  await seedAgents();
  await sql('DELETE FROM team_members');
  await sql("INSERT INTO settings(key, value_json, updated_at) VALUES('webhooks','true',1),('webhook_hosts','[\"hooks.example.com\"]',1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json");
  await sql(
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('r', 'Rami', 'member', 'o', 1)",
    "UPDATE members SET joined_at=1 WHERE id='r'",
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('q', 'Qasim', 'member', 'o', 1)",
    "UPDATE members SET joined_at=1 WHERE id='q'",
  );

  const { token } = await makeKey();
  const published = await json(await publish(token, { 'index.html': '<p>hello</p>' }, {
    page: { title: 'Matrix Page', status: 'in_review' },
    decisions: [{ key: 'k1', question: 'Pick?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
  }));
  const pageId = published.id as string;

  const delPub = await json(await publish(token, { 'index.html': '<p>del</p>' }, { page: { title: 'Del' } }, 'one/pages/del-page'));
  const deletedPageId = delPub.id as string;
  await sql(`UPDATE pages SET deleted_at = ${Date.now()} WHERE id = '${deletedPageId}'`);

  const { cookie: owner } = await enter('o');
  const decs = (await json(await api('GET', '/projects/one/pages/page/decisions', { cookie: owner }))).items as { id: string }[];
  const decisionId = decs[0]!.id;

  const commentId = 'cmt_01MATRIXOWN000000000000001';
  await api('POST', '/projects/one/pages/page/comments', { cookie: owner, body: { id: commentId, versionN: 1, body: 'owner thread' } });

  // Give Mona an agent + key AND a pending invite she created in t1 (for renew), plus an owner-created pending invite in t1 (for cancel).
  const agentId = 'agt_01MATRIXMONA00000000000001';
  const pendingInviteId = 'mem_01MATRIXPEND00000000000001';
  const ownerInviteId = 'mem_01MATRIXOWNI00000000000001';
  await sql(`INSERT INTO agents(id, member_id, name, created_at) VALUES('${agentId}', 'm', 'mona-mx', 1)`);
  await sql(`INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)`);
  const { id: keyId } = await makeKey({ agent: agentId, projects: ['p1'] });
  await sql(
    `INSERT INTO members(id, name, role, created_by, created_at) VALUES('${pendingInviteId}', 'Pending', 'member', 'm', 1)`,
    `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level) VALUES('${'c'.repeat(64)}', 'invite', '${pendingInviteId}', 'm', 1, ${Date.now() + 86_400_000}, 't1', 2)`,
    `INSERT INTO members(id, name, role, created_by, created_at) VALUES('${ownerInviteId}', 'OwnerPending', 'member', 'o', 1)`,
    `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level) VALUES('${'d'.repeat(64)}', 'invite', '${ownerInviteId}', 'o', 1, ${Date.now() + 86_400_000}, 't1', 2)`,
  );
  await sql('DELETE FROM team_members');
  await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'q', 1, 'o', 1)");

  const wh = await json(await api('POST', '/webhooks', { cookie: owner, body: { project: 'one', url: 'https://hooks.example.com/mx', eventTypes: ['page.published'] } }));
  const webhookId = wh.id as string;

  const connectId = 'key_01MATRIXCONN00000000000001';
  const connectCode = 'BBBB-CCCC';
  // Start a real connect request so code_hmac is valid.
  const started = await json(await (await import('../api/helpers')).call('/v1/connect', {
    method: 'POST',
    json: { secretSha256: 'e'.repeat(64), client: 'claude', machine: 'mx' },
  }));

  return {
    pageId,
    deletedPageId,
    decisionId,
    commentId,
    agentId,
    keyId,
    webhookId,
    teamId: 't1',
    otherMemberId: 'r',
    teamMemberId: 'q',
    pendingInviteId,
    ownerInviteId,
    connectId: started.id ?? connectId,
    connectCode: started.code ?? connectCode,
  };
}

describe('every /app-api route × every level (0..5) matrix', () => {
  beforeEach(async () => {
    // Each test sets up fresh state.
  });

  it('covers 100% of peopleRoutes with no missing or extra entries', () => {
    const actual = peopleRoutes.map((r) => routeKey(r.method, r.path)).sort();
    const tested = MATRIX.map((r) => routeKey(r.method, r.pattern)).sort();
    expect(actual).toEqual(tested);
  });

  for (const row of MATRIX) {
    it.each([0, 1, 2, 3, 4, 5] as const)(`${row.method} ${row.pattern} @ level %i`, async (level) => {
      const fx = await setupFixture();
      let cookie: string;
      if (level === 5) {
        ({ cookie } = await enter('o'));
      } else {
        ({ cookie } = await enter('m'));
        if (level > 0) {
          await sql(`INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', ${level}, 'o', 1)`);
        }
      }
      const req = row.request(fx);
      const res = await api(row.method, req.path, { cookie, ...(req.body !== undefined ? { body: req.body } : {}) });
      const want = row.expected[level];
      if (Array.isArray(want)) {
        expect(want, `${row.method} ${req.path} @ level ${level}`).toContain(res.status);
      } else {
        expect(res.status, `${row.method} ${req.path} @ level ${level}`).toBe(want);
      }
    });
  }
});
