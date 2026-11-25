import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanUp } from '../../../src/app/api/publish';
import { call, code, commit, json, makeKey, manifest, one, publish, put, seed, sha, sql, start } from './helpers';

let token: string;
beforeEach(async () => { await seed(); ({ token } = await makeKey()); });

const rows = async (table: string) => (await one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`))!.n;
const objects = async () => (await env.FILES.list()).objects.map((o) => o.key);
const stateOf = async () => Object.fromEntries(await Promise.all(['pages', 'page_versions', 'version_files', 'events', 'page_tags'].map(async (t) => [t, await rows(t)])));

describe('publishing', () => {
  it('publishes a page with files, and reads it back', async () => {
    const response = await publish(token, { 'index.html': '<h1>Hi</h1>', 'a/صورة.png': new Uint8Array([1, 2, 255]) },
      { page: { title: 'Design', summary: 'S', lang: 'ar', tags: ['b', 'a', 'b'], status: 'in_review' }, note: 'first' });
    expect(response.status).toBe(200);
    const page = await json(response);
    expect(page).toEqual({
      id: expect.stringMatching(/^pag_/), project: 'one', slug: 'page', url: 'https://lawh.example.com/p/one/page', title: 'Design', summary: 'S',
      lang: 'ar', tags: ['a', 'b'], status: 'in_review', currentVersion: 1, createdAt: expect.any(Number), updatedAt: expect.any(Number),
    });
    const read = await json(await call('/v1/projects/one/pages/page', { token }));
    expect(read).toEqual({ ...page, files: [
      { path: 'a/صورة.png', sha256: await sha(new Uint8Array([1, 2, 255])), bytes: 3 }, { path: 'index.html', sha256: await sha('<h1>Hi</h1>'), bytes: 11 }] });
    expect(await json(await call('/v1/projects/one/pages/page/versions/1', { token }))).toMatchObject({ n: 1, note: 'first', bytes: 14, fileCount: 2, publishedBy: 'owner-bot' });
    const file = await call(`/v1/projects/one/pages/page/versions/1/file?path=${encodeURIComponent('a/صورة.png')}`, { token });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 255]));
    expect(file.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(file.headers.get('Content-Disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('صورة.png')}`);
    expect(file.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    const types = await env.DB.prepare('SELECT path, media_type FROM version_files ORDER BY path').all();
    expect(types.results).toEqual([{ path: 'a/صورة.png', media_type: 'image/png' }, { path: 'index.html', media_type: 'text/html; charset=utf-8' }]);
    expect(await one('SELECT type, actor_type, actor_id, project_id FROM events')).toEqual({ type: 'page.published', actor_type: 'agent', actor_id: 'ao', project_id: 'p1' });
    expect([await rows('uploads'), await rows('upload_blobs')]).toEqual([0, 0]);
  });

  it('keeps the address and what a new version leaves out, and stores an unchanged file once', async () => {
    const first = await json(await publish(token, { 'index.html': 'one', 'a.css': 'same' }, { page: { title: 'T', summary: 'S', tags: ['x'] } }));
    const started = await json(await start(token, await manifest({ 'index.html': 'two', 'a.css': 'same' }, { baseVersion: 1, page: {} })));
    expect(started.missing).toEqual([await sha('two')]);
    expect((await put(token, started.uploadId, 'two')).status).toBe(204);
    const second = await json(await commit(token, started.uploadId));
    expect(second).toEqual({ ...first, currentVersion: 2, updatedAt: expect.any(Number) });
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(await objects()).toHaveLength(3);
    const history = await json(await call('/v1/projects/one/pages/page/versions?limit=1', { token }));
    expect(history.items.map((v: { n: number }) => v.n)).toEqual([2]);
    const older = await json(await call(`/v1/projects/one/pages/page/versions?limit=1&cursor=${history.next}`, { token }));
    expect([older.items.map((v: { n: number }) => v.n), older.next]).toEqual([[1], null]);
    expect(await (await call('/v1/projects/one/pages/page/versions/1/file?path=index.html', { token })).text()).toBe('one');
  });

  it('shows nothing, and takes no address, before commit', async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' })));
    await put(token, uploadId, 'x');
    expect((await call('/v1/projects/one/pages/page', { token })).status).toBe(404);
    expect((await json(await call('/v1/pages', { token }))).items).toEqual([]);
    expect((await start(token, await manifest({ 'index.html': 'y' }))).status).toBe(201);
  });

  it('refuses a base that is not the current version, at start and at commit', async () => {
    const files = { 'index.html': 'x' };
    const a = await json(await start(token, await manifest(files))), b = await json(await start(token, await manifest(files)));
    await put(token, a.uploadId, 'x'); await put(token, b.uploadId, 'x');
    expect((await commit(token, a.uploadId)).status).toBe(200);
    const before = await stateOf();
    expect(await code(await commit(token, b.uploadId))).toEqual([409, 'conflict']);
    expect(await stateOf()).toEqual(before);
    for (const baseVersion of [0, 2]) expect(await code(await start(token, await manifest(files, { baseVersion })))).toEqual([409, 'conflict']);
  });

  it('lets one of two commits at the same moment win, and the other change nothing', async () => {
    for (const baseVersion of [0, 1]) {
      const uploads = await Promise.all(['a', 'b'].map(async (text) => {
        const { uploadId } = await json(await start(token, await manifest({ 'index.html': text + baseVersion }, { baseVersion, page: { title: text, tags: [text] } })));
        await put(token, uploadId, text + baseVersion);
        return uploadId as string;
      }));
      const results = await Promise.all(uploads.map((id) => commit(token, id)));
      expect(results.map((r) => r.status).sort(), `base ${baseVersion}`).toEqual([200, 409]);
      const won = await json(results.find((r) => r.status === 200)!);
      const page = await json(await call('/v1/projects/one/pages/page', { token }));
      expect([page.title, page.tags, page.currentVersion]).toEqual([won.title, won.tags, baseVersion + 1]);
      expect(await rows('page_versions')).toBe(baseVersion + 1);
    }
  });

  it('refuses a deleted page', async () => {
    await publish(token, { 'index.html': 'x' });
    const started = await json(await start(token, await manifest({ 'index.html': 'x' }, { baseVersion: 1 })));
    await sql('UPDATE pages SET deleted_at=1');
    expect(await code(await commit(token, started.uploadId))).toEqual([409, 'conflict']);
    for (const baseVersion of [0, 1]) expect(await code(await start(token, await manifest({ 'index.html': 'x' }, { baseVersion })))).toEqual([409, 'conflict']);
    for (const path of ['', '/versions', '/versions/1', '/versions/1/file?path=index.html']) expect((await call(`/v1/projects/one/pages/page${path}`, { token })).status, path).toBe(404);
    expect((await json(await call('/v1/pages', { token }))).items).toEqual([]);
  });

  it('refuses to commit before every file is sent', async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x', 'b.css': 'y' })));
    await put(token, uploadId, 'x');
    const response = await commit(token, uploadId);
    expect([response.status, await json(response)]).toEqual([422, expect.objectContaining({ code: 'invalid', details: { missing: [await sha('y')] } })]);
    await put(token, uploadId, 'y');
    expect((await commit(token, uploadId)).status).toBe(200);
  });

  it("keeps an upload to its key, its project and its time", async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' })));
    const other = await makeKey();
    expect((await put(other.token, uploadId, 'x')).status).toBe(404);
    expect((await commit(other.token, uploadId)).status).toBe(404);
    await sql('UPDATE uploads SET expires_at=1');
    expect((await put(token, uploadId, 'x')).status).toBe(404);
    expect((await commit(token, uploadId)).status).toBe(404);
  });

  it('stops when the person loses the project, at the next file and at commit', async () => {
    const mona = await makeKey({ agent: 'am', projects: ['p1'] });
    const { uploadId } = await json(await start(mona.token, await manifest({ 'index.html': 'x', 'b.css': 'y' })));
    await put(mona.token, uploadId, 'x'); await put(mona.token, uploadId, 'y');
    await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'");
    expect((await put(mona.token, uploadId, 'y')).status).toBe(404);
    expect((await commit(mona.token, uploadId)).status).toBe(404);
    expect(await rows('pages')).toBe(0);
  });
});

