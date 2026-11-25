import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, code, json, makeKey, one, publish, seed, sql } from './helpers';

let token: string, pageId: string;
const ID = (n: number) => `cmt_${String(n).repeat(26)}`;
const write = (n: number, thread = n, { member = 'o', level = 5, at = n } = {}) =>
  sql(`INSERT INTO comments(id,page_id,project_id,thread_id,version_n,section_id,section_title,quote,member_id,author_level,body,created_at) VALUES('${ID(n)}','${pageId}','p1','${ID(thread)}',1,${n === thread ? "'s-risks','Risks','Moving later'" : 'NULL,NULL,NULL'},'${member}',${level},'Body ${n}',${at})`);
beforeEach(async () => { await seed(); ({ token } = await makeKey()); pageId = (await json(await publish(token, { 'index.html': 'x' }))).id; });
let idem = 0;
const reply = (n: number, body: unknown = { body: 'About 20 minutes.' }, key = `r${idem++}`, by = token) => call(`/v1/comments/${ID(n)}/replies`, { method: 'POST', token: by, json: body, idem: key });
const list = async (query = '') => json(await call(`/v1/pages/${pageId}/comments${query}`, { token }));

describe('reading', () => {
  it('gives each comment with its author, whether they could decide then, and its section', async () => {
    await write(1); await write(2, 1, { member: 'd', level: 3 }); await reply(1);
    const { items, next } = await list();
    expect(next).toBeNull();
    expect(items[0]).toEqual({
      id: ID(1), threadId: ID(1), authorType: 'person', person: { id: 'o', name: 'Owner' }, fromDecider: true, agent: null, versionN: 1, sectionId: 's-risks', sectionTitle: 'Risks', quote: 'Moving later',
      body: 'Body 1', createdAt: 1, resolvedAt: null });
    expect(items[1]).toMatchObject({ threadId: ID(1), person: { id: 'd', name: 'Dina' }, fromDecider: true, sectionId: null });
    expect(items[2]).toMatchObject({ authorType: 'agent', person: null, agent: 'owner-bot', fromDecider: false, body: 'About 20 minutes.' });
    await sql("UPDATE team_members SET level=2, set_by='o' WHERE member_id='d'");
    await write(3, 1, { member: 'd', level: 2, at: 9 });
    const after = (await list()).items;
    expect(after.filter((c: { person: { id: string } | null }) => c.person?.id === 'd').map((c: { fromDecider: boolean }) => c.fromDecider)).toEqual([true, false]);
    // Being promoted later doesn't change what was written before.
    await sql("UPDATE team_members SET level=4, set_by='o' WHERE member_id='d'");
    expect((await list()).items.find((c: { id: string }) => c.id === ID(3)).fromDecider).toBe(false);
  });

  it('pages through every comment once, and leaves out deleted ones', async () => {
    for (const n of [1, 2, 3, 4]) await write(n, n, { at: 5 });
    await sql(`UPDATE comments SET deleted_at=1 WHERE id='${ID(2)}'`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do { const body: { items: { id: string }[]; next: string | null } = await list(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`); seen.push(...body.items.map((c) => c.id)); cursor = body.next; } while (cursor);
    expect(seen).toEqual([ID(1), ID(3), ID(4)]);
    for (const query of ['?limit=0', '?cursor=x']) expect(await code(await call(`/v1/pages/${pageId}/comments${query}`, { token })), query).toEqual([422, 'invalid']);
  });

  it('nothing of a deleted page, of another project, or without the scope', async () => {
    await write(1);
    const { token: other } = await makeKey({ projects: ['p2'] }), { token: blind } = await makeKey({ scopes: ['pages:read', 'decisions:read'] }), { token: reader } = await makeKey({ scopes: ['comments:read'] });
    expect(await code(await call(`/v1/pages/${pageId}/comments`, { token: other }))).toEqual([404, 'not_found']);
    expect(await code(await reply(1, undefined, 'a', other))).toEqual([404, 'not_found']);
    expect(await code(await call(`/v1/pages/${pageId}/comments`, { token: blind }))).toEqual([403, 'forbidden']);
    expect(await code(await reply(1, undefined, 'b', reader))).toEqual([403, 'forbidden']);
    await sql("UPDATE pages SET deleted_at=1");
    expect(await code(await call(`/v1/pages/${pageId}/comments`, { token }))).toEqual([404, 'not_found']);
    expect(await code(await reply(1))).toEqual([404, 'not_found']);
  });
});

describe('replying', () => {
  it('adds to the thread, tells, and happens once', async () => {
    await write(1);
    const first = await reply(1, undefined, 'same');
    expect(first.status).toBe(201);
    const made = await json(first);
    expect(await json(await reply(1, undefined, 'same'))).toEqual(made);
    expect((await list()).items[1]).toEqual(made);
    expect((await env.DB.prepare("SELECT subject_id, actor_type, actor_id FROM events WHERE type='comment.created'").all()).results).toEqual([{ subject_id: made.id, actor_type: 'agent', actor_id: 'ao' }]);
    expect(await code(await reply(1, { body: 'Else' }, 'same'))).toEqual([422, 'invalid']);
  });

  it('only to a thread that is there: not to a reply, a deleted thread, or by starting one', async () => {
    await write(1); await write(2, 1);
    expect(await code(await reply(2))).toEqual([404, 'not_found']);
    expect(await code(await reply(9))).toEqual([404, 'not_found']);
    await sql(`UPDATE comments SET deleted_at=1 WHERE id='${ID(1)}'`);
    expect(await code(await reply(1))).toEqual([404, 'not_found']);
    expect((await call(`/v1/pages/${pageId}/comments`, { token, method: 'POST', json: { body: 'x' }, idem: 'x' })).status).toBe(404);
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect((await call(`/v1/comments/${ID(1)}`, { token, method, json: {}, idem: 'y' })).status).toBe(404);
  });

  it('a thread deleted between the read and the write gets no reply', async () => {
    await write(1);
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { await sql(`UPDATE comments SET deleted_at=1 WHERE id='${ID(1)}'`); return target.batch(statements); };
    } });
    expect(await code(await call(`/v1/comments/${ID(1)}/replies`, { method: 'POST', token, json: { body: 'x' }, idem: 'z' }, { DB }))).toEqual([409, 'conflict']);
    expect(await one("SELECT COUNT(*) n FROM events WHERE type='comment.created'")).toEqual({ n: 0 });
  });

  it.each([[{}], [{ body: '' }], [{ body: '  ' }], [{ body: 5 }], [{ body: 'x'.repeat(10_001) }], [{ body: 'x', resolved: true }]])('refuses %j', async (body) => {
    await write(1);
    expect(await code(await reply(1, body))).toEqual([422, 'invalid']);
  });

  it('refuses a key in the text', async () => {
    await write(1);
    expect(await code(await reply(1, { body: `AKIA${'Z'.repeat(16)}` }))).toEqual([422, 'secret_found']);
  });
});
