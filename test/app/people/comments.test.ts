import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, code, count, enter, json, one, seed, sql } from './helpers';

const ID = (n: number | string) => `cmt_${String(n).repeat(26)}`;

/** Projects p1 and p2 in team t1, p3 in none. Pages a (p1, at version 2), b (p2), c (p3), d (p1, deleted). */
beforeEach(async () => {
  await seed();
  await sql(
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1),('p3','three','Three','ثلاثة',1)",
    "INSERT INTO team_projects(team_id,project_id) VALUES('t1','p1'),('t1','p2')", 'UPDATE members SET joined_at=1', "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)",
    "INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('k','a','h','[]',1,9)",
    ...['a:p1', 'b:p2', 'c:p3', 'd:p1'].map((s) => { const [slug, project] = s.split(':'); return `INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('${slug}','${project}','${slug}','Page ${slug}','a',1,1)`; }),
    ...['a:1', 'a:2', 'b:1', 'c:1', 'd:1'].map((s) => { const [page, n] = s.split(':'); return `INSERT INTO page_versions VALUES('v${page}${n}','${page}',${n},'index.html','',1,1,'a','k',1)`; }),
    "UPDATE pages SET deleted_at=1 WHERE id='d'",
  );
});
const member = async (level: number) => {
  const { cookie } = await enter('m');
  await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',${level},'o',1)`);
  return cookie;
};
const setLevel = (level: number) => sql(`UPDATE team_members SET level=${level}, set_by='o' WHERE member_id='m'`);
const add = (cookie: string, n: number, body: object = {}, page = 'one/pages/a') => api('POST', `/projects/${page}/comments`, { cookie, body: { id: ID(n), body: `Body ${n}`, versionN: 1, ...body } });
const reply = (cookie: string, thread: number, n: number, body: object = {}) => api('POST', `/comments/${ID(thread)}/replies`, { cookie, body: { id: ID(n), body: `Body ${n}`, ...body } });
const resolve = (cookie: string, n: number, resolved: unknown = true) => api('PUT', `/comments/${ID(n)}/resolved`, { cookie, body: { resolved } });
const remove = (cookie: string, n: number) => api('DELETE', `/comments/${ID(n)}`, { cookie });
const threads = async (cookie: string, page = 'one/pages/a', query = '') => json(await api('GET', `/projects/${page}/comments${query}`, { cookie }));
const ids = async (cookie: string) => (await threads(cookie)).items.map((c: { id: string }) => c.id[4]).join('');

