import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { PURGE_AFTER, prune, pruneVersions, purge, sweep } from '../../../src/app/housekeeping';
import { cleanUp } from '../../../src/app/api/publish';
import { call as agent, json, makeKey, manifest, publish, seed as seedAgents, sha, start } from '../api/helpers';
import { api, code, count, enter, one, sql } from './helpers';

const DAY = 86_400_000;
let token: string, pageId: string;
const ASK = { key: 'x', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
/** One owner, Mona who manages t1 (p1, p2), Dina who decides there. Page `page` in p1, searchable as "needle". */
beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
  ({ token } = await makeKey());
  pageId = (await json(await publish(token, { 'index.html': '<p>needle</p>', 'a.css': 'shared' }, { page: { title: 'T', tags: ['t'], status: 'in_review' }, decisions: [ASK] }))).id;
});
const member = async (level: number) => { const { cookie } = await enter('m'); await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',${level},'o',1)`); return cookie; };
const setLevel = (level: number) => sql(`UPDATE team_members SET level=${level}, set_by='o' WHERE member_id='m'`);
const PAGE = '/projects/one/pages/page';
const status = (cookie: string, value: unknown = 'archived') => api('PUT', `${PAGE}/status`, { cookie, body: { status: value } });
const remove = (cookie: string) => api('DELETE', PAGE, { cookie });
const restore = (cookie: string, id = pageId) => api('POST', `/deleted/${id}/restore`, { cookie });
const deleted = async (cookie: string, query = '') => (await json(await api('GET', `/deleted${query}`, { cookie }))).items as { id: string; slug: string; purgedAfter: number }[];
const found = async (query = '') => (await json(await agent(`/v1/pages?q=needle${query}`, { token }))).items.length;
const objects = async () => (await env.FILES.list()).objects.length;
const version = (n: number, body: string) => publish(token, { 'index.html': body, 'a.css': 'shared' }, { baseVersion: n - 1, page: {} });

describe('a page’s status', () => {
  it('any of the four, told once, and in the search', async () => {
    const { cookie } = await enter('o');
    for (const value of ['decided', 'draft', 'archived', 'in_review']) {
      expect(await (await status(cookie, value)).json()).toEqual({ status: value });
      expect([await found(`&status=${value}`), await found()]).toEqual([1, 1]);
    }
    await status(cookie, 'in_review');
    expect((await env.DB.prepare("SELECT actor_type, actor_id, subject_id FROM events WHERE type='page.status'").all()).results).toEqual(Array(4).fill({ actor_type: 'person', actor_id: 'o', subject_id: pageId }));
    for (const value of ['gone', null, 5]) expect(await code(await status(cookie, value))).toEqual([422, 'invalid']);
  });
});

describe('deleting and restoring', () => {
  it('a deleted page is nowhere, its address is kept, and restoring brings everything back', async () => {
    const { cookie } = await enter('o');
    expect((await remove(cookie)).status).toBe(204);
    expect([await found(), await count('pages_fts'), await count('pages_fts_map'), (await json(await api('GET', '/pages', { cookie }))).items.length]).toEqual([0, 0, 0, 0]);
    for (const path of [PAGE, `${PAGE}/versions`, `${PAGE}/decisions`, `${PAGE}/comments`]) expect((await api('GET', path, { cookie })).status, path).toBe(404);
    expect((await agent('/v1/projects/one/pages/page', { token })).status).toBe(404);
    expect((await remove(cookie)).status).toBe(404);
    expect(await code(await start(token, await manifest({ 'index.html': 'x' })))).toEqual([409, 'conflict']);
    expect((await deleted(cookie))[0]).toMatchObject({ id: pageId, slug: 'page' });
    const back = await restore(cookie);
    expect([back.status, await back.json()]).toEqual([200, { project: 'one', slug: 'page' }]);
    expect([await found(), await found('&status=in_review&tag=t&project=one'), (await deleted(cookie)).length, (await api('GET', PAGE, { cookie })).status]).toEqual([1, 1, 0, 200]);
    expect((await json(await api('GET', `${PAGE}/decisions`, { cookie }))).items).toHaveLength(1);
    expect(await code(await restore(cookie))).toEqual([404, 'not_found']);
    expect((await env.DB.prepare("SELECT action FROM audit WHERE action LIKE 'page.%' ORDER BY seq").all()).results).toEqual([{ action: 'page.delete' }, { action: 'page.restore' }]);
  });

  it('two restores at once: one works', async () => {
    const { cookie } = await enter('o');
    await remove(cookie);
    expect((await Promise.all([restore(cookie), restore(cookie)])).map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect([await count('pages_fts'), await count('pages_fts_map'), await found()]).toEqual([1, 1, 1]);
  });

  it('managers and the owner, and nobody else', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(1);
    for (const level of [1, 2, 3]) {
      await setLevel(level);
      for (const response of [await status(cookie), await remove(cookie)]) expect(await code(response)).toEqual([403, 'forbidden']);
    }
    await remove(owner);
    expect(await code(await restore(cookie))).toEqual([403, 'forbidden']);
    expect(await deleted(cookie)).toEqual([]);
    await setLevel(4);
    expect((await deleted(cookie)).map((p) => p.slug)).toEqual(['page']);
    expect((await restore(cookie)).status).toBe(200);
    expect((await status(cookie)).status).toBe(200);
    expect((await remove(cookie)).status).toBe(204);
    await sql("DELETE FROM team_members WHERE member_id='m'");
    expect(await deleted(cookie)).toEqual([]);
    for (const response of [await restore(cookie), await status(cookie), await remove(cookie)]) expect(await code(response)).toEqual([404, 'not_found']);
    expect(await code(await restore(owner, `pag_${'0'.repeat(26)}`))).toEqual([404, 'not_found']);
  });

  it('the list is newest first, each once, for the owner and a manager, and ends after 30 days', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(4), now = Date.now();
    await env.DB.batch(['p1', 'p2', 'p3'].flatMap((project, i) => [1, 2, 3].map((n) => env.DB.prepare("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at,deleted_at) VALUES(?,?,?,'T','ao',1,1,?)").bind(`pag_${i}${n}`, project, `s${n}`, now - n * DAY))));
    await sql(`UPDATE pages SET deleted_at=${now - 31 * DAY} WHERE id='pag_03'`);
    for (const [who, expected] of [[owner, 8], [cookie, 5]] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do { const body: { items: { id: string }[]; next: string | null } = await json(await api('GET', `/deleted?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { cookie: who })); seen.push(...body.items.map((p) => p.id)); cursor = body.next; } while (cursor);
      expect([seen.length, new Set(seen).size]).toEqual([expected, expected]);
      expect(seen.map((id) => id.at(-1))).toEqual([...seen.map((id) => id.at(-1))].sort());
    }
    expect((await restore(owner, `pag_${'0'.repeat(26)}`)).status).toBe(404);
  });
});

describe('the purge', () => {
  it('removes everything of a page after 30 days, and its files that nothing else uses', async () => {
    const { cookie } = await enter('o');
    const item = (await json(await api('GET', `${PAGE}/decisions`, { cookie }))).items[0];
    await api('POST', `/decisions/${item.id}/answers`, { cookie, body: { revision: 1, seq: 0, optionId: 'a' } });
    await api('POST', `${PAGE}/comments`, { cookie, body: { id: `cmt_${'A'.repeat(26)}`, body: 'x', versionN: 1 } });
    await publish(token, { 'index.html': 'other', 'a.css': 'shared' }, {}, 'one/pages/other');
    await remove(cookie);
    const now = Date.now();
    await purge(env, now + 29 * DAY);
    expect(await count('pages')).toBe(2);
    // The database itself keeps answers for 30 real days.
    await sql(`UPDATE pages SET deleted_at=${now - PURGE_AFTER - 1000} WHERE id='${pageId}'`);
    await purge(env, now);
    expect([await count('pages'), await count('page_versions'), await count('decisions'), await count('decision_answers'), await count('decision_revisions'), await count('comments'), await count('page_tags'), await count('version_files'), await count('pages_fts')]).toEqual([1, 1, 0, 0, 0, 0, 0, 2, 1]);
    await cleanUp(env, now + 2 * DAY);
    expect([await objects(), await count('blobs')]).toEqual([2, 2]);
    expect((await agent('/v1/projects/one/pages/other/versions/1/file?path=a.css', { token })).status).toBe(200);
    // The address is free again.
    expect((await publish(token, { 'index.html': 'new' })).status).toBe(200);
  });

  it('a page restored between the find and the purge stays whole', async () => {
    const { cookie } = await enter('o');
    await remove(cookie);
    let armed = true;
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { if (armed) { armed = false; await sql(`UPDATE pages SET deleted_at=NULL WHERE id='${pageId}'`); } return target.batch(statements); };
    } });
    await purge({ ...env, DB }, Date.now() + PURGE_AFTER + 1000);
    expect([armed, await count('pages'), await count('page_versions'), await count('version_files'), await count('decisions')]).toEqual([false, 1, 1, 2, 1]);
  });

  it('a page with many versions goes over several hours, and one that fails keeps no other', async () => {
    const { cookie } = await enter('o');
    await sql(...Array.from({ length: 60 }, (_, i) => `INSERT INTO page_versions VALUES('v${i}','${pageId}',${i + 2},'index.html','',1,1,'ao',(SELECT id FROM agent_keys LIMIT 1),1)`));
    await publish(token, { 'index.html': 'other' }, {}, 'one/pages/other');
    await remove(cookie); await api('DELETE', '/projects/one/pages/other', { cookie });
    const later = Date.now() + PURGE_AFTER + 1000;
    await purge(env, later);
    expect([await count('pages'), await count('page_versions')]).toEqual([1, 11]);
    await purge(env, later);
    expect([await count('pages'), await count('page_versions')]).toEqual([0, 0]);
  });

  it('removes deleted comments after 30 days, and the names of removed people', async () => {
    const { cookie } = await enter('o'), now = Date.now();
    for (const c of ['A', 'B']) await api('POST', `${PAGE}/comments`, { cookie, body: { id: `cmt_${c.repeat(26)}`, body: 'x', versionN: 1 } });
    await api('POST', `/comments/cmt_${'A'.repeat(26)}/replies`, { cookie, body: { id: `cmt_${'C'.repeat(26)}`, body: 'x' } });
    await api('DELETE', `/comments/cmt_${'A'.repeat(26)}`, { cookie });
    await sql(`UPDATE members SET removed_at=${now} WHERE id='m'`);
    await purge(env, now + 29 * DAY);
    expect([await count('comments'), (await one<{ name: string }>("SELECT name FROM members WHERE id='m'"))!.name]).toEqual([3, 'Mona']);
    await purge(env, now + 31 * DAY);
    expect([await count('comments'), (await one<{ name: string | null }>("SELECT name FROM members WHERE id='m'"))!.name, await count('members')]).toEqual([1, null, 3]);
  });
});

describe('how many versions are kept', () => {
  const keep = (cookie: string, value: unknown) => api('PUT', '/settings/retention', { cookie, body: { keep: value } });
  const versions = async () => (await env.DB.prepare('SELECT n FROM page_versions WHERE page_id=? ORDER BY n').bind(pageId).all<{ n: number }>()).results.map((v) => v.n).join();

  it('all, until the owner says how many; then each publish drops the older ones, and their files go', async () => {
    const { cookie } = await enter('o');
    expect(await (await api('GET', '/settings', { cookie })).json()).toEqual({ retention: null });
    for (const n of [2, 3]) await version(n, `v${n}`);
    expect(await versions()).toBe('1,2,3');
    expect(await (await keep(cookie, 2)).json()).toEqual({ retention: 2 });
    await version(4, 'v4');
    expect(await versions()).toBe('3,4');
    await cleanUp(env, Date.now() + 2 * DAY);
    expect(await objects()).toBe(3);
    expect((await agent('/v1/projects/one/pages/page/versions/2', { token })).status).toBe(404);
    expect((await agent('/v1/projects/one/pages/page/versions/4/file?path=a.css', { token })).status).toBe(200);
    // Decisions keep the wording of a version that is gone.
    expect((await json(await api('GET', `${PAGE}/decisions`, { cookie }))).items[0].question).toBe('Q?');
    await keep(cookie, null);
    await version(5, 'v5');
    expect(await versions()).toBe('3,4,5');
  });

  it('pages that aren’t published again are pruned by the hourly job, and it ends', async () => {
    const { cookie } = await enter('o');
    for (const n of [2, 3]) await version(n, `v${n}`);
    await sql(...Array.from({ length: 250 }, (_, i) => `INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('a${String(i).padStart(3, '0')}','p1','f${i}','T','ao',1,1)`));
    await prune(env);
    expect(await versions()).toBe('1,2,3');
    await keep(cookie, 1);
    await prune(env);
    expect(await versions()).toBe('1,2,3');
    await prune(env);
    expect([await versions(), await count('settings', "key='retention_walk'")]).toEqual(['3', 0]);
  });

  it('a page with many old versions is taken in steps, and the current one always stays', async () => {
    const { cookie } = await enter('o');
    await sql(...Array.from({ length: 45 }, (_, i) => `INSERT INTO page_versions VALUES('v${i}','${pageId}',${i + 2},'index.html','',1,1,'ao',(SELECT id FROM agent_keys LIMIT 1),1)`));
    await keep(cookie, 1);
    for (const left of [26, 6, 1]) { await prune(env); expect(await count('page_versions')).toBe(left); }
    expect(await versions()).toBe('46');
    await pruneVersions(env, pageId, 46, 1);
    expect(await versions()).toBe('46');
  });

  it('the owner’s alone, and a number', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(4);
    for (const response of [await keep(cookie, 1), await api('GET', '/settings', { cookie })]) expect(await code(response)).toEqual([403, 'forbidden']);
    for (const value of [0, -1, 1.5, 1001, '5', undefined, true]) expect(await code(await keep(owner, value)), String(value)).toEqual([422, 'invalid']);
  });
});

describe('objects without a row', () => {
  it('are removed once a week, when they are a day old', async () => {
    const now = Date.now();
    await env.FILES.put('blobs/lost/one', 'x');
    await env.FILES.put('other/kept', 'x');
    await sweep(env, now);
    expect(await objects()).toBe(4);
    await sweep(env, now + 2 * DAY);
    expect(await objects()).toBe(4);
    await sweep(env, now + 8 * DAY);
    expect((await env.FILES.list()).objects.map((o) => o.key)).not.toContain('blobs/lost/one');
    expect([await objects(), (await agent('/v1/projects/one/pages/page/versions/1/file?path=a.css', { token })).status]).toEqual([3, 200]);
  });
});

describe('projects', () => {
  const add = (cookie: string, body: object) => api('POST', '/projects', { cookie, body });
  it('the owner adds and names them', async () => {
    const { cookie } = await enter('o');
    const response = await add(cookie, { slug: 'garden', name: { en: ' Garden ', ar: 'الحديقة' } });
    expect([response.status, await response.json()]).toEqual([201, { slug: 'garden', name: { en: 'Garden', ar: 'الحديقة' }, level: 5 }]);
    expect(await code(await add(cookie, { slug: 'garden', name: { en: 'G', ar: 'ح' } }))).toEqual([409, 'conflict']);
    expect((await api('PATCH', '/projects/garden', { cookie, body: { name: { en: 'Yard', ar: 'الفناء' } } })).status).toBe(200);
    expect((await json(await api('GET', '/projects', { cookie }))).items.find((p: { slug: string }) => p.slug === 'garden').name).toEqual({ en: 'Yard', ar: 'الفناء' });
    expect((await publish((await makeKey()).token, { 'index.html': 'x' }, {}, 'garden/pages/first')).status).toBe(200);
    for (const body of [{ slug: 'A', name: { en: 'G', ar: 'ح' } }, { slug: '-a', name: { en: 'G', ar: 'ح' } }, { slug: 'x'.repeat(81), name: { en: 'G', ar: 'ح' } }, { slug: 'b', name: { en: 'G' } }, { slug: 'b', name: { en: ' ', ar: 'ح' } }, { slug: 'b', name: 'G' }, { slug: 'b', name: { en: 'G', ar: 'ح', fr: 'J' } }, { slug: 'b', name: { en: 'G', ar: 'ح' }, id: 'x' }]) {
      expect(await code(await add(cookie, body)), JSON.stringify(body)).toEqual([422, 'invalid']);
    }
  });

  it('nobody else does', async () => {
    const cookie = await member(4);
    expect(await code(await add(cookie, { slug: 'b', name: { en: 'G', ar: 'ح' } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('PATCH', '/projects/one', { cookie, body: { name: { en: 'G', ar: 'ح' } } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('PATCH', '/projects/three', { cookie, body: { name: { en: 'G', ar: 'ح' } } }))).toEqual([404, 'not_found']);
  });
});

describe('agents and keys', () => {
  const secret = 'A'.repeat(43);
  const add = async (cookie: string, change: object = {}) => api('POST', '/agent-keys', { cookie, body: { agent: 'ci', secretSha256: await sha(secret), scopes: ['pages:read', 'pages:write'], projects: ['one'], days: 90, label: 'Build server', ...change } });
  const works = async (id: string, path = '/v1/projects/one/pages/page') => (await agent(path, { token: `lawh_${id}_${secret}` })).status;
  const list = async (cookie: string) => (await json(await api('GET', '/agents', { cookie }))).items as { id: string; name: string; disabledAt: number | null; keys: { id: string; revokedAt: number | null }[] }[];

  it('a key is made from the hash alone, works where it says, and is listed without its secret', async () => {
    const { cookie } = await enter('o');
    const response = await add(cookie);
    expect(response.status).toBe(201);
    const { id, expiresAt } = await json(response);
    expect(expiresAt).toBeGreaterThan(Date.now() + 89 * DAY);
    expect([await works(id), await works(id, '/v1/projects/two/pages/x'), await works(id, '/v1/decisions'), (await agent('/v1/me', { token: `lawh_${id}_${'B'.repeat(43)}` })).status]).toEqual([200, 404, 403, 401]);
    const [ci] = (await list(cookie)).filter((a) => a.name === 'ci');
    expect(ci).toEqual({ id: expect.stringMatching(/^agt_/), name: 'ci', createdAt: expect.any(Number), disabledAt: null, keys: [{
      id, label: 'Build server', scopes: ['pages:read', 'pages:write'], allProjects: false, projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }], createdAt: expect.any(Number), expiresAt, lastUsedAt: expect.any(Number), revokedAt: null }] });
    expect(JSON.stringify(await list(cookie))).not.toContain(await sha(secret));
    // The same name is the same agent, with another key.
    await add(cookie, { projects: 'all', label: undefined });
    expect((await list(cookie)).filter((a) => a.name === 'ci').map((a) => a.keys.length)).toEqual([2]);
    expect((await env.DB.prepare("SELECT action FROM audit WHERE action='key.add'").all()).results).toHaveLength(2);
  });

  it('a revoked key and an agent that is off stop at once', async () => {
    const { cookie } = await enter('o'), { id } = await json(await add(cookie)), other = (await json(await add(cookie))).id;
    expect((await api('DELETE', `/agent-keys/${id}`, { cookie })).status).toBe(204);
    expect((await api('DELETE', `/agent-keys/${id}`, { cookie })).status).toBe(204);
    expect([await works(id), await works(other)]).toEqual([401, 200]);
    const ci = (await list(cookie)).find((a) => a.name === 'ci')!, off = (value: unknown) => api('PUT', `/agents/${ci.id}/off`, { cookie, body: { off: value } });
    expect((await off(true)).status).toBe(204);
    expect(await works(other)).toBe(401);
    expect(await code(await add(cookie))).toEqual([409, 'conflict']);
    await off(false);
    expect([await works(id), await works(other)]).toEqual([401, 200]);
    expect(await code(await off('yes'))).toEqual([422, 'invalid']);
  });

  it('a manager makes keys for what they manage, and for nothing else', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(4);
    const { id } = await json(await add(cookie));
    expect(await works(id)).toBe(200);
    expect(await code(await add(cookie, { projects: ['three'] }))).toEqual([404, 'not_found']);
    expect(await code(await add(cookie, { projects: ['one', 'three'] }))).toEqual([404, 'not_found']);
    expect(await code(await add(cookie, { projects: 'all' }))).toEqual([403, 'forbidden']);
    const mine = (await json(await add(owner))).id;
    expect((await list(cookie)).flatMap((a) => a.keys).map((k) => k.id)).toEqual([id]);
    expect(await code(await api('DELETE', `/agent-keys/${mine}`, { cookie }))).toEqual([404, 'not_found']);
    expect(await code(await api('PUT', '/agents/agt_00000000000000000000000000/off', { cookie, body: { off: true } }))).toEqual([404, 'not_found']);
    for (const level of [1, 2, 3]) {
      await setLevel(level);
      for (const response of [await add(cookie), await api('GET', '/agents', { cookie })]) expect(await code(response)).toEqual([403, 'forbidden']);
      expect(await works(id)).toBe(404);
    }
    // Their own key can always be revoked, and the owner can revoke anyone's.
    expect((await api('DELETE', `/agent-keys/${id}`, { cookie: owner })).status).toBe(204);
  });

  it.each([[{ agent: '' }], [{ agent: 'x'.repeat(61) }], [{ agent: 'a\nb' }], [{ secretSha256: 'x' }], [{ secretSha256: 'A'.repeat(64) }], [{ scopes: [] }], [{ scopes: ['pages:read', 'pages:read'] }], [{ scopes: ['keys:write'] }], [{ scopes: 'pages:read' }], [{ projects: [] }], [{ projects: 'one' }],
    [{ projects: Array.from({ length: 21 }, (_, i) => `p${i}`) }], [{ days: 0 }], [{ days: 366 }], [{ days: '90' }], [{ label: 'x'.repeat(61) }], [{ more: 1 }]])('refuses %j', async (change) => {
    expect(await code(await add((await enter('o')).cookie, change))).toEqual([422, 'invalid']);
    expect(await count('agents', "name='ci'")).toBe(0);
  });

  it('a failed key leaves no agent behind, and 100 keys are enough', async () => {
    const { cookie } = await enter('o');
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { if (statements.length === 5) await sql("DELETE FROM team_members WHERE member_id='m'"); return target.batch(statements); };
    } });
    const mona = await member(4);
    expect(await code(await api('POST', '/agent-keys', { cookie: mona, body: { agent: 'late', secretSha256: await sha(secret), scopes: ['pages:read'], projects: ['one'], days: 1 } }, { DB }))).toEqual([409, 'conflict']);
    expect(await count('agents', "name='late'")).toBe(0);
    await add(cookie);
    await env.DB.batch(Array.from({ length: 99 }, (_, i) => env.DB.prepare("INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) SELECT ?,id,'h','[]',1,? FROM agents WHERE name='ci'").bind(`k${i}`, Date.now() + DAY)));
    expect(await code(await add(cookie))).toEqual([409, 'conflict']);
  });
});

describe('the export', () => {
  /** A small reader of what `zip` writes: it trusts only the directory. */
  const unzip = async (response: Response): Promise<Map<string, Uint8Array>> => {
    const bytes = new Uint8Array(await response.arrayBuffer()), view = new DataView(bytes.buffer), out = new Map<string, Uint8Array>();
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    let at = view.getUint32(end + 16, true);
    for (let i = 0; i < view.getUint16(end + 10, true); i++) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      const crc = view.getUint32(at + 16, true), size = view.getUint32(at + 24, true), name = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), offset = view.getUint32(at + 42, true);
      const data = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true), body = bytes.slice(data, data + size);
      const { crc32 } = await import('../../../src/app/people/zip');
      expect(crc32(body)).toBe(crc);
      out.set(new TextDecoder().decode(bytes.slice(at + 46, at + 46 + name)), body);
      at += 46 + name + extra;
    }
    return out;
  };

  it('rows of every table, without sign-ins and secrets', async () => {
    const { cookie } = await enter('o');
    const response = await api('GET', '/export/rows', { cookie });
    expect([response.status, response.headers.get('Content-Type'), response.headers.get('Content-Disposition')]).toEqual([200, 'application/zip', 'attachment; filename="lawh-rows.zip"']);
    const files = await unzip(response), rows = (table: string) => new TextDecoder().decode(files.get(`rows/${table}.ndjson`)!).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows('pages')).toMatchObject([{ id: pageId, slug: 'page', title: 'T' }]);
    expect([rows('version_files').length, rows('decisions').length, rows('members').length, rows('projects').length]).toEqual([2, 1, 3, 3]);
    const all = [...files.values()].map((b) => new TextDecoder().decode(b)).join('\n');
    expect(all).not.toContain((await one<{ h: string }>('SELECT secret_hmac h FROM agent_keys'))!.h);
    expect(all).not.toContain((await one<{ h: string }>('SELECT token_sha256 h FROM sessions'))!.h);
    for (const name of ['sessions', 'passkeys', 'access_links', 'device_approvals', 'agent_connects', 'idempotency', 'uploads', 'auth_challenges']) expect(files.has(`rows/${name}.ndjson`), name).toBe(false);
    // Every table is either exported or left out on purpose.
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'pages_fts%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%cf_%' AND name <> 'd1_migrations'").all<{ name: string }>();
    const left = ['access_links', 'agent_connects', 'auth_challenges', 'device_approvals', 'idempotency', 'passkeys', 'sessions', 'upload_blobs', 'uploads', 'webhook_deliveries'];
    expect(results.map((t) => t.name).sort()).toEqual([...left, ...[...files.keys()].flatMap((f) => /^rows\/(.+)\.ndjson$/.exec(f)?.[1] ?? [])].sort());
    expect(await count('audit', "action='export'")).toBe(1);
  });

  it('a table of many rows is whole, each row once', async () => {
    const { cookie } = await enter('o');
    await env.DB.batch(Array.from({ length: 1200 }, (_, i) => env.DB.prepare("INSERT INTO page_tags VALUES(?,?,'p1',1)").bind(pageId, `t${i}`)));
    const rows = new TextDecoder().decode((await unzip(await api('GET', '/export/rows', { cookie }))).get('rows/page_tags.ndjson')!).trim().split('\n');
    expect([rows.length, new Set(rows).size]).toEqual([1201, 1201]);
  });

  it('the files, in parts, each named by its hash', async () => {
    const { cookie } = await enter('o');
    const { parts } = await json(await api('GET', '/export', { cookie }));
    expect(parts).toEqual([{ after: '', last: expect.stringMatching(/^[0-9a-f]{64}$/), files: 2, bytes: 19 }]);
    const files = await unzip(await api('GET', `/export/files?after=&last=${parts[0].last}&part=1`, { cookie }));
    expect(new TextDecoder().decode(files.get(`files/${await sha('shared')}`)!)).toBe('shared');
    expect(files.size).toBe(2);
    await env.DB.batch(Array.from({ length: 1001 }, (_, i) => env.DB.prepare('INSERT INTO blobs VALUES(?,?,?,1,NULL)').bind(String(i).padStart(64, '0'), `blobs/${i}`, i < 3 ? 300_000_000 : 1)));
    const many = (await json(await api('GET', '/export', { cookie }))).parts as { after: string; last: string; files: number; bytes: number }[];
    expect(many.map((p) => p.files)).toEqual([1, 1, 500, 500, 1]);
    expect(many.reduce((n, p) => n + p.files, 0)).toBe(1003);
    for (const [i, p] of many.entries()) expect(p.after).toBe(i === 0 ? '' : many[i - 1]!.last);
  });

  it('the owner’s alone', async () => {
    const cookie = await member(4);
    for (const path of ['/export', '/export/rows', `/export/files?last=${'0'.repeat(64)}`]) expect(await code(await api('GET', path, { cookie })), path).toEqual([403, 'forbidden']);
    const owner = (await enter('o')).cookie;
    for (const query of ['', '?last=x', `?last=${'0'.repeat(64)}&after=x`, `?last=${'0'.repeat(64)}&part=0`]) expect(await code(await api('GET', `/export/files${query}`, { cookie: owner })), query).toEqual([422, 'invalid']);
  });
});
