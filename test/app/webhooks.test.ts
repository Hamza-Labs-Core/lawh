import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacHex } from '../../src/shared/crypto';
import type { WebhookMessage } from '../../src/shared/env';
import { decryptWebhookSecret, encryptWebhookSecret, normalizeHost } from '../../src/app/webhooks/crypto';
import { deliverOne, dispatchOutbox, handleWebhookQueue } from '../../src/app/webhooks/deliver';
import { call as agent, code as apiCode, json, makeKey, publish, seed as seedAgents, sql } from './api/helpers';
import { api, code, count, enter, one } from './people/helpers';

let token: string;
const member = async (level: number) => {
  const { cookie } = await enter('m');
  await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',${level},'o',1)`);
  return cookie;
};

beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
  ({ token } = await makeKey());
});
afterEach(() => { vi.restoreAllMocks(); });

describe('GET /v1/events', () => {
  it('works while webhooks is off, filters by scope, advances next past unreadable events, and paginates', async () => {
    const empty = await json(await agent('/v1/events?project=one', { token }));
    expect(empty).toEqual({ items: [], next: 0 });

    const { cookie: owner } = await enter('o');
    const published = await json(await publish(token, { 'index.html': '<p>hello</p>' }, {
      page: { title: 'Hello', status: 'in_review' },
      decisions: [{ key: 'd1', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    }));
    const dec = (await json(await api('GET', '/projects/one/pages/page/decisions', { cookie: owner }))).items[0];
    await api('POST', `/decisions/${dec.id}/answers`, { cookie: owner, body: { revision: 1, seq: 0, optionId: 'a', notes: 'secret-note' } });
    const cmtId = `cmt_${'A'.repeat(26)}`;
    await api('POST', '/projects/one/pages/page/comments', { cookie: owner, body: { id: cmtId, body: 'comment-text', versionN: 1 } });
    await api('PUT', `/comments/${cmtId}/resolved`, { cookie: owner, body: { resolved: true } });

    // Without after: returns newest seq with no items.
    const head = await json(await agent('/v1/events?project=one', { token }));
    expect(head.items).toEqual([]);
    expect(head.next).toBe(5);

    // Full feed from after=0 with all scopes.
    const all = await json(await agent('/v1/events?project=one&after=0', { token }));
    expect(all.next).toBe(5);
    expect(all.items.map((e: { type: string; actorType: string }) => [e.type, e.actorType])).toEqual([
      ['page.published', 'agent'],
      ['decision.answered', 'person'],
      ['page.status', 'person'],
      ['comment.created', 'person'],
      ['comment.resolved', 'person'],
    ]);
    expect(all.items[0]).toMatchObject({ pageId: published.id, subjectId: published.id, actorId: 'ao' });
    expect(all.items[1]).toMatchObject({ pageId: published.id, subjectId: dec.id, actorId: 'o' });
    // Never leaks notes or comment text in events.
    expect(JSON.stringify(all)).not.toContain('secret-note');
    expect(JSON.stringify(all)).not.toContain('comment-text');

    // Pagination: limit=2 stops at item 2, then item 4, then newest=5.
    const p1 = await json(await agent('/v1/events?project=one&after=0&limit=2', { token }));
    expect(p1.items.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(p1.next).toBe(2);
    const p2 = await json(await agent(`/v1/events?project=one&after=${p1.next}&limit=2`, { token }));
    expect(p2.items.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);
    expect(p2.next).toBe(4);
    const p3 = await json(await agent(`/v1/events?project=one&after=${p2.next}&limit=2`, { token }));
    expect(p3.items.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect(p3.next).toBe(5);

    // Scope filtering: decisions:read sees only decision.*, and next still advances to newest=5.
    const decKey = (await makeKey({ scopes: ['decisions:read'] })).token;
    const decOnly = await json(await agent('/v1/events?project=one&after=0', { token: decKey }));
    expect(decOnly.items.map((e: { type: string }) => e.type)).toEqual(['decision.answered']);
    expect(decOnly.next).toBe(5);

    // Key with no read scopes skips event query and still advances next to newest.
    const writeOnly = (await makeKey({ scopes: ['pages:write'] })).token;
    expect(await json(await agent('/v1/events?project=one&after=0', { token: writeOnly }))).toEqual({ items: [], next: 5 });

    // Validation & access control.
    expect(await apiCode(await agent('/v1/events', { token }))).toEqual([422, 'invalid']);
    expect(await apiCode(await agent('/v1/events?project=one&after=-1', { token }))).toEqual([422, 'invalid']);
    expect(await apiCode(await agent('/v1/events?project=one&after=abc', { token }))).toEqual([422, 'invalid']);
    const otherKey = (await makeKey({ projects: ['p2'] })).token;
    expect(await apiCode(await agent('/v1/events?project=one&after=0', { token: otherKey }))).toEqual([404, 'not_found']);
  });
});

describe('webhooks switch, allowlist, CRUD, and delivery', () => {
  it('returns 404 feature_off while webhooks is off, and turning it on skips older events', async () => {
    const { cookie: owner } = await enter('o');
    await publish(token, { 'index.html': '<p>old</p>' });
    expect(await count('events', 'enqueued_at IS NULL')).toBe(1);

    expect(await code(await api('GET', '/webhooks', { cookie: owner }))).toEqual([404, 'feature_off']);
    expect(await code(await api('POST', '/webhooks', { cookie: owner, body: { project: 'one', url: 'https://hooks.example.com/a', eventTypes: ['page.published'] } }))).toEqual([404, 'feature_off']);
    // Non-owner cannot toggle switch or set hosts.
    const mgr = await member(4);
    expect(await code(await api('PUT', '/switches/webhooks', { cookie: mgr, body: { on: true } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('PUT', '/settings/webhook-hosts', { cookie: mgr, body: { hosts: ['hooks.example.com'] } }))).toEqual([403, 'forbidden']);

    expect((await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } })).status).toBe(200);
    // Pre-switch event was drained so it will not be replayed.
    expect(await count('events', 'enqueued_at IS NULL')).toBe(0);
    expect((await json(await api('GET', '/me', { cookie: owner }))).webhooks).toBe(true);
  });

  it('validates hosts, encrypts secrets with webhook-id AAD, and enforces manager permissions atomically', async () => {
    const { cookie: owner } = await enter('o');
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });

    for (const bad of ['localhost', '127.0.0.1', 'foo.local', 'bar.internal', 'https://hooks.example.com', 'hooks.example.com:8443', 'bad host', 'nodot']) {
      expect(() => normalizeHost(bad), bad).toThrow();
    }
    const savedHosts = await json(await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: ['Hooks.Example.COM.', 'hooks.example.com'] } }));
    expect(savedHosts).toEqual({ webhookHosts: ['hooks.example.com'] });

    // Below manager: forbidden. Unmanaged project: 404.
    const decider = await member(3);
    expect(await code(await api('GET', '/webhooks', { cookie: decider }))).toEqual([403, 'forbidden']);
    expect(await code(await api('POST', '/webhooks', { cookie: decider, body: { project: 'one', url: 'https://hooks.example.com/h', eventTypes: ['page.published'] } }))).toEqual([403, 'forbidden']);
    await sql("UPDATE team_members SET level=4, set_by='o' WHERE member_id='m'");
    expect(await code(await api('POST', '/webhooks', { cookie: decider, body: { project: 'three', url: 'https://hooks.example.com/h', eventTypes: ['page.published'] } }))).toEqual([404, 'not_found']);

    // Rejects HTTP, credentials, fragments, and unlisted hosts.
    for (const url of ['http://hooks.example.com/a', 'https://other.example.com/a', 'https://u:p@hooks.example.com/a', 'https://hooks.example.com/a#frag']) {
      expect(await code(await api('POST', '/webhooks', { cookie: decider, body: { project: 'one', url, eventTypes: ['page.published'] } })), url).toEqual([422, 'invalid']);
    }

    // Manager creates a webhook on a managed project; secret is returned once and encrypted at rest.
    const created = await api('POST', '/webhooks', { cookie: decider, body: { project: 'one', url: 'https://hooks.example.com/lawh', eventTypes: ['page.published', 'comment.created'] } });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const listed = await json(await api('GET', '/webhooks', { cookie: decider }));
    expect(JSON.stringify(listed)).not.toContain(body.secret);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: body.id, url: 'https://hooks.example.com/lawh', enabled: true, createdBy: 'Mona' });

    // Verify AES-GCM ciphertext and AAD binding.
    const raw = (await one<{ secret_enc: number[] }>('SELECT secret_enc FROM webhooks WHERE id=?', body.id))!.secret_enc;
    expect(await decryptWebhookSecret(env, body.id, raw)).toBe(body.secret);
    await expect(decryptWebhookSecret(env, 'whk_00000000000000000000000000', raw)).rejects.toThrow();
    const ct = await encryptWebhookSecret(env, 'whk_test', 'whsec_abc');
    expect(new TextDecoder().decode(ct)).not.toContain('whsec_abc');

    // Demotion right before batch rolls back webhook update & delete.
    let armed = true;
    const demoteDb = new Proxy(env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (armed) { armed = false; await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'"); }
        return target.batch(statements);
      };
      const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
    } });
    expect(await code(await api('PATCH', `/webhooks/${body.id}`, { cookie: decider, body: { enabled: false } }, { DB: demoteDb }))).toEqual([403, 'forbidden']);
    expect((await one<{ enabled: number }>('SELECT enabled FROM webhooks WHERE id=?', body.id))!.enabled).toBe(1);
    expect((await api('DELETE', `/webhooks/${body.id}`, { cookie: owner })).status).toBe(204);
    expect(await count('webhooks')).toBe(0);
  });

  it('signs deliveries, refuses redirects, records DLQ failures, and supports Send again', async () => {
    const { cookie: owner } = await enter('o');
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });
    await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: ['hooks.example.com'] } });
    const hook = await json(await api('POST', '/webhooks', { cookie: owner, body: { project: 'one', url: 'https://hooks.example.com/rx', eventTypes: ['page.published'] } }));

    // Intercept queue sends so we control delivery deterministically.
    const sent: WebhookMessage[] = [];
    const queue = { send: async (msg: WebhookMessage) => { sent.push(msg); } } as unknown as Queue<WebhookMessage>;
    await publish(token, { 'index.html': '<p>private-body-never-in-webhook</p>' }, { page: { title: 'Private Title' } }, 'one/pages/page', { WEBHOOKS: queue });
    expect(sent).toEqual([{ webhookId: hook.id, eventSeq: 1 }]);
    // Calling dispatchOutbox again is a no-op once claimed; a fresh un-enqueued event is picked up by the cron fallback.
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toHaveLength(1);
    await sql("INSERT INTO events(project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES('p1',NULL,'page.published','pg_manual','agent','ao',1)");
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toEqual([{ webhookId: hook.id, eventSeq: 1 }, { webhookId: hook.id, eventSeq: 2 }]);

    // 1) A 302 redirect is NOT followed and triggers retry.
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/' } });
    });
    const r1 = await deliverOne(env, hook.id, 1, 1, 1_700_000_000_000);
    expect(r1).toBe('retry');
    expect(calls[0]!.init.redirect).toBe('manual');
    const sigHeader = new Headers(calls[0]!.init.headers).get('Lawh-Signature')!;
    const reqBody = String(calls[0]!.init.body);
    expect(reqBody).not.toContain('private-body-never-in-webhook');
    expect(reqBody).not.toContain('Private Title');
    const parsedBody = JSON.parse(reqBody) as Record<string, unknown>;
    expect(parsedBody).toMatchObject({ seq: 1, project: 'one', type: 'page.published', actorType: 'agent', actorId: 'ao' });
    const expectedSig = `t=1700000000,v1=${await hmacHex(hook.secret, `1700000000.${reqBody}`)}`;
    expect(sigHeader).toBe(expectedSig);

    // 2) DLQ consumer marks the delivery failed.
    let acked = false;
    await handleWebhookQueue({
      queue: 'lawh-webhooks-dlq',
      messages: [{ id: 'm1', timestamp: new Date(), attempts: 5, body: { webhookId: hook.id, eventSeq: 1 }, ack: () => { acked = true; }, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_060_000);
    expect(acked).toBe(true);

    const listed = await json(await api('GET', '/webhooks', { cookie: owner }));
    expect(listed.failed).toHaveLength(1);
    expect(listed.failed[0]).toMatchObject({ webhookId: hook.id, eventSeq: 1, lastCode: 302, eventType: 'page.published' });

    // 3) Send again re-queues and delivers cleanly on 200.
    const resent: WebhookMessage[] = [];
    const resendQueue = { send: async (msg: WebhookMessage) => { resent.push(msg); } } as unknown as Queue<WebhookMessage>;
    expect((await api('POST', `/webhooks/${hook.id}/deliveries/1/resend`, { cookie: owner }, { WEBHOOKS: resendQueue })).status).toBe(202);
    expect(resent).toEqual([{ webhookId: hook.id, eventSeq: 1 }]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    expect(await deliverOne(env, hook.id, 1, 1, 1_700_000_120_000)).toBe('ack');
    expect((await one<{ status: string; last_code: number }>('SELECT status, last_code FROM webhook_deliveries WHERE webhook_id=? AND event_seq=1', hook.id))).toEqual({ status: 'delivered', last_code: 200 });
    expect((await json(await api('GET', '/webhooks', { cookie: owner }))).failed).toEqual([]);
  });
});