describe('writing', () => {
  it('starts a thread on a section, with its author and their level', async () => {
    const { cookie } = await enter('o');
    const response = await add(cookie, 1, { section: { id: 's-risks', title: 'Risks', quote: 'Moving later' } });
    expect(response.status).toBe(200);
    const made = await json(response);
    expect(made).toEqual({
      id: ID(1), threadId: ID(1), authorType: 'person', person: { id: 'o', name: 'Sara' }, fromDecider: true, agent: null, versionN: 1, sectionId: 's-risks', sectionTitle: 'Risks', quote: 'Moving later', body: 'Body 1',
      createdAt: expect.any(Number), resolvedAt: null, mayDelete: true, replies: [], moreReplies: null, mayReply: true, mayResolve: true });
    expect(await threads(cookie)).toEqual({ items: [made], next: null, mayComment: true });
    expect((await env.DB.prepare('SELECT type, subject_id, page_id, project_id, actor_type, actor_id FROM events').all()).results)
      .toEqual([{ type: 'comment.created', subject_id: ID(1), page_id: 'a', project_id: 'p1', actor_type: 'person', actor_id: 'o' }]);
  });

  it('replies go in the thread, in order, and belong to the current version', async () => {
    const { cookie } = await enter('o');
    await add(cookie, 1);
    await reply(cookie, 1, 2);
    const after = await json(await reply(cookie, 1, 3));
    expect(after.replies.map((c: { id: string; versionN: number; mayDelete: boolean }) => [c.id, c.versionN, c.mayDelete])).toEqual([[ID(2), 2, true], [ID(3), 2, true]]);
    expect(await count('events', "type='comment.created'")).toBe(3);
  });

  it('sent again with the same id it is written once; another text or author with that id is refused', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(2);
    const [x, y] = await Promise.all([add(owner, 1), add(owner, 1)]);
    expect([x!.status, y!.status]).toEqual([200, 200]);
    expect(await code(await add(owner, 1, { body: 'Else' }))).toEqual([409, 'conflict']);
    expect(await code(await add(owner, 1, { versionN: 2 }))).toEqual([409, 'conflict']);
    expect(await code(await add(owner, 1, { section: { id: 's-1', title: 'One' } }))).toEqual([409, 'conflict']);
    expect(await code(await add(cookie, 1))).toEqual([409, 'conflict']);
    expect(await code(await reply(owner, 1, 1))).toEqual([409, 'conflict']);
    await reply(cookie, 1, 2);
    // Publishing a new page version does not break an identical retry of a reply.
    await sql("INSERT INTO page_versions VALUES('va3','a',3,'index.html','',1,1,'a','k',1)");
    expect((await reply(cookie, 1, 2)).status).toBe(200);
    expect(await code(await add(cookie, 2, { body: 'Body 2' }))).toEqual([409, 'conflict']);
    expect([await count('comments'), await count('events')]).toEqual([2, 2]);
  });

  it.each([[{ body: '' }], [{ body: ' ' }], [{ body: 'x'.repeat(10_001) }], [{ id: 'x' }], [{ id: undefined }], [{ versionN: 0 }], [{ versionN: 3 }], [{ versionN: '1' }], [{ section: 'x' }], [{ section: { id: '', title: 'T' } }], [{ section: { id: 'a' } }],
    [{ section: { id: 'a', title: 'x'.repeat(201) } }], [{ section: { id: 'a', title: 'T', quote: 'x'.repeat(301) } }], [{ section: { id: 'a', title: 'T', more: 1 } }], [{ more: 1 }]])('refuses %j', async (body) => {
    expect(await code(await add((await enter('o')).cookie, 1, body))).toEqual([422, 'invalid']);
    expect(await count('comments')).toBe(0);
  });

  it('refuses a key in the text, and a version that was pruned', async () => {
    const { cookie } = await enter('o');
    expect(await code(await add(cookie, 1, { body: `AKIA${'Z'.repeat(16)}` }))).toEqual([422, 'secret_found']);
    await sql("DELETE FROM page_versions WHERE id='va1'");
    expect(await code(await add(cookie, 1))).toEqual([422, 'invalid']);
  });

  it.each([
    ['a deleted page', "UPDATE pages SET deleted_at=1 WHERE id='a'", [409, 'conflict']],
    ['a lost level', "DELETE FROM team_members WHERE member_id='m'", [403, 'forbidden']],
    ['a lower level', "UPDATE team_members SET level=1, set_by='o' WHERE member_id='m'", [403, 'forbidden']],
  ])('%s between the read and the write is refused by the database', async (_, change, expected) => {
    const cookie = await member(3);
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { await sql(change); return target.batch(statements); };
    } });
    expect(await code(await api('POST', '/projects/one/pages/a/comments', { cookie, body: { id: ID(1), body: 'x', versionN: 1 } }, { DB }))).toEqual(expected);
    expect([await count('comments'), await count('events')]).toEqual([0, 0]);
  });

  it.each([
    ['demoted decider resolving', 3, 'PUT', `/comments/${ID(1)}/resolved`, { resolved: true }, "UPDATE team_members SET level=2, set_by='o' WHERE member_id='m'", [403, 'forbidden']],
    ['deleted page on resolve', 3, 'PUT', `/comments/${ID(1)}/resolved`, { resolved: true }, "UPDATE pages SET deleted_at=1 WHERE id='a'", [404, 'not_found']],
    ['demoted manager deleting', 4, 'DELETE', `/comments/${ID(1)}`, {}, "UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'", [403, 'forbidden']],
  ])('%s between the read and the write is refused atomically', async (_, startLevel, method, path, body, change, expected) => {
    const owner = (await enter('o')).cookie, cookie = await member(startLevel);
    await add(owner, 1);
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { await sql(change); return target.batch(statements); };
    } });
    expect(await code(await api(method, path, { cookie, body }, { DB }))).toEqual(expected);
    expect(await one(`SELECT resolved_at, deleted_at FROM comments WHERE id='${ID(1)}'`)).toEqual({ resolved_at: null, deleted_at: null });
    expect(await count('events', "type='comment.resolved'")).toBe(0);
  });
});

