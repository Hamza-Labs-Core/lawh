import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../../src/app/api/router';
import { SCOPES } from '../../../src/app/api/auth';
import { call, code, json, makeKey, one, publish, seed, sql } from './helpers';

beforeEach(seed);

describe('agent keys', () => {
  it('works, and says whose it is', async () => {
    const { token } = await makeKey({ agent: 'am', projects: ['p1'] });
    expect(await json(await call('/v1/me', { token }))).toEqual({
      agentId: 'am', name: 'mona-bot', scopes: [...SCOPES], allProjects: false, expiresAt: expect.any(Number),
      projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
    });
  });

  it('refuses a missing, malformed, unknown or wrong key', async () => {
    const { id, token } = await makeKey();
    const other = await makeKey();
    const bad = [undefined, '', 'x', token.slice(0, -1), `${token}x`, `${token.slice(0, -1)}t`, token.replace(id, other.id), token.toUpperCase(),
      `lawh_key_01AAAAAAAAAAAAAAAAAAAAAAAA_${'s'.repeat(43)}`];
    for (const t of bad) expect(await code(await call('/v1/me', t === undefined ? {} : { token: t })), t).toEqual([401, 'unauthorized']);
    expect(await code(await call('/v1/me', { headers: { Authorization: `Basic ${token}` } }))).toEqual([401, 'unauthorized']);
    expect(await code(await call('/v1/me', { headers: { Cookie: '__Host-lawh=x' } }))).toEqual([401, 'unauthorized']);
    expect((await call('/v1/me', { token })).status).toBe(200);
  });

  it.each([
    ['expired', "UPDATE agent_keys SET revoked_at=NULL", 1],
    ['revoked', 'UPDATE agent_keys SET revoked_at=1', undefined],
    ["its agent's being disabled", "UPDATE agents SET disabled_at=1 WHERE id='am'", undefined],
    ["its person's removal", "UPDATE members SET removed_at=1 WHERE id='m'", undefined],
    ['its agent moving to another person', "UPDATE agents SET member_id='o', name='x' WHERE id='am'", undefined],
  ])('stops working after %s', async (_, change, expiresAt) => {
    const { token } = await makeKey({ agent: 'am', projects: ['p1'], ...(expiresAt && { expiresAt }) });
    if (!expiresAt) expect((await call('/v1/me', { token })).status).toBe(200);
    await sql(change);
    expect(await code(await call('/v1/me', { token }))).toEqual([401, 'unauthorized']);
  });

  it("answers feature_off to other people's keys while teams is off, and keeps the owner's working", async () => {
    const mona = await makeKey({ agent: 'am', projects: ['p1'] }), owner = await makeKey();
    await sql("UPDATE settings SET value_json='false' WHERE key='teams'");
    expect(await code(await call('/v1/me', { token: mona.token }))).toEqual([404, 'feature_off']);
    expect((await call('/v1/me', { token: owner.token })).status).toBe(200);
  });

  it('answers feature_off to everyone while the instance is off', async () => {
    const { token } = await makeKey();
    await sql("UPDATE settings SET value_json='false' WHERE key='instance'");
    expect(await code(await call('/v1/me', { token }))).toEqual([404, 'feature_off']);
  });

  it('fails closed when the pepper is missing or too short', async () => {
    const { token } = await makeKey();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const PEPPER of ['', 'short']) expect(await code(await call('/v1/me', { token }, { PEPPER }))).toEqual([500, 'internal']);
    } finally { log.mockRestore(); }
    expect(await code(await call('/v1/me', { token }, { PEPPER: 'another-pepper-that-is-long-enough-here' }))).toEqual([401, 'unauthorized']);
    expect((await call('/v1/me', { token }, { PEPPER: { get: async () => env.PEPPER as string } })).status).toBe(200);
  });

  it('is rate limited for each key, and for failures from each address', async () => {
    const { token } = await makeKey(), full = { limit: async () => ({ success: false }) };
    expect(await code(await call('/v1/me', { token }, { KEY_LIMIT: full }))).toEqual([429, 'rate_limited']);
    expect(await code(await call('/v1/me', {}, { AUTH_LIMIT: full }))).toEqual([429, 'rate_limited']);
    expect((await call('/v1/me', { token }, { AUTH_LIMIT: full })).status).toBe(200);
  });

  it('records its last use at most once an hour', async () => {
    const { id, token } = await makeKey();
    const used = () => one<{ last_used_at: number }>('SELECT last_used_at FROM agent_keys WHERE id=?', id).then((r) => r!.last_used_at);
    expect(await used()).toBeNull();
    await call('/v1/me', { token });
    const first = await used();
    expect(first).toBeGreaterThan(0);
    await sql(`UPDATE agent_keys SET last_used_at=${first - 60_000}`);
    await call('/v1/me', { token });
    expect(await used()).toBe(first - 60_000);
    await sql(`UPDATE agent_keys SET last_used_at=${first - 3_700_000}`);
    await call('/v1/me', { token });
    expect(await used()).toBeGreaterThanOrEqual(first);
  });

  it('tells nothing about paths without a key, and 404 for unknown ones with it', async () => {
    const { token } = await makeKey();
    expect(await code(await call('/v1/nope'))).toEqual([401, 'unauthorized']);
    for (const path of ['/v1/nope', '/v1/', '/v1/me/', '/v1/projects/one/pages/UPPER', '/v1/projects/one/pages/a%2Fb']) {
      expect(await code(await call(path, { token })), path).toEqual([404, 'not_found']);
    }
    expect(await code(await call('/v1/me', { token, method: 'POST', json: {} }))).toEqual([404, 'not_found']);
  });
});

