import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const PATHS = ['/v1/projects', '/v1/pages', '/app-api/projects', '/connect', '/connect.md', '/p/a/b', '/nope'];
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://lawh.example.com${path}`, init));
const set = (value: string) =>
  env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('instance',?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").bind(value).run();
const breakDatabase = () => env.DB.prepare('ALTER TABLE settings RENAME TO settings_away').run();
const result = async (response: Response) => [response.status, (await response.json<{ code: string }>()).code];
const OFF = [404, 'feature_off'];

/** Every route of a Worker is closed until the `instance` switch is on. */
export function gateTests(requiredHeaders: Record<string, RegExp>, allowOrigin: string | null = null) {
  describe('instance switch', () => {
    it.each(PATHS)('is off by default: %s answers 404 feature_off', async (path) => {
      expect(await result(await call(path))).toEqual(OFF);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(await result(await call(path, { method, body: '{}' })), method).toEqual(OFF);
      expect(await result(await call(path, { method: 'OPTIONS', headers: { Origin: 'https://other.example.com' } }))).toEqual(OFF);
      expect((await call(path, { method: 'HEAD' })).status).toBe(404);
      const upgrade = await call(path, { headers: { Upgrade: 'websocket' } });
      expect(upgrade.webSocket).toBeNull();
      expect(await result(upgrade)).toEqual(OFF);
    });

    it.each(['false', '"true"', '1', 'null', '{}', ' true'])('stays off for the value %s', async (value) => {
      await set(value);
      expect(await result(await call('/nope'))).toEqual(OFF);
    });

    it('turns on, and off again at once', async () => {
      await set('true');
      expect(await result(await call('/nope'))).toEqual([404, 'not_found']);
      await set('false');
      expect(await result(await call('/nope'))).toEqual(OFF);
    });

    it('is not turned on by another switch', async () => {
      await env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('teams','true',1)").run();
      expect(await result(await call('/nope'))).toEqual(OFF);
    });

    it('fails closed, with no details, when the database fails', async () => {
      await breakDatabase();
      const response = await call('/nope');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: 'internal', message: 'Something went wrong.' });
    });

    it.each([['off', OFF], ['on', [404, 'not_found']], ['broken', [500, 'internal']]] as const)('sends the security headers when %s', async (state, expected) => {
      if (state === 'on') await set('true');
      if (state === 'broken') await breakDatabase();
      const response = await call('/nope');
      expect(await result(response)).toEqual(expected);
      for (const [name, value] of Object.entries(requiredHeaders)) expect(response.headers.get(name), name).toMatch(value);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(allowOrigin);
    });
  });
}