describe('every level', () => {
  it('who reads, writes, resolves and deletes', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(1);
    await add(owner, 1); await reply(owner, 1, 2);
    const at = async (level: number) => {
      await setLevel(level);
      const list = await threads(cookie), first = list.items.find((c: { id: string }) => c.id === ID(1));
      return {
        may: [list.mayComment, first.mayReply, first.mayResolve, first.mayDelete], add: (await add(cookie, level + 2)).status, reply: (await reply(cookie, 1, 0, { id: `cmt_${'R'.repeat(25)}${level}` })).status,
        resolve: (await resolve(cookie, 1)).status, remove: (await remove(cookie, 2)).status, replies: (await api('GET', `/comments/${ID(1)}/replies`, { cookie })).status,
      };
    };
    expect(await at(1)).toEqual({ may: [false, false, false, false], add: 403, reply: 403, resolve: 403, remove: 403, replies: 200 });
    expect(await at(2)).toEqual({ may: [true, true, false, false], add: 200, reply: 200, resolve: 403, remove: 403, replies: 200 });
    expect(await at(3)).toEqual({ may: [true, true, true, false], add: 200, reply: 200, resolve: 200, remove: 403, replies: 200 });
    expect(await at(4)).toEqual({ may: [true, true, true, true], add: 200, reply: 200, resolve: 200, remove: 204, replies: 200 });
    for (const path of ['/projects/three/pages/c/comments', '/projects/one/pages/d/comments', '/projects/one/pages/nope/comments']) expect(await code(await api('GET', path, { cookie })), path).toEqual([404, 'not_found']);
    await sql("DELETE FROM team_members WHERE member_id='m'");
    for (const [method, path, body] of [['GET', '/projects/one/pages/a/comments', {}], ['POST', '/projects/one/pages/a/comments', { id: ID('X'), body: 'x', versionN: 1 }], ['GET', `/comments/${ID(1)}/replies`, {}], ['POST', `/comments/${ID(1)}/replies`, { id: ID('X'), body: 'x' }],
      ['PUT', `/comments/${ID(1)}/resolved`, { resolved: true }], ['DELETE', `/comments/${ID(1)}`, {}]] as const) expect(await code(await api(method, path, { cookie, body })), path).toEqual([404, 'not_found']);
  });

  it('people resolve and delete their own, and nobody edits', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(2);
    await add(cookie, 1); await reply(owner, 1, 2); await reply(cookie, 1, 3);
    const thread = (await threads(cookie)).items[0];
    expect([thread.mayResolve, thread.mayDelete, thread.replies.map((c: { mayDelete: boolean }) => c.mayDelete)]).toEqual([true, true, [false, true]]);
    expect((await resolve(cookie, 1)).status).toBe(200);
    expect(await code(await remove(cookie, 2))).toEqual([403, 'forbidden']);
    expect((await remove(cookie, 3)).status).toBe(204);
    // A viewer's own comments, from when they could comment, stay.
    await setLevel(1);
    expect(await code(await remove(cookie, 1))).toEqual([403, 'forbidden']);
    expect(await code(await resolve(cookie, 1, false))).toEqual([403, 'forbidden']);
    for (const method of ['PATCH', 'PUT', 'POST']) expect((await api(method, `/comments/${ID(1)}`, { cookie: owner, body: { body: 'x' } })).status).toBe(404);
  });
});

describe('resolving and deleting', () => {
  it('a thread is resolved and opened again, and told once when it is resolved', async () => {
    const { cookie } = await enter('o');
    await add(cookie, 1); await reply(cookie, 1, 2);
    expect((await json(await resolve(cookie, 1))).resolvedAt).toBeGreaterThan(0);
    await resolve(cookie, 1);
    expect(await count('events', "type='comment.resolved'")).toBe(1);
    expect((await json(await resolve(cookie, 1, false))).resolvedAt).toBeNull();
    expect(await count('events', "type='comment.resolved'")).toBe(1);
    await resolve(cookie, 1);
    expect(await count('events', "type='comment.resolved'")).toBe(2);
    expect(await code(await resolve(cookie, 2))).toEqual([404, 'not_found']);
    expect(await code(await resolve(cookie, 1, 'yes'))).toEqual([422, 'invalid']);
  });

  it("deleting a thread's first comment deletes its replies; a reply goes alone", async () => {
    const { cookie } = await enter('o');
    await add(cookie, 1); await reply(cookie, 1, 2); await reply(cookie, 1, 3); await add(cookie, 4);
    expect((await remove(cookie, 2)).status).toBe(204);
    expect((await threads(cookie)).items[1].replies.map((c: { id: string }) => c.id)).toEqual([ID(3)]);
    expect((await remove(cookie, 1)).status).toBe(204);
    expect(await ids(cookie)).toBe('4');
    expect(await count('comments', 'deleted_at IS NOT NULL')).toBe(3);
    for (const response of [await remove(cookie, 1), await remove(cookie, 3), await reply(cookie, 1, 5), await resolve(cookie, 1), await api('GET', `/comments/${ID(1)}/replies`, { cookie })]) expect(response.status).toBe(404);
    // Deleted, not gone: an id is never used again.
    expect(await code(await add(cookie, 1))).toEqual([409, 'conflict']);
  });
});

