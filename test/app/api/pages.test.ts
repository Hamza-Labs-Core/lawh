import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, code, json, makeKey, one, publish, seed, sql } from './helpers';

let token: string;
beforeEach(async () => { await seed(); ({ token } = await makeKey()); });

const list = async (query = '', t = token): Promise<string[]> => (await json(await call(`/v1/pages${query}`, { token: t }))).items.map((p: { slug: string }) => p.slug);

/** Pages a to f, oldest first, in p1 and p2 by turns; b and e are in review; a, c and e have the tag x. */
async function pages(): Promise<void> {
  for (const [i, slug] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) {
    await publish(token, { 'index.html': slug }, { page: { title: slug, ...(i % 2 === 0 && { tags: ['x'] }), ...('be'.includes(slug) && { status: 'in_review' }) } }, `${i % 2 ? 'two' : 'one'}/pages/${slug}`);
    await env.DB.prepare('UPDATE pages SET updated_at=? WHERE slug=?').bind(1000 + i, slug).run();
  }
}

describe('lists', () => {
  beforeEach(pages);

  it.each([
    ['', 'f,e,d,c,b,a'], ['?project=one', 'e,c,a'], ['?status=in_review', 'e,b'], ['?project=two&status=in_review', 'b'], ['?tag=x', 'e,c,a'],
    ['?tag=x&status=in_review', 'e'], ['?project=one&tag=x', 'e,c,a'], ['?project=two&tag=x', ''], ['?project=one&tag=x&status=draft', 'c,a'], ['?tag=nope', ''], ['?project=three', ''],
  ])('filters %s', async (query, expected) => { expect((await list(query)).join()).toBe(expected); });

  it.each(['', '?project=one', '?tag=x', '?status=draft', '?project=one&tag=x&status=draft'])('pages through %s without a gap or a repeat', async (query) => {
    for (const t of [token, (await makeKey({ projects: ['p1', 'p2'] })).token, (await makeKey({ agent: 'am', projects: ['p1', 'p2'] })).token]) {
      const all = await list(query, t), seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: { items: { slug: string }[]; next: string | null } = await json(await call(`/v1/pages${query || '?'}&limit=1${cursor ? `&cursor=${cursor}` : ''}`, { token: t }));
        expect(body.items).toHaveLength(1);
        seen.push(body.items[0]!.slug); cursor = body.next;
      } while (cursor);
      expect(seen).toEqual(all);
    }
  });

  it('pages through rows of the same moment', async () => {
    await sql('UPDATE pages SET updated_at=5');
    for (const t of [token, (await makeKey({ projects: ['p1', 'p2'] })).token]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: { items: { slug: string }[]; next: string | null } = await json(await call(`/v1/pages?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { token: t }));
        seen.push(...body.items.map((p) => p.slug)); cursor = body.next;
      } while (cursor);
      expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    }
  });

  it('holds only the projects of the key', async () => {
    expect(await list('', (await makeKey({ projects: ['p2'] })).token)).toEqual(['f', 'd', 'b']);
    expect(await list('', (await makeKey({ agent: 'am', projects: ['p1'] })).token)).toEqual(['e', 'c', 'a']);
    expect((await json(await call('/v1/projects', { token: (await makeKey({ projects: ['p2', 'p3'] })).token }))).items.map((p: { slug: string }) => p.slug).sort()).toEqual(['three', 'two']);
    expect((await json(await call('/v1/projects', { token }))).items).toHaveLength(3);
  });

  it('shows a project once to a manager of it in two teams', async () => {
    await sql("INSERT INTO teams(id,name,created_at) VALUES('t2','T2',1)", "INSERT INTO team_projects(team_id,project_id) VALUES('t2','p1')",
      "INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t2','m',4,'o',1)");
    const mona = await makeKey({ agent: 'am', projects: ['p1'] });
    expect((await json(await call('/v1/projects', { token: mona.token }))).items).toHaveLength(1);
    expect(await list('', mona.token)).toEqual(['e', 'c', 'a']);
  });

  it.each(['?limit=0', '?limit=101', '?limit=x', '?limit=1.5', '?cursor=x', '?cursor=W10', '?status=gone', '?q=word'])('refuses %s', async (query) => {
    expect(await code(await call(`/v1/pages${query}`, { token }))).toEqual([422, 'invalid']);
  });

  it('moves a page to the top, in its tags too, when it changes', async () => {
    await call('/v1/projects/one/pages/a', { method: 'PATCH', token, json: { summary: 'new' }, idem: 'x' });
    expect((await list())[0]).toBe('a');
    expect((await list('?tag=x'))[0]).toBe('a');
  });
});

describe('changing a page', () => {
  const patch = (body: unknown, idem: string, t = token) => call('/v1/projects/one/pages/page', { method: 'PATCH', token: t, json: body, idem });
  beforeEach(async () => { await publish(token, { 'index.html': 'x' }, { page: { title: 'T', summary: 'S', tags: ['a'] } }); });

  it('changes only what is sent', async () => {
    const before = await json(await call('/v1/projects/one/pages/page', { token }));
    const after = await json(await patch({ title: 'New' }, '1'));
    expect(after).toMatchObject({ title: 'New', summary: 'S', tags: ['a'], status: 'draft', currentVersion: 1 });
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(await json(await patch({ tags: ['c', 'b'], summary: '', lang: 'ar' }, '2'))).toMatchObject({ title: 'New', summary: '', tags: ['b', 'c'], lang: 'ar' });
    expect(await json(await call('/v1/projects/one/pages/page', { token }))).toMatchObject({ title: 'New', summary: '', tags: ['b', 'c'], lang: 'ar' });
  });

  it('records a change of status, and no other', async () => {
    await patch({ title: 'New' }, '1'); await patch({ status: 'draft' }, '2');
    expect(await one("SELECT COUNT(*) n FROM events WHERE type='page.status'")).toEqual({ n: 0 });
    await patch({ status: 'in_review' }, '3');
    expect(await one("SELECT COUNT(*) n FROM events WHERE type='page.status'")).toEqual({ n: 1 });
  });

  it('happens once when sent again, and refuses the key for another change', async () => {
    const first = await json(await patch({ title: 'A' }, 'same'));
    await patch({ title: 'B' }, 'other');
    expect(await json(await patch({ title: 'A' }, 'same'))).toEqual(first);
    expect((await json(await call('/v1/projects/one/pages/page', { token }))).title).toBe('B');
    expect(await code(await patch({ title: 'C' }, 'same'))).toEqual([422, 'invalid']);
  });

  it.each([{}, { title: '' }, { status: 'decided' }, { lang: 'fr' }, { tags: 'x' }, { tags: [''] }, { id: 'x' }, { title: 'a\u0007' }, { title: 'a\ud800' }])('refuses %j', async (body) => {
    expect(await code(await patch(body, 'x'))).toEqual([422, 'invalid']);
  });

  it('loses nothing when several change it at once', async () => {
    const results = await Promise.all(['A', 'B', 'C'].map((title) => patch({ title, tags: [title] }, title)));
    const page = await json(await call('/v1/projects/one/pages/page', { token }));
    expect(page.tags).toEqual([page.title]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
  });

  it('answers 409 when the page changes between its read and its write', async () => {
    const DB = new Proxy(env.DB, {
      get(target, name) {
        if (name === 'batch') return async (statements: D1PreparedStatement[]) => { await sql('UPDATE pages SET updated_at = updated_at + 1'); return target.batch(statements); };
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await call('/v1/projects/one/pages/page', { method: 'PATCH', token, json: { title: 'New' }, idem: 'x' }, { DB });
    expect(await code(response)).toEqual([409, 'conflict']);
    expect((await one<{ title: string }>('SELECT title FROM pages'))!.title).toBe('T');
    expect(await one("SELECT COUNT(*) n FROM idempotency WHERE idem_key='x'")).toEqual({ n: 0 });
  });

  it('has an ETag that changes with the page', async () => {
    const etag = (await call('/v1/projects/one/pages/page', { token })).headers.get('ETag')!;
    const same = await call('/v1/projects/one/pages/page', { token, headers: { 'If-None-Match': etag } });
    expect([same.status, await same.text(), same.headers.get('ETag')]).toEqual([304, '', etag]);
    await patch({ title: 'New' }, '1');
    expect((await call('/v1/projects/one/pages/page', { token, headers: { 'If-None-Match': etag } })).status).toBe(200);
  });

  it('answers 404 for a page, version or file that is not there', async () => {
    for (const path of ['/v1/projects/one/pages/nope', '/v1/projects/nope/pages/page', '/v1/projects/one/pages/page/versions/2', '/v1/projects/one/pages/page/versions/0',
      '/v1/projects/one/pages/page/versions/1/file?path=nope.html', '/v1/projects/one/pages/page/versions/1/file']) {
      expect((await call(path, { token })).status, path).toBe(404);
    }
  });
});

describe('queries', () => {
  it('never scan a table, and never sort without an index', async () => {
    const seen = new Set<string>();
    const DB = new Proxy(env.DB, {
      get(target, name) {
        if (name === 'prepare') return (query: string) => { seen.add(query); return target.prepare(query); };
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const keys = [token, (await makeKey({ projects: ['p1', 'p2'] })).token, (await makeKey({ agent: 'am', projects: ['p1', 'p2'] })).token];
    const { cleanUp, } = await import('../../../src/app/api/publish');
    for (const [i, t] of keys.entries()) {
      const go = (path: string, init: object = {}) => call(path, { token: t, ...init }, { DB });
      const { manifest, sha } = await import('./helpers');
      for (const baseVersion of [0, 1]) {
        const started = await json(await go(`/v1/projects/one/pages/q${i}/versions`, { method: 'POST', json: await manifest({ 'index.html': `x${i}${baseVersion}`, 'b.css': 'same' }, { baseVersion, page: { title: 'T', tags: ['x'], status: baseVersion ? 'in_review' : 'draft' } }), idem: `s${i}${baseVersion}` }));
        for (const c of [`x${i}${baseVersion}`, 'same']) await go(`/v1/uploads/${started.uploadId}/blobs/${await sha(c)}`, { method: 'PUT', body: c });
        expect((await go(`/v1/uploads/${started.uploadId}/commit`, { method: 'POST', idem: `c${i}${baseVersion}` })).status).toBe(200);
      }
      await go(`/v1/projects/one/pages/q${i}`, { method: 'PATCH', json: { title: 'x', tags: ['y'], status: 'draft' }, idem: `p${i}` });
      for (const q of ['', '?project=one', '?tag=x', '?status=draft', '?project=one&tag=x', '?project=one&status=draft', '?tag=x&status=draft', '?project=one&tag=x&status=draft']) await go(`/v1/pages${q}`);
      for (const path of ['', '/versions', '/versions/1', '/versions/1/file?path=index.html']) expect((await go(`/v1/projects/one/pages/q${i}${path}`)).status).toBe(200);
      await go('/v1/me'); await go('/v1/projects');
    }
    const left = await json(await call('/v1/projects/one/pages/left/versions', { token, method: 'POST', json: await (await import('./helpers')).manifest({ 'index.html': 'left' }), idem: 'left' }));
    await (await import('./helpers')).put(token, left.uploadId, 'left');
    await sql('UPDATE uploads SET expires_at=1');
    await cleanUp({ ...env, DB }); await cleanUp({ ...env, DB }, Date.now() + 90_000_000);
    expect(seen.size).toBeGreaterThan(40);
    for (const query of seen) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...Array(Math.max((query.match(/\?(?!\d)/g) ?? []).length, /\?2/.test(query) ? 2 : 0)).fill(null)).all<{ detail: string }>();
      for (const { detail } of results) {
        expect(/^SCAN (?!j\b|json_each\b|CONSTANT ROW)/.test(detail) || detail.includes('TEMP B-TREE'), `${detail} | ${query}`).toBe(false);
      }
    }
  });
});