describe('files', () => {
  it.each([
    ['other bytes', 'z'], ['too short', ''], ['too long', 'xx'],
  ])('refuses a body with %s, and stores nothing', async (_, body) => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' })));
    expect(await code(await put(token, uploadId, body, await sha('x')))).toEqual([422, 'invalid']);
    expect([await objects(), await rows('blobs'), await rows('upload_blobs')]).toEqual([[], 0, 0]);
    expect((await put(token, uploadId, 'x')).status).toBe(204);
  });

  it('takes an empty file and a large one in many chunks', async () => {
    const large = new Uint8Array(3_000_000).map((_, i) => i % 251);
    const response = await publish(token, { 'index.html': '', 'b.png': large });
    expect(response.status).toBe(200);
    const read = await call('/v1/projects/one/pages/page/versions/1/file?path=b.png', { token });
    expect(await sha(new Uint8Array(await read.arrayBuffer()))).toBe(await sha(large));
  });

  it('refuses a file the upload does not list', async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' })));
    expect(await code(await put(token, uploadId, 'other'))).toEqual([422, 'invalid']);
  });

  it("doesn't give a project a file only another project sent", async () => {
    await publish(token, { 'index.html': 'secret plan' });
    const started = await json(await start(token, await manifest({ 'index.html': 'secret plan' }), 'two/pages/copy'));
    expect(started.missing).toEqual([await sha('secret plan')]);
    expect(await code(await put(token, started.uploadId, 'secret plam', await sha('secret plan')))).toEqual([422, 'invalid']);
    expect(await code(await commit(token, started.uploadId))).toEqual([422, 'invalid']);
    expect((await put(token, started.uploadId, 'secret plan')).status).toBe(204);
    expect((await commit(token, started.uploadId)).status).toBe(200);
    expect(await objects()).toHaveLength(1);
  });

  it('refuses a wrong size for a hash the project holds', async () => {
    await publish(token, { 'index.html': 'x' });
    const body = await manifest({ 'index.html': 'x' }, { baseVersion: 1 });
    body.files[0]!.bytes = 2;
    expect(await code(await start(token, body))).toEqual([422, 'invalid']);
  });

  it('keeps one object when the same new file is sent twice at once', async () => {
    const a = await json(await start(token, await manifest({ 'index.html': 'x' }))), b = await json(await start(token, await manifest({ 'index.html': 'x' }), 'two/pages/b'));
    expect((await Promise.all([put(token, a.uploadId, 'x'), put(token, b.uploadId, 'x')])).map((r) => r.status)).toEqual([204, 204]);
    expect(await objects()).toEqual([(await one<{ r2_key: string }>('SELECT r2_key FROM blobs'))!.r2_key]);
    expect((await commit(token, b.uploadId)).status).toBe(200);
  });

  it('leaves no object behind when the database fails after the file is stored', async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' })));
    await sql('ALTER TABLE project_blobs RENAME TO away');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await put(token, uploadId, 'x')).status).toBe(500); } finally { log.mockRestore(); }
    expect(await objects()).toEqual([]);
  });

  // Built at run time, so that no key-shaped text is in this repository.
  const fake = {
    lawh: `lawh_key_${'0'.repeat(26)}_${'a'.repeat(43)}`, aws: `AKIA${'A'.repeat(16)}`, github: `ghp_${'a'.repeat(36)}`,
    anthropic: `sk-ant-${'a'.repeat(24)}`, pem: `-----BEGIN RSA ${'PRIVATE'} KEY-----`, google: `AIza${'a'.repeat(35)}`, npm: `npm_${'a'.repeat(36)}`,
  };
  it.each(Object.entries(fake))('refuses a file with a %s key, tells where, and stores nothing', async (_, secret) => {
    const content = `<p>é ${secret} </p>`;
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': content })));
    const response = await put(token, uploadId, content);
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'secret_found', details: { position: 6 } });
    expect(body).not.toContain(secret);
    expect([await objects(), await rows('blobs')]).toEqual([[], 0]);
  });

  it('finds a key split between chunks, at its position', async () => {
    const bytes = new TextEncoder().encode(`${'x '.repeat(50_000)}${fake.lawh} end`);
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': bytes })));
    for (const cut of [100_000, 100_001, 100_040, 100_077]) {
      const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
      const response = await call(`/v1/uploads/${uploadId}/blobs/${await sha(bytes)}`, { method: 'PUT', token, body, headers: {} });
      expect([response.status, (await json(response)).details], String(cut)).toEqual([422, { position: 100_000 }]);
    }
  });

  it('finds a key at the very end, and an escaped one in JSON', async () => {
    const content = `x ${fake.aws}`;
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': content })));
    expect(await code(await put(token, uploadId, content))).toEqual([422, 'secret_found']);
    const body = JSON.stringify(await manifest({ 'index.html': 'x' }, { page: { title: fake.aws } })).replace('AKIA', '\\u0041KIA');
    expect(body).not.toContain('AKIA');
    expect(await code(await call('/v1/projects/one/pages/page/versions', { method: 'POST', token, body, idem: 'x' }))).toEqual([422, 'secret_found']);
  });

  it('refuses a key in the page details, also for a file it already holds', async () => {
    expect(await code(await start(token, await manifest({ 'index.html': 'x' }, { page: { title: `T ${fake.github}` } })))).toEqual([422, 'secret_found']);
    await publish(token, { 'index.html': 'x' });
    expect(await code(await call('/v1/projects/one/pages/page', { method: 'PATCH', token, json: { summary: fake.aws }, idem: 'x' }))).toEqual([422, 'secret_found']);
  });
});