describe('lists', () => {
  it('a page lists its threads newest first, each once, with its newest 50 replies and the way to earlier ones', async () => {
    const { cookie } = await enter('o');
    const values = (id: string, thread: string, at: number) => `('${id}','a','p1','${thread}',1,'o',5,'x',${at})`;
    const insert = 'INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES';
    const row = (i: number) => `cmt_${String(i).padStart(26, '0')}`;
    await sql(...[1, 2, 3].map((n) => insert + values(ID(n), ID(n), n)), ...Array.from({ length: 120 }, (_, i) => insert + values(row(i), ID(1), 100 + i)));
    expect(await ids(cookie)).toBe('321');
    const first = await threads(cookie, undefined, '?limit=1');
    expect(first.items.map((c: { id: string }) => c.id)).toEqual([ID(3)]);
    const second = await threads(cookie, undefined, `?limit=2&cursor=${first.next}`);
    expect([second.items.map((c: { id: string }) => c.id), second.next]).toEqual([[ID(2), ID(1)], null]);
    const thread = second.items[1], seen = [...thread.replies];
    expect(seen).toHaveLength(50);
    let cursor = thread.moreReplies;
    while (cursor) { const more = await json(await api('GET', `/comments/${ID(1)}/replies?cursor=${cursor}`, { cookie })); seen.unshift(...more.items); cursor = more.next; }
    expect(seen.map((c: { id: string }) => c.id)).toEqual(Array.from({ length: 120 }, (_, i) => row(i)));
  });

  it('open threads of all the projects a person sees, newest first, with their page', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(1);
    await sql(...[[1, 'a', 'p1', 1], [2, 'b', 'p2', 2], [3, 'c', 'p3', 3], [4, 'a', 'p1', 4], [5, 'a', 'p1', 1]].map(([n, page, project, thread]) =>
      `INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('${ID(n!)}','${page}','${project}','${ID(thread!)}',1,'o',5,'x',${n})`));
    const list = async (who: string, query = '') => json(await api('GET', `/comments${query}`, { cookie: who }));
    const all = async (who: string) => (await list(who)).items.map((c: { id: string }) => c.id[4]).join('');
    expect([await all(owner), await all(cookie)]).toEqual(['4321', '421']);
    expect((await list(cookie)).items[2]).toMatchObject({ project: 'one', projectName: { en: 'One', ar: 'واحد' }, page: { slug: 'a', title: 'Page a', lang: 'en' }, mayReply: false, replies: [{ id: ID(5) }] });
    for (const who of [owner, cookie]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do { const body: { items: { id: string }[]; next: string | null } = await list(who, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`); seen.push(...body.items.map((c) => c.id[4]!)); cursor = body.next; } while (cursor);
      expect(seen.join('')).toBe(await all(who));
    }
    await resolve(owner, 4); await remove(owner, 2);
    expect(await all(cookie)).toBe('1');
    await sql("UPDATE pages SET deleted_at=1 WHERE id='a'");
    expect([await all(cookie), await all(owner)]).toEqual(['', '3']);
    await sql("DELETE FROM team_members WHERE member_id='m'");
    expect(await all(cookie)).toBe('');
  });

  it('shows an agent by its name, and a person whose name was cleared without one', async () => {
    const { cookie } = await enter('o');
    await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',2,'o',1)`,
      `INSERT INTO comments(id,page_id,project_id,thread_id,version_n,member_id,author_level,body,created_at) VALUES('${ID(1)}','a','p1','${ID(1)}',1,'m',2,'x',1)`,
      `INSERT INTO comments(id,page_id,project_id,thread_id,version_n,agent_id,body,created_at) VALUES('${ID(2)}','a','p1','${ID(1)}',1,'a','x',2)`, "UPDATE members SET removed_at=1, name=NULL WHERE id='m'");
    const [thread] = (await threads(cookie)).items;
    expect([thread.person, thread.fromDecider, thread.replies[0].authorType, thread.replies[0].agent, thread.replies[0].person]).toEqual([{ id: 'm', name: null }, false, 'agent', 'bot', null]);
  });

  it('refuses bad filters', async () => {
    const { cookie } = await enter('o');
    await add(cookie, 1);
    for (const path of ['/comments', '/projects/one/pages/a/comments']) for (const query of ['limit=0', 'cursor=x']) expect(await code(await api('GET', `${path}?${query}`, { cookie })), path).toEqual([422, 'invalid']);
    expect(await code(await api('GET', `/comments/${ID(1)}/replies?cursor=x`, { cookie }))).toEqual([422, 'invalid']);
    expect(await one('SELECT COUNT(*) n FROM comments')).toEqual({ n: 1 });
  });
});
