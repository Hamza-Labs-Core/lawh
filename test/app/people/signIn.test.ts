import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { b64, Authenticator } from './authenticator';
import { api, call, code, cookieOf, count, enter, json, makeLink, one, register, seed, signIn, sql } from './helpers';

beforeEach(() => seed());
const NOT = [401, 'unauthorized'];

describe('setup and recovery links', () => {
  it('registers the owner once, and signs them in', async () => {
    const token = await makeLink('owner', 'o'), authenticator = await Authenticator.make();
    const offered = await json(await api('POST', '/link/options', { body: { token } }));
    expect(offered.link).toEqual({ kind: 'owner', name: 'Sara', team: null, level: null, inviter: null });
    expect(offered.options).toMatchObject({ rp: { id: 'localhost' }, attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    const response = await register(token, authenticator);
    expect(response.status).toBe(204);
    expect(response.headers.get('Set-Cookie')).toMatch(/^lawh-local=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
    expect(await json(await api('GET', '/me', { cookie: cookieOf(response) }))).toEqual({ id: 'o', name: 'Sara', isOwner: true, instance: true });
    expect(await code(await register(token, await Authenticator.make()))).toEqual([404, 'not_found']);
    expect(await count('passkeys')).toBe(1);
    expect(await one("SELECT actor_id, subject_id FROM audit WHERE action='link.owner'")).toEqual({ actor_id: 'o', subject_id: 'o' });
  });

  it('sets a __Host- cookie on https', async () => {
    const token = await makeLink('owner', 'o'), authenticator = await Authenticator.make(), bindings = { APP_ORIGIN: 'https://lawh.example.com' };
    const headers = { Origin: 'https://lawh.example.com' };
    const { challengeId, options } = await json(await api('POST', '/link/options', { body: { token }, headers }, bindings));
    const response = await api('POST', '/link', { body: { token, challengeId, response: await authenticator.register(options.challenge, { origin: 'https://lawh.example.com', rpId: 'lawh.example.com' }) }, headers }, bindings);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-lawh=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=7776000; Secure$/);
    expect((await api('GET', '/me', { cookie: cookieOf(response) }, bindings)).status).toBe(200);
    expect((await api('GET', '/me', { cookie: cookieOf(response)!.replace('__Host-lawh', 'lawh-local') }, bindings)).status).toBe(401);
  });

  it.each(['used twice at once', 'expired', 'removed', 'replaced'])('refuses a link that is %s', async (how) => {
    const token = await makeLink(how === 'removed' ? 'reset' : 'owner', how === 'removed' ? 'm' : 'o');
    const a = await Authenticator.make(), b = await Authenticator.make();
    if (how === 'used twice at once') {
      const results = await Promise.all([register(token, a), register(token, b)]);
      expect(results.filter((r) => r.status === 204)).toHaveLength(1);
      expect(await count('passkeys')).toBe(1);
      expect(await count('sessions')).toBe(1);
      return;
    }
    const { challengeId, options } = await json(await api('POST', '/link/options', { body: { token } }));
    if (how === 'expired') await sql('UPDATE access_links SET expires_at=1').catch(() => sql('DELETE FROM access_links'));
    if (how === 'removed') await sql("UPDATE members SET removed_at=1 WHERE id='m'");
    if (how === 'replaced') await makeLink('owner', 'o');
    expect(await code(await api('POST', '/link', { body: { token, challengeId, response: await a.register(options.challenge) } }))).toEqual([404, 'not_found']);
    expect(await count('passkeys')).toBe(0);
  });

  it('refuses a link that is over, or no link at all', async () => {
    const over = await makeLink('owner', 'o', -1);
    for (const token of [over, '', 'x', 'a'.repeat(43), 1, null, undefined]) expect(await code(await api('POST', '/link/options', { body: { token } })), String(token)).toEqual([404, 'not_found']);
  });

  it('recovery removes every other passkey and session, and ends what was under way', async () => {
    const old = await enter('o');
    const pending = await json(await api('POST', '/passkeys/options', { cookie: old.cookie }));
    const fresh = await enter('o');
    expect(await code(await api('GET', '/me', { cookie: old.cookie }))).toEqual(NOT);
    expect(await code(await signIn(old.authenticator))).toEqual(NOT);
    expect((await api('POST', '/passkeys', { cookie: old.cookie, body: { challengeId: pending.challengeId, response: await (await Authenticator.make()).register(pending.options.challenge) } })).status).toBe(401);
    expect((await api('GET', '/me', { cookie: fresh.cookie })).status).toBe(200);
    expect(await count('passkeys')).toBe(1);
  });

  it('shows an invite with its team, level and inviter, and puts the person in the team only on joining', async () => {
    const token = await makeLink('invite', 'x');
    expect((await json(await api('POST', '/link/options', { body: { token } }))).link).toEqual({ kind: 'invite', name: 'Lina', team: 'Design', level: 2, inviter: 'Sara' });
    expect(await count('team_members')).toBe(0);
    expect((await register(token, await Authenticator.make())).status).toBe(204);
    expect(await one("SELECT team_id, level FROM team_members WHERE member_id='x'")).toEqual({ team_id: 't1', level: 2 });
  });

  it.each([['another site', { origin: 'https://evil.example.com' }], ['another host', { rpId: 'evil.example.com' }], ['another challenge', { challenge: b64(new Uint8Array(32)) }],
    ['no check of the person', { flags: 0x41 }], ['no presence', { flags: 0x44 }], ['an assertion', { type: 'webauthn.get' }]])('refuses a registration with %s, and keeps the link', async (_, change) => {
    const token = await makeLink('owner', 'o');
    expect(await code(await register(token, await Authenticator.make(), change))).toEqual(NOT);
    expect(await count('passkeys')).toBe(0);
    expect((await register(token, await Authenticator.make())).status).toBe(204);
  });

  it("uses a challenge once, for its own person and purpose", async () => {
    const token = await makeLink('owner', 'o'), authenticator = await Authenticator.make();
    const { challengeId, options } = await json(await api('POST', '/link/options', { body: { token } }));
    const other = await makeLink('reset', 'm');
    expect(await code(await api('POST', '/link', { body: { token: other, challengeId, response: await authenticator.register(options.challenge) } }))).toEqual(NOT);
    const sign = await json(await api('POST', '/sign-in/options'));
    expect(await code(await api('POST', '/link', { body: { token, challengeId: sign.challengeId, response: await authenticator.register(sign.options.challenge) } }))).toEqual(NOT);
    expect((await api('POST', '/link', { body: { token, challengeId, response: await authenticator.register(options.challenge) } })).status).toBe(204);
    await sql('UPDATE auth_challenges SET expires_at=1');
    expect(await code(await api('POST', '/link', { body: { token: other, challengeId, response: await authenticator.register(options.challenge) } }))).toEqual(NOT);
  });

  it('refuses a passkey that someone already has', async () => {
    const { authenticator } = await enter('o');
    expect(await code(await register(await makeLink('reset', 'm'), authenticator))).toEqual([404, 'not_found']);
  });
});

describe('signing in', () => {
  it('works with the passkey, and offers no list of passkeys to a stranger', async () => {
    const { authenticator } = await enter('o');
    const options = (await json(await api('POST', '/sign-in/options'))).options;
    expect([options.rpId, options.userVerification, options.allowCredentials]).toEqual(['localhost', 'required', undefined]);
    const response = await signIn(authenticator);
    expect(response.status).toBe(204);
    expect((await api('GET', '/me', { cookie: cookieOf(response) })).status).toBe(200);
    expect(await one('SELECT sign_count FROM passkeys')).toEqual({ sign_count: 1 });
    expect(await count('sessions')).toBe(2);
  });

  it.each([['another site', { origin: 'https://evil.example.com' }], ['another host', { rpId: 'evil.example.com' }], ['another challenge', { challenge: b64(new Uint8Array(32)) }],
    ['no check of the person', { flags: 0x01 }], ['no presence', { flags: 0x04 }], ['a registration', { type: 'webauthn.create' }]])('refuses %s', async (_, change) => {
    const { authenticator } = await enter('o');
    expect(await code(await signIn(authenticator, change))).toEqual(NOT);
    expect(await count('sessions')).toBe(1);
  });

  it('refuses a replay, a copied passkey, an unknown one and a wrong signature', async () => {
    const { authenticator } = await enter('o');
    const { challengeId, options } = await json(await api('POST', '/sign-in/options')), response = await authenticator.sign(options.challenge);
    expect((await api('POST', '/sign-in', { body: { challengeId, response } })).status).toBe(204);
    expect(await code(await api('POST', '/sign-in', { body: { challengeId, response } }))).toEqual(NOT);
    authenticator.counter = 0;
    expect(await code(await signIn(authenticator)), 'a counter that went back').toEqual(NOT);
    expect(await code(await signIn(await Authenticator.make()))).toEqual(NOT);
    const other = await Authenticator.make();
    const again = await json(await api('POST', '/sign-in/options')), forged = { ...(await other.sign(again.options.challenge)), id: authenticator.credentialId, rawId: authenticator.credentialId };
    expect(await code(await api('POST', '/sign-in', { body: { challengeId: again.challengeId, response: forged } }))).toEqual(NOT);
  });

  it.each([{}, { challengeId: 'x' }, { challengeId: 1, response: {} }, { response: {} }])('refuses %j', async (body) => {
    expect([401, 422]).toContain((await api('POST', '/sign-in', { body })).status);
  });

  it('refuses a removed person', async () => {
    const { authenticator, cookie } = await enter('m');
    await sql("UPDATE members SET removed_at=1 WHERE id='m'");
    expect(await code(await signIn(authenticator))).toEqual(NOT);
    expect(await code(await api('GET', '/me', { cookie }))).toEqual(NOT);
  });
});

describe('switches', () => {
  it.each([[true, false], [false, true], [false, false]])('keeps everyone but the owner out with instance %s and teams %s', async (instance, teams) => {
    const owner = await enter('o'), mona = await enter('m'), invite = await makeLink('invite', 'x'), reset = await makeLink('reset', 'm');
    await sql(`UPDATE settings SET value_json='${instance}' WHERE key='instance'`, `UPDATE settings SET value_json='${teams}' WHERE key='teams'`);
    const off = [404, 'feature_off'];
    expect(await code(await api('GET', '/me', { cookie: mona.cookie }))).toEqual(off);
    expect(await code(await signIn(mona.authenticator))).toEqual(off);
    for (const token of [invite, reset]) expect(await code(await api('POST', '/link/options', { body: { token } }))).toEqual(off);
    expect((await signIn(owner.authenticator)).status).toBe(204);
    expect((await api('GET', '/me', { cookie: owner.cookie })).status).toBe(200);
  });

  it('the owner can set up, sign in and turn the instance on while it is off; nothing else answers', async () => {
    await sql("UPDATE settings SET value_json='false' WHERE key='instance'");
    const { cookie } = await enter('o'), off = [404, 'feature_off'];
    expect(await json(await api('GET', '/me', { cookie }))).toMatchObject({ instance: false });
    for (const [method, path] of [['GET', '/sessions'], ['GET', '/passkeys'], ['POST', '/passkeys/options'], ['POST', '/device'], ['POST', '/device/claim'], ['POST', '/device/approve'], ['GET', '/nope']] as const) {
      expect(await code(await api(method, path, { cookie })), path).toEqual(off);
    }
    for (const path of ['/device', '/approve', '/p/a/b', '/v1/me']) expect(await code(await call('GET', path, { cookie })), path).toEqual(off);
    for (const path of ['/', '/link']) expect((await call('GET', path)).status, path).toBe(200);
    expect((await api('PUT', '/switches/instance', { cookie, body: { on: true } })).status).toBe(204);
    expect((await api('GET', '/sessions', { cookie })).status).toBe(200);
    expect((await api('PUT', '/switches/instance', { cookie, body: { on: false } })).status).toBe(204);
    expect(await code(await api('GET', '/sessions', { cookie }))).toEqual(off);
    expect(await count('audit', "action LIKE 'instance.%' AND actor_id='o'")).toBe(2);
  });

  it('only the owner turns the instance on or off', async () => {
    const { cookie } = await enter('m');
    expect(await code(await api('PUT', '/switches/instance', { cookie, body: { on: false } }))).toEqual([403, 'forbidden']);
    const owner = await enter('o');
    for (const on of ['true', 1, null, undefined]) expect(await code(await api('PUT', '/switches/instance', { cookie: owner.cookie, body: { on } }))).toEqual([422, 'invalid']);
    expect(await one("SELECT value_json v FROM settings WHERE key='instance'")).toEqual({ v: 'true' });
  });
});

describe('sessions', () => {
  it('lists a person’s own, and ends one or the current one', async () => {
    const { authenticator, cookie } = await enter('o'), mona = await enter('m');
    const second = cookieOf(await signIn(authenticator))!;
    const items = (await json(await api('GET', '/sessions', { cookie }))).items;
    expect(items).toHaveLength(2);
    const other = items.find((s: { current: boolean }) => !s.current);
    expect(await code(await api('DELETE', `/sessions/${other.id}`, { cookie: mona.cookie }))).toEqual([404, 'not_found']);
    expect((await api('DELETE', `/sessions/${other.id}`, { cookie })).headers.get('Set-Cookie')).toBeNull();
    expect(await code(await api('GET', '/me', { cookie: second }))).toEqual(NOT);
    const out = await api('DELETE', '/sessions/current', { cookie });
    expect(out.headers.get('Set-Cookie')).toMatch(/^lawh-local=; .*Max-Age=0$/);
    expect(await code(await api('GET', '/me', { cookie }))).toEqual(NOT);
  });

  it('lasts 30 days from its last use and 90 at most, and is kept alive at most once an hour', async () => {
    const { cookie } = await enter('o'), DAY = 86_400_000, now = Date.now();
    const row = () => one<{ last_seen_at: number; expires_at: number }>('SELECT last_seen_at, expires_at FROM sessions');
    const first = (await row())!;
    expect(first.expires_at - first.last_seen_at).toBe(30 * DAY);
    await api('GET', '/me', { cookie });
    expect(await row()).toEqual(first);
    await sql(`UPDATE sessions SET last_seen_at=${now - 2 * DAY}, expires_at=${now + 28 * DAY}`);
    await api('GET', '/me', { cookie });
    expect((await row())!.expires_at).toBeGreaterThan(now + 29 * DAY);
    await sql(`UPDATE sessions SET created_at=${now - 80 * DAY}, last_seen_at=${now - 2 * DAY}`);
    await api('GET', '/me', { cookie });
    expect((await row())!.expires_at).toBe(now - 80 * DAY + 90 * DAY);
    await sql('UPDATE sessions SET expires_at=1');
    expect(await code(await api('GET', '/me', { cookie }))).toEqual(NOT);
  });

  it('takes only its own cookie', async () => {
    const { cookie } = await enter('o'), value = cookie.split('=')[1]!;
    for (const bad of [`other=${value}`, 'lawh-local=', `lawh-local=${value}x`, `lawh-local=${value.slice(1)}`, `xlawh-local=${value}`]) expect(await code(await api('GET', '/me', { cookie: bad })), bad).toEqual(NOT);
    expect((await api('GET', '/me', { cookie: `a=b; ${cookie}; c=d` })).status).toBe(200);
    expect(await code(await api('GET', '/me', { headers: { Authorization: 'Bearer x' } }))).toEqual(NOT);
    expect(await count('sessions', `token_sha256='${value}'`)).toBe(0);
  });

  it('refuses writes from anywhere else', async () => {
    const { cookie } = await enter('o');
    for (const headers of [{ Origin: 'https://evil.example.com' }, { Origin: 'null' }, { Origin: 'http://127.0.0.1:8787' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'none' }]) {
      for (const [method, path] of [['PUT', '/switches/instance'], ['DELETE', '/sessions/current'], ['POST', '/sign-in/options'], ['POST', '/link'], ['POST', '/device/approve']] as const) {
        expect(await code(await api(method, path, { cookie, headers, body: { on: false } })), JSON.stringify(headers)).toEqual([403, 'forbidden']);
      }
    }
    expect((await api('GET', '/me', { cookie })).status).toBe(200);
  });

  it('is rate limited before sign-in', async () => {
    const full = { limit: async () => ({ success: false }) };
    for (const path of ['/sign-in/options', '/sign-in', '/link/options', '/link', '/device', '/device/claim']) expect(await code(await api('POST', path, {}, { SIGNIN_LIMIT: full })), path).toEqual([429, 'rate_limited']);
  });

  it('needs a session on every route that is not for anyone', async () => {
    const { peopleRoutes } = await import('../../../src/app/people/router');
    const open = ['/sign-in/options', '/sign-in', '/link/options', '/link', '/device', '/device/claim'];
    expect(peopleRoutes.filter((r) => r.who === 'anyone').map((r) => open.find((path) => r.path.test(`/app-api${path}`)))).toEqual(open);
    for (const [method, path] of [['GET', '/me'], ['DELETE', '/sessions/current'], ['PUT', '/switches/instance'], ['GET', '/sessions'], ['GET', '/passkeys'], ['POST', '/passkeys/options'], ['POST', '/passkeys'],
      ['DELETE', `/passkeys/${'a'.repeat(20)}`], ['POST', '/device/look'], ['POST', '/device/approve'], ['GET', '/nope']] as const) expect(await code(await api(method, path)), path).toEqual(NOT);
  });
});

describe('passkeys', () => {
  it('adds one, signs in with it, and removes one but never the last', async () => {
    const { authenticator, cookie } = await enter('o'), second = await Authenticator.make();
    const { challengeId, options } = await json(await api('POST', '/passkeys/options', { cookie }));
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([authenticator.credentialId]);
    expect((await api('POST', '/passkeys', { cookie, body: { challengeId, response: await second.register(options.challenge) } })).status).toBe(204);
    const session = cookieOf(await signIn(second))!;
    expect((await json(await api('GET', '/passkeys', { cookie }))).items).toHaveLength(2);
    expect((await api('DELETE', `/passkeys/${second.credentialId}`, { cookie })).status).toBe(204);
    expect(await code(await api('GET', '/me', { cookie: session })), 'its sessions end').toEqual(NOT);
    expect(await code(await api('DELETE', `/passkeys/${authenticator.credentialId}`, { cookie }))).toEqual([409, 'conflict']);
    expect(await count('passkeys')).toBe(1);
  });

  it("keeps one of two removed at once, and leaves other people's alone", async () => {
    const { authenticator, cookie } = await enter('o'), second = await Authenticator.make(), mona = await enter('m');
    const { challengeId, options } = await json(await api('POST', '/passkeys/options', { cookie }));
    await api('POST', '/passkeys', { cookie, body: { challengeId, response: await second.register(options.challenge) } });
    expect((await api('DELETE', `/passkeys/${second.credentialId}`, { cookie: mona.cookie })).status).toBe(409);
    await Promise.all([authenticator, second].map((a) => api('DELETE', `/passkeys/${a.credentialId}`, { cookie })));
    expect(await count('passkeys', "member_id='o'")).toBe(1);
  });

  it('adds none when the session ends meanwhile', async () => {
    const { cookie } = await enter('o');
    const { challengeId, options } = await json(await api('POST', '/passkeys/options', { cookie })), response = await (await Authenticator.make()).register(options.challenge);
    const DB = new Proxy(env.DB, { get(target, name) {
      if (name === 'batch') return async (statements: D1PreparedStatement[]) => { await sql('DELETE FROM sessions'); return target.batch(statements); };
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await code(await api('POST', '/passkeys', { cookie, body: { challengeId, response } }, { DB }))).toEqual(NOT);
    expect(await count('passkeys')).toBe(1);
  });
});