describe('at the same moment', () => {
  /** Runs `between` just before the nth batch that writes, as another request would. */
  const before = (between: () => Promise<unknown>, matching: (sql: string) => boolean) => {
    let done = false;
    const seen = new WeakMap<object, string>();
    const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
      seen.set(statement, query);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => wrap(bind(...values), query);
      return statement;
    };
    return new Proxy(env.DB, {
      get(target, name) {
        if (name === 'prepare') return (query: string) => wrap(target.prepare(query), query);
        if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
          if (!done && statements.some((s) => matching(seen.get(s) ?? ''))) { done = true; await between(); }
          return target.batch(statements);
        };
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const isCommit = (q: string) => q.includes('INSERT INTO page_versions');
  const commitWith = (DB: D1Database, uploadId: string) => call(`/v1/uploads/${uploadId}/commit`, { method: 'POST', token, idem: 'com' }, { DB });

  it("keeps what another request changed in the page's details", async () => {
    await publish(token, { 'index.html': 'x' }, { page: { title: 'Old', tags: ['a'], status: 'in_review' } });
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' }, { baseVersion: 1, page: {} })));
    const DB = before(async () => {
      await call('/v1/projects/one/pages/page', { method: 'PATCH', token, json: { title: 'Patched', tags: ['b'] }, idem: 'p' });
      await sql("UPDATE pages SET status='decided', updated_at=updated_at+100000");
    }, isCommit);
    const response = await commitWith(DB, uploadId);
    expect(response.status).toBe(200);
    const page = await json(response);
    expect(page).toMatchObject({ title: 'Patched', tags: ['b'], status: 'decided', currentVersion: 2 });
    expect(await json(await call('/v1/projects/one/pages/page', { token }))).toMatchObject(page);
    expect(await one("SELECT COUNT(*) n FROM events WHERE type='page.status'")).toEqual({ n: 0 });
  });

  it('refuses when the page is deleted, or the upload cleaned up, just before the write', async () => {
    await publish(token, { 'index.html': 'x' });
    for (const [change, status] of [['UPDATE uploads SET expires_at=1', 404], ['UPDATE pages SET deleted_at=1', 409]] as const) {
      const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' }, { baseVersion: 1 })));
      const old = await stateOf();
      expect((await commitWith(before(() => sql(change), isCommit), uploadId)).status).toBe(status);
      expect(await stateOf()).toEqual(old);
    }
  });

  it('gives up with 409 when the page keeps changing', async () => {
    await publish(token, { 'index.html': 'x' });
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x' }, { baseVersion: 1 })));
    const DB = new Proxy(env.DB, {
      get(target, name) {
        if (name === 'batch') return async (statements: D1PreparedStatement[]) => { await sql('UPDATE pages SET updated_at = updated_at + 1'); return target.batch(statements); };
        const value = Reflect.get(target, name) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await code(await commitWith(DB, uploadId))).toEqual([409, 'conflict']);
    expect(await rows('page_versions')).toBe(1);
  });

  it('marks a file that arrives while its upload is cleaned up, so it is removed later', async () => {
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'x', 'b.css': 'y' })));
    await put(token, uploadId, 'x');
    await sql('UPDATE uploads SET expires_at=?1'.replace('?1', String(Date.now() + 60_000)));
    const later = Date.now() + 120_000;
    await cleanUp({ ...env, DB: before(() => put(token, uploadId, 'y'), (q) => q.includes('DELETE FROM uploads')) }, later);
    expect(await rows('blobs')).toBe(2);
    await cleanUp(env, later + 90_000_000);
    expect([await rows('blobs'), await objects()]).toEqual([0, []]);
  });

  it('takes a used file out of the queue of files to remove', async () => {
    await publish(token, { 'index.html': 'x' });
    await sql('UPDATE blobs SET unreferenced_at=1');
    await cleanUp(env);
    expect(await one('SELECT unreferenced_at u FROM blobs')).toEqual({ u: null });
    expect(await objects()).toHaveLength(1);
  });

  it('answers 409 when a file to reuse is removed while the publish starts', async () => {
    await publish(token, { 'index.html': 'x' });
    const body = await manifest({ 'index.html': 'x' });
    const DB = before(() => sql('DELETE FROM version_files', 'DELETE FROM blobs'), (q) => q.includes('INSERT INTO uploads'));
    expect(await code(await call('/v1/projects/one/pages/other/versions', { method: 'POST', token, json: body, idem: 'x' }, { DB }))).toEqual([409, 'conflict']);
    expect(await rows('uploads')).toBe(0);
  });

  it('stores nothing when R2 fails, and the file can be sent again', async () => {
    const large = new Uint8Array(2_000_000).fill(97);
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': large })));
    const FILES = new Proxy(env.FILES, { get: (target, name) => (name === 'put' ? async () => { throw new Error('R2 is down'); } : Reflect.get(target, name)) });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await call(`/v1/uploads/${uploadId}/blobs/${await sha(large)}`, { method: 'PUT', token, body: large }, { FILES })).status).toBe(500);
    } finally { log.mockRestore(); }
    expect(await rows('blobs')).toBe(0);
    expect((await put(token, uploadId, large)).status).toBe(204);
  });
});

