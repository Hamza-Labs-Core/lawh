import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';

const PATHS = ['/', '/v1/projects', '/v1/pages', '/app-api/projects', '/connect', '/connect.md', '/p/a/b', '/nope'];
const call = (path: string, method = 'GET') =>
  exports.default.fetch(new Request(`https://lawh.example.com${path}`, { method, ...(method === 'POST' && { body: '{}' }) }));
const set = (value: string) =>
  env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('instance',?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").bind(value).run();

/** Every route of a Worker is closed until the `instance` switch is on. */
export function gateTests(requiredHeaders: Record<string, RegExp>) {
  describe('instance switch', () => {
    afterEach(async () => { await env.DB.prepare('DELETE FROM settings').run(); });

    it.each(PATHS)('is off by default: %s answers 404 feature_off', async (path) => {
      for (const method of ['GET', 'POST']) {
        const response = await call(path, method);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'feature_off' });
      }
    });

    it.each(['false', '"true"', '1', 'null', '{}', ' true'])('stays off for the value %s', async (value) => {
      await set(value);
      expect(await (await call('/')).json()).toMatchObject({ code: 'feature_off' });
    });

    it('turns on, and off again at once', async () => {
      await set('true');
      const on = await call('/nope');
      expect([on.status, await on.json()]).toEqual([404, expect.objectContaining({ code: 'not_found' })]);
      await set('false');
      expect(await (await call('/nope')).json()).toMatchObject({ code: 'feature_off' });
    });

    it('is not turned on by another switch', async () => {
      await env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('teams','true',1)").run();
      expect(await (await call('/')).json()).toMatchObject({ code: 'feature_off' });
    });

    it('fails closed, with no details, when the database fails', async () => {
      await env.DB.prepare('ALTER TABLE settings RENAME TO settings_away').run();
      try {
        const response = await call('/');
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ code: 'internal', message: 'Something went wrong.' });
      } finally {
        await env.DB.prepare('ALTER TABLE settings_away RENAME TO settings').run();
      }
    });

    it.each(['off', 'on', 'broken'])('sends the security headers when %s', async (state) => {
      if (state === 'on') await set('true');
      if (state === 'broken') await env.DB.prepare('ALTER TABLE settings RENAME TO settings_away').run();
      try {
        const { headers } = await call('/');
        for (const [name, value] of Object.entries(requiredHeaders)) expect(headers.get(name), name).toMatch(value);
        expect(headers.get('Cache-Control')).toBe('no-store');
        expect(headers.get('Set-Cookie')).toBeNull();
        expect(headers.get('Access-Control-Allow-Origin')).toBeNull();
      } finally {
        if (state === 'broken') await env.DB.prepare('ALTER TABLE settings_away RENAME TO settings').run();
      }
    });
  });
}
