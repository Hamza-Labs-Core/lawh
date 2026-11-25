import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanUpPeople } from '../../../src/app/people/cleanUp';
import { api, call, code, cookieOf, count, enter, json, one, seed, sql } from './helpers';

beforeEach(() => seed());
afterEach(() => { vi.useRealTimers(); });
const ask = async () => json(await api('POST', '/device', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Gecko/20100101 Firefox/150.0' } }));
const claim = (d: { id: string; secret: string }) => api('POST', '/device/claim', { body: { id: d.id, secret: d.secret } });

describe('signing in another device', () => {
  it('shows what it is, and signs it in as the person who approved, once', async () => {
    const { cookie } = await enter('m'), device = await ask();
    expect(device.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect((await claim(device)).status).toBe(202);
    expect(await json(await api('POST', '/device/look', { cookie, body: { code: device.code } }))).toEqual({ id: device.id, label: 'Firefox · macOS', createdAt: expect.any(Number) });
    expect((await claim(device)).status).toBe(202);
    expect((await api('POST', '/device/approve', { cookie, body: { id: device.id, code: ` ${device.code.toLowerCase().replace('-', ' - ')} ` } })).status).toBe(204);
    const response = await claim(device);
    expect(await json(await api('GET', '/me', { cookie: cookieOf(response) }))).toMatchObject({ id: 'm' });
    expect(await code(await claim(device))).toEqual([404, 'not_found']);
    expect(await count('sessions', "member_id='m'")).toBe(2);
    // The new session is its own: ending the approver's doesn't end it.
    await api('DELETE', '/sessions/current', { cookie });
    expect((await api('GET', '/me', { cookie: cookieOf(response) })).status).toBe(200);
  });

  it('signs in once when claimed twice at once', async () => {
    const { cookie } = await enter('o'), device = await ask();
    await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } });
    const results = await Promise.all([claim(device), claim(device)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
    expect(await count('sessions')).toBe(2);
  });

  it('needs the secret of the device, not only its code or id', async () => {
    const { cookie } = await enter('o'), device = await ask(), other = await ask();
    await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } });
    for (const body of [{ id: device.id, secret: other.secret }, { id: device.id, secret: '' }, { id: other.id, secret: device.secret }, { id: device.id }, { secret: device.secret }, { id: 'x', secret: device.secret }]) {
      expect(await code(await api('POST', '/device/claim', { body }))).toEqual([404, 'not_found']);
    }
    expect((await claim(device)).status).toBe(204);
  });

  it('refuses a wrong, used or old code, and one approved by someone else first', async () => {
    const { cookie } = await enter('o'), mona = await enter('m'), device = await ask();
    for (const bad of ['', 'x', 'BBBB-BBBB', 1, null, 'B'.repeat(50)]) {
      expect(await code(await api('POST', '/device/look', { cookie, body: { code: bad } }, { CODE_LIMIT: { limit: async () => ({ success: true }) } }))).toEqual([404, 'not_found']);
      expect(await code(await api('POST', '/device/approve', { cookie, body: { id: device.id, code: bad } }))).toEqual([404, 'not_found']);
      expect(await code(await api('POST', '/device/approve', { cookie, body: { id: bad, code: device.code } }))).toEqual([404, 'not_found']);
    }
    expect((await api('POST', '/device/approve', { cookie: mona.cookie, body: { id: device.id, code: device.code } })).status).toBe(204);
    expect(await code(await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } }))).toEqual([404, 'not_found']);
    const old = await ask();
    await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 301_000);
    expect(await count('device_approvals')).toBe(2);
    expect(await code(await api('POST', '/device/look', { cookie, body: { code: old.code } }))).toEqual([404, 'not_found']);
    expect(await code(await api('POST', '/device/approve', { cookie, body: { id: old.id, code: old.code } }))).toEqual([404, 'not_found']);
    expect(await code(await claim(old))).toEqual([404, 'not_found']);
  });

  it.each([["the approver's session ended", "DELETE FROM sessions WHERE member_id='m'"], ['the person was removed', "UPDATE members SET removed_at=1 WHERE id='m'"]])('gives no session when %s', async (_, change) => {
    const { cookie } = await enter('m'), device = await ask();
    await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } });
    await sql(change);
    expect(await code(await claim(device))).toEqual([404, 'not_found']);
    expect(await count('sessions')).toBe(0);
  });

  it('gives a member no session while teams is off', async () => {
    const { cookie } = await enter('m'), device = await ask();
    await api('POST', '/device/approve', { cookie, body: { id: device.id, code: device.code } });
    await sql("UPDATE settings SET value_json='false' WHERE key='teams'");
    expect(await code(await claim(device))).toEqual([404, 'feature_off']);
  });

  it('limits how many codes a session may try', async () => {
    const { cookie } = await enter('o');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await api('POST', '/device/look', { cookie, body: { code: 'BBBB-BBBB' } })).status);
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Approving is not a guess, so it still works.
    const mona = await enter('m'), device = await ask(), CODE_LIMIT = { limit: async () => ({ success: false }) };
    expect((await api('POST', '/device/approve', { cookie: mona.cookie, body: { id: device.id, code: device.code } }, { CODE_LIMIT })).status).toBe(204);
  });

  it('keeps neither the code nor the secret in the database', async () => {
    const device = await ask(), row = JSON.stringify(await one('SELECT * FROM device_approvals'));
    expect(row).not.toContain(device.secret);
    expect(row).not.toContain(device.code.replace('-', ''));
  });
});

