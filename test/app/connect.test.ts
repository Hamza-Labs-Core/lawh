import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomToken, sha256Hex } from '../../src/shared/crypto';
import { cleanUpPeople } from '../../src/app/people/cleanUp';
import { call as agent, code as apiCode, json, seed as seedAgents, sql } from './api/helpers';
import { api, code, count, enter, one } from './people/helpers';

const member = async (level: number) => {
  const { cookie } = await enter('m');
  await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',${level},'o',1)`);
  return cookie;
};

beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
});
afterEach(() => { vi.useRealTimers(); });

describe('connect an agent (/v1/connect, /app-api/connect/*, /connect.md, /lawh.mjs)', () => {
  it('completes the full connect flow, creates the agent & key atomically, and survives connect row cleanup', async () => {
    const secret = randomToken();
    const secretSha256 = await sha256Hex(secret);

    // 1) Start connection without auth.
    const startedRes = await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256, client: 'claude', machine: 'laptop' },
    });
    expect(startedRes.status).toBe(201);
    const started = await json(startedRes);
    expect(started.id).toMatch(/^key_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(started.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(started.url).toBe('http://localhost:8787/connect');
    expect(started.interval).toBe(3);
    const fullKey = `lawh_${started.id}_${secret}`;

    // Polling while pending returns 202; wrong secret returns 404.
    expect((await agent(`/v1/connect/${started.id}`, { token: fullKey })).status).toBe(202);
    const wrongKey = `lawh_${started.id}_${randomToken()}`;
    expect(await apiCode(await agent(`/v1/connect/${started.id}`, { token: wrongKey }))).toEqual([404, 'not_found']);

    // 2) Below manager cannot look up or answer connect requests.
    const decider = await member(3);
    expect(await code(await api('POST', '/connect/look', { cookie: decider, body: { code: started.code } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('POST', '/connect/answer', { cookie: decider, body: { id: started.id, code: started.code, refuse: true } }))).toEqual([403, 'forbidden']);

    // 3) Owner looks up the code (case/dash insensitive) and connects as a new agent on project one.
    const { cookie: owner } = await enter('o');
    const looked = await json(await api('POST', '/connect/look', {
      cookie: owner,
      body: { code: started.code.toLowerCase().replace('-', ' ') },
    }));
    expect(looked).toMatchObject({ id: started.id, client: 'claude', machine: 'laptop' });
    expect(looked.projects.map((p: { slug: string }) => p.slug)).toEqual(['one', 'three', 'two']);

    const answered = await api('POST', '/connect/answer', {
      cookie: owner,
      body: { id: started.id, code: started.code, agentName: 'claude-laptop', projects: ['one'] },
    });
    expect(answered.status).toBe(200);
    expect(await json(answered)).toMatchObject({ id: started.id, agentName: 'claude-laptop' });

    // Re-answering the same request fails with 404.
    expect(await code(await api('POST', '/connect/answer', {
      cookie: owner,
      body: { id: started.id, code: started.code, agentName: 'claude-laptop', projects: ['one'] },
    }))).toEqual([404, 'not_found']);

    // 4) Polling returns 200 Me (and never includes the secret); key works on /v1/me.
    const polledRes = await agent(`/v1/connect/${started.id}`, { token: fullKey });
    expect(polledRes.status).toBe(200);
    const polled = await json(polledRes);
    expect(JSON.stringify(polled)).not.toContain(secret);
    expect(polled).toMatchObject({
      name: 'claude-laptop',
      allProjects: false,
      projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
    });
    expect((await agent('/v1/me', { token: fullKey })).status).toBe(200);

    // 5) Even after the connect row expires and is cleaned up, GET /v1/connect/{id} still returns 200 for the live key!
    await cleanUpPeople(env, Date.now() + 3_600_000);
    expect(await count('agent_connects')).toBe(0);
    expect((await agent(`/v1/connect/${started.id}`, { token: fullKey })).status).toBe(200);
    expect(await one("SELECT action, subject_id FROM audit WHERE action='connect.approve'")).toEqual({ action: 'connect.approve', subject_id: started.id });
  });

  it('supports refusal, existing agents, manager scoping, rate limits, and expired requests', async () => {
    const secret = randomToken();
    const started = await json(await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256: await sha256Hex(secret), client: 'codex', machine: 'box' },
    }));
    const fullKey = `lawh_${started.id}_${secret}`;

    // Refuse with "Not mine": client gets 403 and no key is created.
    const mgr = await member(4);
    expect((await api('POST', '/connect/answer', { cookie: mgr, body: { id: started.id, code: started.code, refuse: true } })).status).toBe(204);
    expect(await apiCode(await agent(`/v1/connect/${started.id}`, { token: fullKey }))).toEqual([403, 'forbidden']);
    expect(await one('SELECT id FROM agent_keys WHERE id=?', started.id)).toBeNull();

    // Manager cannot grant 'all' projects or an unmanaged project ('three').
    const secret2 = randomToken();
    const s2 = await json(await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256: await sha256Hex(secret2), client: 'codex', machine: 'box2' },
    }));
    expect(await code(await api('POST', '/connect/answer', {
      cookie: mgr,
      body: { id: s2.id, code: s2.code, agentName: 'mgr-bot', projects: 'all' },
    }))).toEqual([403, 'forbidden']);
    expect(await code(await api('POST', '/connect/answer', {
      cookie: mgr,
      body: { id: s2.id, code: s2.code, agentName: 'mgr-bot', projects: ['three'] },
    }))).toEqual([404, 'not_found']);

    // Connecting an existing agent adds a second key to it.
    expect((await api('POST', '/connect/answer', {
      cookie: mgr,
      body: { id: s2.id, code: s2.code, agentId: 'am', projects: ['one'] },
    })).status).toBe(200);
    expect((await agent(`/v1/connect/${s2.id}`, { token: `lawh_${s2.id}_${secret2}` })).status).toBe(200);

    // Expired request returns 404 and leaves no new agent behind.
    const secret3 = randomToken();
    const s3 = await json(await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256: await sha256Hex(secret3), client: 'gemini', machine: 'box3' },
    }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 601_000);
    expect(await apiCode(await agent(`/v1/connect/${s3.id}`, { token: `lawh_${s3.id}_${secret3}` }))).toEqual([404, 'not_found']);
    expect(await code(await api('POST', '/connect/answer', {
      cookie: mgr,
      body: { id: s3.id, code: s3.code, agentName: 'never-created', projects: ['one'] },
    }))).toEqual([404, 'not_found']);
    expect(await one("SELECT id FROM agents WHERE name='never-created'")).toBeNull();
    vi.useRealTimers();

    // Rate limits on start, poll, and code lookup.
    const full = { limit: async () => ({ success: false }) };
    expect(await apiCode(await agent('/v1/connect', { method: 'POST', json: { secretSha256: 'a'.repeat(64), client: 'x', machine: 'y' } }, { AUTH_LIMIT: full }))).toEqual([429, 'rate_limited']);
    expect(await apiCode(await agent(`/v1/connect/${s2.id}`, { token: `lawh_${s2.id}_${secret2}` }, { SIGNIN_LIMIT: full }))).toEqual([429, 'rate_limited']);
    expect(await code(await api('POST', '/connect/look', { cookie: mgr, body: { code: 'BBBB-CCCC' } }, { CODE_LIMIT: full }))).toEqual([429, 'rate_limited']);
  });

  it('serves /connect.md with the copy origin and /lawh.mjs only while instance is on', async () => {
    const mdRes = await exports.default.fetch(new Request('https://lawh.example.com/connect.md'));
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    const md = await mdRes.text();
    expect(md).toContain('http://localhost:8787/lawh.mjs');
    expect(md).toContain('http://localhost:8787/connect');
    expect(md).not.toContain('{{APP_URL}}');

    const cliRes = await exports.default.fetch(new Request('https://lawh.example.com/lawh.mjs'));
    expect(cliRes.status).toBe(200);
    expect(cliRes.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(await cliRes.text()).toContain('#!/usr/bin/env node');

    await sql("UPDATE settings SET value_json='false' WHERE key='instance'");
    expect((await exports.default.fetch(new Request('https://lawh.example.com/connect.md'))).status).toBe(404);
    expect((await exports.default.fetch(new Request('https://lawh.example.com/lawh.mjs'))).status).toBe(404);
  });

  it('returns 404 for malformed connect IDs and expired refused requests, enforces 5 wrong codes per 10 min across look/answer, enforces copy-wide start cap, and enforces 100-key cap atomically', async () => {
    // 1) Malformed connect ID returns 404 (not 401).
    expect(await apiCode(await agent('/v1/connect/not-a-valid-id'))).toEqual([404, 'not_found']);

    // 2) Refused request returns 403 while in date, then 404 once expired (before cleanup deletes it).
    const secret = randomToken();
    const refused = await json(await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256: await sha256Hex(secret), client: 'codex', machine: 'box' },
    }));
    const refusedKey = `lawh_${refused.id}_${secret}`;
    const { cookie: owner } = await enter('o');
    expect((await api('POST', '/connect/answer', { cookie: owner, body: { id: refused.id, code: refused.code, refuse: true } })).status).toBe(204);
    expect(await apiCode(await agent(`/v1/connect/${refused.id}`, { token: refusedKey }))).toEqual([403, 'forbidden']);

    vi.useFakeTimers({ toFake: ['Date'] });
    const future = Date.now() + 601_000;
    vi.setSystemTime(future);
    expect(await apiCode(await agent(`/v1/connect/${refused.id}`, { token: refusedKey }))).toEqual([404, 'not_found']);
    vi.useRealTimers();

    // 3) 5 wrong codes in 10 minutes across /connect/look and /connect/answer -> 6th attempt gets 429 even with a valid code.
    const validSecret = randomToken();
    const validReq = await json(await agent('/v1/connect', {
      method: 'POST',
      json: { secretSha256: await sha256Hex(validSecret), client: 'claude', machine: 'mac' },
    }));
    const unlimited = { limit: async () => ({ success: true }) };
    for (let i = 0; i < 3; i++) {
      expect(await code(await api('POST', '/connect/look', { cookie: owner, body: { code: 'BBBB-CCCC' } }, { CODE_LIMIT: unlimited }))).toEqual([404, 'not_found']);
    }
    for (let i = 0; i < 2; i++) {
      expect(await code(await api('POST', '/connect/answer', { cookie: owner, body: { id: validReq.id, code: 'BBBB-DDDD', refuse: true } }, { CODE_LIMIT: unlimited }))).toEqual([404, 'not_found']);
    }
    // 6th call (even with the valid code!) is blocked for 10 minutes.
    expect(await code(await api('POST', '/connect/look', { cookie: owner, body: { code: validReq.code } }, { CODE_LIMIT: unlimited }))).toEqual([429, 'rate_limited']);
    expect(await code(await api('POST', '/connect/answer', { cookie: owner, body: { id: validReq.id, code: validReq.code, refuse: true } }, { CODE_LIMIT: unlimited }))).toEqual([429, 'rate_limited']);

    // A fresh session is not blocked by the previous session's wrong guesses.
    const { cookie: owner2 } = await enter('o');
    expect((await api('POST', '/connect/look', { cookie: owner2, body: { code: validReq.code } }, { CODE_LIMIT: unlimited })).status).toBe(200);

    // 4) Copy-wide D1 start limit blocks requests across distinct IPs once bucket hits 60/min.
    const bucket = String(Math.floor(Date.now() / 60_000));
    await sql(
      `INSERT INTO idempotency(key_id, idem_key, request_sha256, status, response_json, expires_at)
       VALUES('rl:connect-start', '${bucket}', '', 60, '{}', ${Date.now() + 120_000})
       ON CONFLICT(key_id, idem_key) DO UPDATE SET status = 60`,
    );
    expect(await apiCode(await agent('/v1/connect', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '198.51.100.77' },
      json: { secretSha256: 'b'.repeat(64), client: 'claude', machine: 'other' },
    }))).toEqual([429, 'rate_limited']);

    // 5) Atomic 100-key cap: two concurrent approvals at 99 keys allow only 100 total keys.
    await sql("DELETE FROM idempotency WHERE key_id = 'rl:connect-start'");
    const liveCount = await count('agent_keys', 'revoked_at IS NULL AND expires_at > ' + Date.now() + " AND agent_id IN (SELECT id FROM agents WHERE member_id='o')");
    const farFuture = Date.now() + 86_400_000;
    for (let i = liveCount; i < 99; i++) {
      await sql(
        `INSERT INTO agent_keys(id, agent_id, secret_hmac, scopes_json, all_projects, created_at, expires_at)
         VALUES('key_CAP${String(i).padStart(23, '0')}', 'ao', '${'c'.repeat(64)}', '["pages:read"]', 1, 1, ${farFuture})`,
      );
    }
    const rA = await json(await agent('/v1/connect', { method: 'POST', json: { secretSha256: await sha256Hex(randomToken()), client: 'claude', machine: 'm1' } }));
    const rB = await json(await agent('/v1/connect', { method: 'POST', json: { secretSha256: await sha256Hex(randomToken()), client: 'codex', machine: 'm2' } }));
    const [resA, resB] = await Promise.all([
      api('POST', '/connect/answer', { cookie: owner2, body: { id: rA.id, code: rA.code, agentName: 'cap-a', projects: ['one'] } }, { CODE_LIMIT: unlimited }),
      api('POST', '/connect/answer', { cookie: owner2, body: { id: rB.id, code: rB.code, agentName: 'cap-b', projects: ['one'] } }, { CODE_LIMIT: unlimited }),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const finalCount = await count('agent_keys', 'revoked_at IS NULL AND expires_at > ' + Date.now() + " AND agent_id IN (SELECT id FROM agents WHERE member_id='o')");
    expect(finalCount).toBe(100);
  });
});