describe('every route and every kind of key', () => {
  // A route that is added must be listed here, with a request that works.
  const PATHS: Record<string, (ids: { upload: string; hash: string }) => string> = {
    'GET ^/v1/me$': () => '/v1/me',
    'GET ^/v1/projects$': () => '/v1/projects',
    'GET ^/v1/pages$': () => '/v1/pages?project=one',
    'GET page': () => '/v1/projects/one/pages/page',
    'PATCH page': () => '/v1/projects/one/pages/page',
    'GET versions': () => '/v1/projects/one/pages/page/versions',
    'POST versions': () => '/v1/projects/one/pages/page/versions',
    'GET version': () => '/v1/projects/one/pages/page/versions/1',
    'GET file': () => '/v1/projects/one/pages/page/versions/1/file?path=index.html',
    'PUT blob': ({ upload, hash }) => `/v1/uploads/${upload}/blobs/${hash}`,
    'POST commit': ({ upload }) => `/v1/uploads/${upload}/commit`,
  };
  const paths = () => Object.entries(PATHS).map(([name, make]) => [name.split(' ')[0]!, make({ upload: 'upl_01AAAAAAAAAAAAAAAAAAAAAAAA', hash: 'a'.repeat(64) })] as const);

  it('lists every route', () => {
    const matched = new Set(paths().map(([method, path]) => routes.findIndex((r) => r.method === method && r.path.test(path.split('?')[0]!))));
    expect([...matched].sort((a, b) => a - b)).toEqual(routes.map((_, i) => i));
  });

  it('needs the scope of the route, and no other', async () => {
    const tokens = new Map<string, string>();
    for (const scope of SCOPES) tokens.set(scope, (await makeKey({ scopes: [scope] })).token);
    for (const [method, path] of paths()) {
      const { scope } = routes.find((r) => r.method === method && r.path.test(path.split('?')[0]!))!;
      for (const [have, token] of tokens) {
        const { status } = await call(path, { method, token, ...(method !== 'GET' && { json: {}, idem: 'x' }) });
        if (scope === 'any' || scope === have) expect(status, `${method} ${path} with ${have}`).not.toBe(403);
        else expect(status, `${method} ${path} with ${have}`).toBe(403);
      }
    }
  });

  it('answers 404 on a project the key cannot use, on every route with a project', async () => {
    await publish((await makeKey()).token, { 'index.html': 'x' });
    const keys = {
      'owner, another project': await makeKey({ projects: ['p2'] }),
      'owner, no project': await makeKey({ projects: [] }),
      'manager, another project': await makeKey({ agent: 'am', projects: ['p2'] }),
      'manager who lost the level': await makeKey({ agent: 'am', projects: ['p1'] }),
    };
    await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'");
    for (const [name, { token }] of Object.entries(keys)) {
      for (const [method, path] of paths().filter(([, p]) => p.includes('/one') || p.includes('project='))) {
        const answer = await code(await call(path, { method, token, ...(method !== 'GET' && { json: { title: 'x' }, idem: 'x' }) }));
        expect(answer, `${name}: ${method} ${path}`).toEqual([404, 'not_found']);
      }
      expect((await json(await call('/v1/pages', { token }))).items, name).toEqual([]);
      expect((await json(await call('/v1/me', { token }))).projects.map((p: { slug: string }) => p.slug), name).not.toContain('one');
    }
  });

  it("lets a manager's key work where it is listed and they manage, at once again when they do", async () => {
    await publish((await makeKey()).token, { 'index.html': 'x' });
    const { token } = await makeKey({ agent: 'am', projects: ['p1'] });
    expect((await call('/v1/projects/one/pages/page', { token })).status).toBe(200);
    await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'");
    expect((await call('/v1/projects/one/pages/page', { token })).status).toBe(404);
    await sql("UPDATE team_members SET level=4, set_by='o' WHERE member_id='m'");
    expect((await call('/v1/projects/one/pages/page', { token })).status).toBe(200);
  });
});