describe('clean-up and pages', () => {
  it('removes what is over and keeps the rest', async () => {
    const { cookie } = await enter('o');
    await ask(); await api('POST', '/sign-in/options');
    await sql("INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at,team_id,level) VALUES('inv','invite','x','o',1,2,'t1',1)",
      "INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at) VALUES('old','reset','m','o',1,2)");
    await cleanUpPeople(env);
    expect([await count('auth_challenges'), await count('device_approvals'), await count('sessions')]).toEqual([1, 1, 1]);
    expect(await count('access_links', "token_sha256='inv'")).toBe(1);
    expect(await count('access_links', "token_sha256='old'")).toBe(0);
    await cleanUpPeople(env, Date.now() + 400_000);
    expect([await count('auth_challenges'), await count('device_approvals'), await count('sessions')]).toEqual([0, 0, 1]);
    expect((await api('GET', '/me', { cookie })).status).toBe(200);
  });

  it('serves the app document and its files with the app headers, and nothing else', async () => {
    const page = await call('GET', '/');
    expect([page.status, page.headers.get('Content-Type'), page.headers.get('Cache-Control')]).toEqual([200, 'text/html; charset=utf-8', 'no-store']);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    const html = await page.text(), files = [...html.matchAll(/"(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(files).toHaveLength(3);
    expect([...html.matchAll(/<script\b/gi)]).toHaveLength(2);
    expect([...html.matchAll(/<script (?:type="module" )?src="\/assets\//g)], 'every script is a file').toHaveLength(2);
    expect(html.toLowerCase()).not.toMatch(/<style|\sstyle=|\son[a-z]+=/);
    for (const file of files) {
      const response = await call('GET', file);
      expect([response.status, response.headers.get('Cache-Control'), response.headers.get('X-Content-Type-Options')], file).toEqual([200, 'public, max-age=31536000, immutable', 'nosniff']);
      expect(response.headers.get('Content-Type'), file).toMatch(file.endsWith('.css') ? /^text\/css/ : /javascript/);
    }
    for (const path of ['/index.html', '/assets/', '/assets/nope-12345678.js', '/nope', '/link/', '/../index.html', '/assets/../index.html']) expect((await call('GET', path)).status, path).toBe(404);
    for (const path of ['/', '/link']) expect((await call('POST', path)).status, path).toBe(404);
    expect(await (await call('HEAD', '/')).text()).toBe('');
  });
});