describe('what a publish may hold', () => {
  const bad: [string, (m: Awaited<ReturnType<typeof manifest>> & Record<string, unknown>) => void][] = [
    ['no files', (m) => { m.files = []; }],
    ['501 files', (m) => { m.files = Array.from({ length: 501 }, (_, i) => ({ path: `${i}.html`, sha256: 'a'.repeat(64), bytes: 1 })); m.entry = '0.html'; }],
    ['a file of 25 MB and one byte', (m) => { m.files[0]!.bytes = 26_214_401; }],
    ['a negative size', (m) => { m.files[0]!.bytes = -1; }],
    ['a size that is not whole', (m) => { m.files[0]!.bytes = 1.5; }],
    ['an uppercase hash', (m) => { m.files[0]!.sha256 = 'A'.repeat(64); }],
    ['one path twice', (m) => { m.files.push({ ...m.files[0]! }); }],
    ['one hash with two sizes', (m) => { m.files.push({ ...m.files[0]!, path: 'b.html', bytes: 2 }); }],
    ['an entry that is not listed', (m) => { m.entry = 'other.html'; }],
    ['an entry that is not HTML', (m) => { m.files[0]!.path = 'index.css'; m.entry = 'index.css'; }],
    ['no title on a new page', (m) => { m.page = {} as never; }],
    ['a blank title', (m) => { m.page = { title: '  ' }; }],
    ['a title of 201 characters', (m) => { m.page = { title: 'ب'.repeat(201) }; }],
    ['the status decided', (m) => { m.page = { title: 'x', status: 'decided' } as never; }],
    ['21 tags', (m) => { m.page = { title: 'x', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) } as never; }],
    ['a field it does not know', (m) => { m.other = 1; }],
    ['a page field it does not know', (m) => { m.page = { title: 'x', id: 'y' } as never; }],
    ['a base that is not a number', (m) => { m.baseVersion = '0' as never; }],
    ['decisions, for now', (m) => { m.decisions = [{ key: 'k' }]; }],
    ['an empty list of decisions, for now', (m) => { m.decisions = []; }],
    ...['/a.html', 'a//b.html', './a.html', 'a/../b.html', 'a\\b.html', '_lawh/a.html', '_LAWH/a.html', '', 'a\u0000.html', 'é.html', 'x/', '.', '..', `${'a'.repeat(508)}.html`]
      .map((path): [string, (m: Awaited<ReturnType<typeof manifest>>) => void] => [`the path ${JSON.stringify(path.slice(0, 20))}`, (m) => { m.files.push({ path, sha256: 'b'.repeat(64), bytes: 1 }); }]),
    ...['a.pdf', 'a.exe', 'a', 'a.html.php', 'a.sh', 'a.zip'].map((path): [string, (m: Awaited<ReturnType<typeof manifest>>) => void] =>
      [`the type of ${path}`, (m) => { m.files.push({ path, sha256: 'b'.repeat(64), bytes: 1 }); }]),
  ];
  it.each(bad)('refuses %s', async (_, change) => {
    const body = await manifest({ 'index.html': 'x' });
    change(body);
    expect(await code(await start(token, body))).toEqual([422, 'invalid']);
    expect(await rows('uploads')).toBe(0);
  });

  it('takes the largest allowed, and refuses a total over 100 MB', async () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `${i}.html`, sha256: String(i).padStart(64, '0'), bytes: 26_214_400 }));
    const body = await manifest({ 'index.html': 'x' }, { entry: '0.html', page: { title: '𝒳'.repeat(200) } });
    expect((await start(token, { ...body, files: files(4) })).status).toBe(201);
    expect(await code(await start(token, { ...body, files: files(5) }))).toEqual([413, 'too_large']);
    expect((await start(token, { ...body, files: Array.from({ length: 500 }, (_, i) => ({ path: `${i}.html`, sha256: String(i).padStart(64, '0'), bytes: 1 })) })).status).toBe(201);
  });

  it('refuses a body that is not a JSON object, or is too large', async () => {
    for (const body of ['', '{', '[]', 'null', '"x"', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      expect(await code(await call('/v1/projects/one/pages/page/versions', { method: 'POST', token, body, idem: 'x' }))).toEqual([422, 'invalid']);
    }
    expect(await code(await call('/v1/projects/one/pages/page/versions', { method: 'POST', token, body: `{"a":"${'x'.repeat(1_500_000)}"}`, idem: 'x' }))).toEqual([413, 'too_large']);
  });
});

