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
    expect((await json(await api('GET', '/me', { cookie: owner }))).webhooks).toBe(true);
    // Turning webhooks on skips all pre-switch events (even arbitrarily large backlogs) via atomic watermark.
    await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: ['hooks.example.com'] } });
    await api('POST', '/webhooks', { cookie: owner, body: { project: 'one', url: 'https://hooks.example.com/a', eventTypes: ['page.published'] } });
    const sent: WebhookMessage[] = [];
    const queue = { send: async (msg: WebhookMessage) => { sent.push(msg); } } as unknown as Queue<WebhookMessage>;
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toEqual([]);
    // Turning off, recording a huge backlog (seq 6000), and re-enabling still replays nothing.
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: false } });
    await sql("INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES(6000,'p1',NULL,'page.published','pg_old','agent','ao',1)");
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toEqual([]);
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

    // Rejects HTTP, non-default ports, credentials, fragments, and unlisted hosts.
    for (const url of ['http://hooks.example.com/a', 'https://hooks.example.com:8443/a', 'https://other.example.com/a', 'https://u:p@hooks.example.com/a', 'https://hooks.example.com/a#frag']) {
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
    expect(sent).toMatchObject([{ webhookId: hook.id, eventSeq: 1 }]);
    expect(sent[0]!.token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Calling dispatchOutbox again is a no-op once claimed; a fresh un-enqueued event is picked up by the cron fallback.
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toHaveLength(1);
    await sql("INSERT INTO events(project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES('p1',NULL,'page.published','pg_manual','agent','ao',1)");
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(sent).toMatchObject([{ webhookId: hook.id, eventSeq: 1 }, { webhookId: hook.id, eventSeq: 2 }]);

    // 1) A 302 redirect is NOT followed and triggers retry.
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/' } });
    });
    const r1 = await deliverOne(env, hook.id, 1, 1, 1_700_000_000_000, sent[0]!.token);
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
      messages: [{ id: 'm1', timestamp: new Date(), attempts: 5, body: { webhookId: hook.id, eventSeq: 1, token: sent[0]!.token }, ack: () => { acked = true; }, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_060_000);
    expect(acked).toBe(true);

    const listed = await json(await api('GET', '/webhooks', { cookie: owner }));
    expect(listed.failed).toHaveLength(1);
    expect(listed.failed[0]).toMatchObject({ webhookId: hook.id, eventSeq: 1, lastCode: 302, eventType: 'page.published' });

    // 3) Send again re-queues with a fresh generation token and delivers cleanly on 200.
    const resent: WebhookMessage[] = [];
    const resendQueue = { send: async (msg: WebhookMessage) => { resent.push(msg); } } as unknown as Queue<WebhookMessage>;
    expect((await api('POST', `/webhooks/${hook.id}/deliveries/1/resend`, { cookie: owner }, { WEBHOOKS: resendQueue })).status).toBe(202);
    expect(resent).toMatchObject([{ webhookId: hook.id, eventSeq: 1 }]);
    expect(resent[0]!.token).not.toBe(sent[0]!.token);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    expect(await deliverOne(env, hook.id, 1, 1, 1_700_000_120_000, resent[0]!.token)).toBe('ack');
    expect((await one<{ status: string; last_code: number }>('SELECT status, last_code FROM webhook_deliveries WHERE webhook_id=? AND event_seq=1', hook.id))).toEqual({ status: 'delivered', last_code: 200 });
    expect((await json(await api('GET', '/webhooks', { cookie: owner }))).failed).toEqual([]);
  });

  it('recovers interrupted dispatch, enforces watermark on stale recovery, bounds queue send, isolates DLQ tokens, and avoids PATCH lost updates', async () => {
    const { cookie: owner } = await enter('o');
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });
    await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: ['hooks.example.com'] } });
    const hook = await json(await api('POST', '/webhooks', { cookie: owner, body: { project: 'one', url: 'https://hooks.example.com/rx', eventTypes: ['page.published'] } }));

    // 1) Interrupted dispatch (delivery row inserted as 'queuing') recovers on next dispatch once stale,
    //    and if the webhook was unsubscribed meanwhile, transitions cleanly to 'failed' instead of staying stuck.
    await sql(
      "INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES(10,'p1',NULL,'page.published','pg1','agent','ao',1),(14,'p1',NULL,'comment.created','cm1','person','o',1)",
      `INSERT INTO webhook_deliveries(webhook_id,event_seq,attempts,status,updated_at) VALUES('${hook.id}',10,0,'queuing',1),('${hook.id}',14,0,'queuing',1)`,
    );
    const recovered: WebhookMessage[] = [];
    const queue = { send: async (msg: WebhookMessage) => { recovered.push(msg); } } as unknown as Queue<WebhookMessage>;
    await dispatchOutbox({ ...env, WEBHOOKS: queue });
    expect(recovered).toMatchObject([{ webhookId: hook.id, eventSeq: 10 }]);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=10', hook.id))!.status).toBe(`pending:${recovered[0]!.token!}`);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=14', hook.id))!.status).toBe('failed');
    expect((await one<{ enqueued_at: number | null }>('SELECT enqueued_at FROM events WHERE seq=10'))!.enqueued_at).not.toBeNull();

    // 1b) Overlapping dispatchers on the same event claim atomically and never duplicate sends, and stalled queue send times out before stale recovery.
    await sql("INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES(15,'p1',NULL,'page.published','pg15','agent','ao',1)");
    const overlapSent: WebhookMessage[] = [];
    const overlapQueue = { send: async (msg: WebhookMessage) => { overlapSent.push(msg); } } as unknown as Queue<WebhookMessage>;
    await Promise.all([dispatchOutbox({ ...env, WEBHOOKS: overlapQueue }), dispatchOutbox({ ...env, WEBHOOKS: overlapQueue })]);
    expect(overlapSent).toMatchObject([{ webhookId: hook.id, eventSeq: 15 }]);

    await sql("INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES(17,'p1',NULL,'page.published','pg17','agent','ao',1)");
    const hangingQueue = { send: () => new Promise<void>(() => {}) } as unknown as Queue<WebhookMessage>;
    await dispatchOutbox({ ...env, WEBHOOKS: hangingQueue }, Date.now(), 25);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=17', hook.id))!.status).toBe('failed');

    // 1c) Stale dispatcher and stale recovery sweep both enforce the live watermark after off/on toggle.
    await sql(
      "INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at) VALUES(16,'p1',NULL,'page.published','pg16','agent','ao',1),(18,'p1',NULL,'page.published','pg18','agent','ao',1)",
      `INSERT INTO webhook_deliveries(webhook_id,event_seq,attempts,status,updated_at) VALUES('${hook.id}',18,0,'queuing',1)`,
    );
    let toggled = false;
    const staleDb = new Proxy(env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!toggled) {
          toggled = true;
          await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: false } });
          await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });
        }
        return target.batch(statements);
      };
      const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
    } });
    const staleSent: WebhookMessage[] = [];
    await dispatchOutbox({ ...env, DB: staleDb, WEBHOOKS: { send: async (m: WebhookMessage) => { staleSent.push(m); } } as unknown as Queue<WebhookMessage> });
    expect(staleSent).toEqual([]);
    expect(await one('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=16', hook.id)).toBeNull();
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=18', hook.id))!.status).toBe('failed');

    // 2) Old DLQ messages (matching cycle-1 token) cannot overwrite a manual resend even at attempts=0 or after a transient failure ('retrying:cycle2').
    const tok1 = recovered[0]!.token!;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 503 }));
    expect(await deliverOne(env, hook.id, 10, 6, 1_700_000_000_000, tok1)).toBe('retry');
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=10', hook.id))!.status).toBe(`retrying:${tok1}`);

    // Resend seq 17 (which has attempts=0 from timeout above): old DLQ with wrong token does not overwrite pending:tok2 OR retrying:tok2.
    const resendMsgs: WebhookMessage[] = [];
    const resendQ = { send: async (m: WebhookMessage) => { resendMsgs.push(m); } } as unknown as Queue<WebhookMessage>;
    await api('POST', `/webhooks/${hook.id}/deliveries/17/resend`, { cookie: owner }, { WEBHOOKS: resendQ });
    const tok2 = resendMsgs[0]!.token!;
    await handleWebhookQueue({
      queue: 'lawh-webhooks-dlq',
      messages: [{ id: 'dlq-old-0', timestamp: new Date(), attempts: 6, body: { webhookId: hook.id, eventSeq: 17, token: 'old_token_000000' }, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_005_000);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=17', hook.id))!.status).toBe(`pending:${tok2}`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 503 }));
    expect(await deliverOne(env, hook.id, 17, 1, 1_700_000_006_000, tok2)).toBe('retry');
    await handleWebhookQueue({
      queue: 'lawh-webhooks-dlq',
      messages: [{ id: 'dlq-old-1', timestamp: new Date(), attempts: 6, body: { webhookId: hook.id, eventSeq: 17, token: 'old_token_000000' }, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_007_000);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=17', hook.id))!.status).toBe(`retrying:${tok2}`);

    // Late 503 cannot overwrite a completed 204.
    let releaseSlow!: (r: Response) => void;
    const slow = new Promise<Response>((r) => { releaseSlow = r; });
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => slow)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const pSlow = deliverOne(env, hook.id, 10, 6, 1_700_000_010_000, tok1);
    expect(await deliverOne(env, hook.id, 10, 6, 1_700_000_011_000, tok1)).toBe('ack');
    releaseSlow(new Response('late fail', { status: 503 }));
    await pSlow;
    expect((await one<{ status: string; last_code: number }>('SELECT status, last_code FROM webhook_deliveries WHERE webhook_id=? AND event_seq=10', hook.id))).toEqual({ status: 'delivered', last_code: 204 });

    // 3) Host removal mid-batch takes effect for the very next message in the same batch.
    await sql(
      "INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at,enqueued_at) VALUES(11,'p1',NULL,'page.published','pg2','agent','ao',1,1),(12,'p1',NULL,'page.published','pg3','agent','ao',1,1)",
      `INSERT INTO webhook_deliveries(webhook_id,event_seq,attempts,status,updated_at) VALUES('${hook.id}',11,0,'pending',1),('${hook.id}',12,0,'pending',1)`,
    );
    let fetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCount++;
      await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: [] } });
      return new Response('ok', { status: 200 });
    });
    await handleWebhookQueue({
      queue: 'lawh-webhooks',
      messages: [
        { id: 'b1', timestamp: new Date(), attempts: 1, body: { webhookId: hook.id, eventSeq: 11 }, ack: () => {}, retry: () => {} },
        { id: 'b2', timestamp: new Date(), attempts: 1, body: { webhookId: hook.id, eventSeq: 12 }, ack: () => {}, retry: () => {} },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_020_000);
    expect(fetchCount).toBe(1);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=12', hook.id))!.status).toBe('failed');

    // 4) Turning webhooks off marks queued deliveries failed so re-enabling exposes Send again.
    await api('PUT', '/settings/webhook-hosts', { cookie: owner, body: { hosts: ['hooks.example.com'] } });
    await sql(
      "INSERT INTO events(seq,project_id,page_id,type,subject_id,actor_type,actor_id,created_at,enqueued_at) VALUES(13,'p1',NULL,'page.published','pg4','agent','ao',1,1)",
      `INSERT INTO webhook_deliveries(webhook_id,event_seq,attempts,status,updated_at) VALUES('${hook.id}',13,0,'pending',1)`,
    );
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: false } });
    await handleWebhookQueue({
      queue: 'lawh-webhooks',
      messages: [{ id: 'b3', timestamp: new Date(), attempts: 1, body: { webhookId: hook.id, eventSeq: 13 }, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<WebhookMessage>, env, 1_700_000_030_000);
    expect((await one<{ status: string }>('SELECT status FROM webhook_deliveries WHERE webhook_id=? AND event_seq=13', hook.id))!.status).toBe('failed');

    // 5) Event-types-only PATCH overlapping a pause preserves enabled=false.
    await api('PUT', '/switches/webhooks', { cookie: owner, body: { on: true } });
    let paused = false;
    const raceDb = new Proxy(env.DB, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!paused) { paused = true; await sql(`UPDATE webhooks SET enabled=0 WHERE id='${hook.id}'`); }
        return target.batch(statements);
      };
      const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
    } });
    const patched = await json(await api('PATCH', `/webhooks/${hook.id}`, { cookie: owner, body: { eventTypes: ['comment.created'] } }, { DB: raceDb }));
    expect(patched).toEqual({ id: hook.id, enabled: false, eventTypes: ['comment.created'] });
    expect((await one<{ enabled: number }>('SELECT enabled FROM webhooks WHERE id=?', hook.id))!.enabled).toBe(0);
  });
});