describe('sending a request again', () => {
  it('needs an Idempotency-Key on each write', async () => {
    const body = await manifest({ 'index.html': 'x' });
    for (const headers of [{}, { 'Idempotency-Key': 'x'.repeat(101) }]) {
      expect(await code(await call('/v1/projects/one/pages/page/versions', { method: 'POST', token, json: body, headers }))).toEqual([422, 'invalid']);
    }
  });

  it('gives the same reply and does it once', async () => {
    const body = await manifest({ 'index.html': 'x' });
    const first = await json(await start(token, body, undefined, 'same')), again = await start(token, body, undefined, 'same');
    expect([again.status, await json(again)]).toEqual([201, first]);
    expect(await rows('uploads')).toBe(1);
    await put(token, first.uploadId, 'x');
    const one_ = await json(await commit(token, first.uploadId, 'com')), two = await commit(token, first.uploadId, 'com');
    expect([two.status, await json(two)]).toEqual([200, one_]);
    expect(await rows('page_versions')).toBe(1);
  });

  it('does it once also when both arrive together', async () => {
    const body = await manifest({ 'index.html': 'x' });
    const starts = await Promise.all([1, 2, 3].map(() => start(token, body, undefined, 'same').then(json)));
    expect(new Set(starts.map((s) => s.uploadId)).size).toBe(1);
    await put(token, starts[0].uploadId, 'x');
    const commits = await Promise.all([1, 2, 3].map(() => commit(token, starts[0].uploadId, 'com')));
    expect(commits.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(await rows('page_versions')).toBe(1);
  });

  it('refuses the same key for a different request, and keeps keys of two agents apart', async () => {
    const body = await manifest({ 'index.html': 'x' });
    await start(token, body, undefined, 'same');
    expect(await code(await start(token, { ...body, note: 'y' }, undefined, 'same'))).toEqual([422, 'invalid']);
    expect(await code(await start(token, body, 'two/pages/page', 'same'))).toEqual([422, 'invalid']);
    expect((await start((await makeKey()).token, { ...body, note: 'y' }, undefined, 'same')).status).toBe(201);
  });

  it('checks access again, and forgets after 24 hours', async () => {
    const mona = await makeKey({ agent: 'am', projects: ['p1'] });
    const started = await json(await start(mona.token, await manifest({ 'index.html': 'x' }), undefined, 'same'));
    await put(mona.token, started.uploadId, 'x');
    expect((await commit(mona.token, started.uploadId, 'com')).status).toBe(200);
    await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'");
    expect((await start(mona.token, await manifest({ 'index.html': 'x' }), undefined, 'same')).status).toBe(404);
    expect((await commit(mona.token, started.uploadId, 'com')).status).toBe(404);
    await sql("UPDATE team_members SET level=4, set_by='o' WHERE member_id='m'", 'UPDATE idempotency SET expires_at=1');
    expect((await start(mona.token, await manifest({ 'index.html': 'x' }, { baseVersion: 1 }), undefined, 'same')).status).toBe(201);
  });

  it('records nothing for a refused request', async () => {
    expect((await start(token, await manifest({ 'index.html': 'x' }, { baseVersion: 5 }), undefined, 'same')).status).toBe(409);
    expect((await start(token, await manifest({ 'index.html': 'x' }), undefined, 'same')).status).toBe(201);
  });
});

describe('clean-up', () => {
  const HOUR = 3_600_000;
  it('removes expired uploads and replies, and files nothing uses after a day', async () => {
    const now = Date.now();
    await publish(token, { 'index.html': 'kept' });
    const a = await json(await start(token, await manifest({ 'index.html': 'orphan', 'b.html': 'kept' }, { baseVersion: 1 })));
    await put(token, a.uploadId, 'orphan');
    const live = await json(await start(token, await manifest({ 'index.html': 'live' }), 'two/pages/b'));
    await put(token, live.uploadId, 'live');
    await env.DB.prepare('UPDATE uploads SET expires_at=1 WHERE id=?').bind(a.uploadId).run();
    await cleanUp(env, now);
    expect([await rows('uploads'), await rows('blobs'), (await objects()).length]).toEqual([1, 3, 3]);
    await cleanUp(env, now + 23 * HOUR);
    expect(await rows('blobs')).toBe(3);
    await env.DB.prepare('UPDATE uploads SET expires_at=?').bind(now + 99 * HOUR).run();
    await cleanUp(env, now + 25 * HOUR);
    expect(await rows('blobs')).toBe(2);
    expect((await objects()).length).toBe(2);
    expect(await rows('idempotency')).toBe(0);
    expect((await call('/v1/projects/one/pages/page/versions/1/file?path=index.html', { token })).status).toBe(200);
  });

  it('keeps a file that is used again before the day is over', async () => {
    const now = Date.now();
    const a = await json(await start(token, await manifest({ 'index.html': 'x' })));
    await put(token, a.uploadId, 'x');
    await sql('UPDATE uploads SET expires_at=1');
    await cleanUp(env, now);
    expect(await one('SELECT unreferenced_at u FROM blobs')).toEqual({ u: now });
    const b = await json(await start(token, await manifest({ 'index.html': 'x' })));
    expect(b.missing).toEqual([]);
    expect(await one('SELECT unreferenced_at u FROM blobs')).toEqual({ u: null });
    await env.DB.prepare('UPDATE uploads SET expires_at=?').bind(now + 99 * HOUR).run();
    await cleanUp(env, now + 25 * HOUR);
    expect((await commit(token, b.uploadId)).status).toBe(200);
  });
});
