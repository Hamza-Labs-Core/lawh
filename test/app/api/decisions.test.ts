import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, code, commit, json, makeKey, manifest, one, publish, put, seed, sql, start } from './helpers';

let token: string, version: number;
beforeEach(async () => { await seed(); ({ token } = await makeKey()); version = 0; });

const OPTIONS = [{ id: 'a', label: 'Object storage', detail: 'In one region.', cost: 'About $2 a month' }, { id: 'b', label: 'Database' }];
const ask = (key: string, change: object = {}) => ({ key, question: `${key}?`, options: OPTIONS, ...change });
/** Publishes the next version with these questions; undefined leaves them out. */
const declare = async (decisions?: object[], page = 'one/pages/page') => {
  const response = await publish(token, { 'index.html': `v${version}` }, { baseVersion: version, page: version === 0 ? { title: 'T' } : {}, ...(decisions && { decisions }) }, page);
  expect(response.status).toBe(200);
  version++;
  return (await json(response)).id as string;
};
const list = async (query = '') => (await json(await call(`/v1/decisions${query}`, { token }))).items as { id: string; key: string; status: string; revision: number; answer: { optionId: string } | null }[];
const states = async () => Object.fromEntries((await list()).map((d) => [d.key, `${d.status} ${d.revision}`]));
const idOf = async (key: string) => (await list()).find((d) => d.key === key)!.id;
let at = 1;
const answer = async (key: string, option: string | null, { member = 'o', notes = '', needed = 1, decides = 1 } = {}) => {
  const row = (await one<{ id: string; revision: number; answer_seq: number; updated_at: number }>('SELECT * FROM decisions WHERE key = ?', key))!;
  await env.DB.prepare('INSERT INTO decision_answers VALUES(?,?,?,?,?,?,?,?,?)').bind(row.id, row.answer_seq + 1, row.revision, option, notes, row.updated_at + at++, member, needed, decides).run();
};
const events = async (type: string) => (await env.DB.prepare('SELECT subject_id, actor_type, actor_id FROM events WHERE type = ?').bind(type).all()).results;

describe('what a page declares', () => {
  it('a new key is open, with everything it was declared with', async () => {
    const pageId = await declare([ask('storage', { context: 'Photos only.' }), ask('second')]);
    const [first] = await list(`?page=${pageId}&status=open&limit=2`).then((items) => items.filter((d) => d.key === 'storage'));
    expect(first).toEqual({
      id: expect.stringMatching(/^dec_/), pageId, project: 'one', key: 'storage', revision: 1, status: 'open', question: 'storage?', context: 'Photos only.', options: OPTIONS,
      answer: null, answersNeeded: 1, agreement: [],
    });
    expect(await one('SELECT version_n, (SELECT n FROM page_versions v WHERE v.id = version_id) n FROM decision_revisions')).toEqual({ version_n: 1, n: 1 });
    expect((await env.DB.prepare('SELECT key FROM decisions ORDER BY position').all()).results).toEqual([{ key: 'storage' }, { key: 'second' }]);
  });

  it('the same wording changes nothing but the order', async () => {
    await declare([ask('x'), ask('y')]);
    const before = await one<{ t: number }>("SELECT updated_at t FROM decisions WHERE key='x'");
    await answer('y', 'a');
    await declare([ask('y'), ask('x')]);
    expect(await states()).toEqual({ x: 'open 1', y: 'answered 1' });
    expect(await one("SELECT updated_at t, position FROM decisions WHERE key='x'")).toEqual({ t: before!.t, position: 1 });
    expect((await events('decision.stale'))).toEqual([]);
  });

  it('a list that is left out keeps the questions; an empty one withdraws them', async () => {
    await declare([ask('x'), ask('y')]);
    await answer('y', 'a');
    await declare();
    expect(await states()).toEqual({ x: 'open 1', y: 'answered 1' });
    await declare([]);
    expect(await states()).toEqual({ x: 'withdrawn 1', y: 'withdrawn 1' });
    expect(await one("SELECT COUNT(*) n FROM decision_answers")).toEqual({ n: 1 });
  });

  it.each([['the question', { question: 'New?' }], ['the context', { context: 'New.' }], ['an option', { options: [OPTIONS[0], { id: 'b', label: 'Other' }] }], ['a cost', { options: [{ ...OPTIONS[0], cost: '$3' }, OPTIONS[1]] }],
    ['the order of the options', { options: [...OPTIONS].reverse() }]])('another wording of %s makes a new revision: open stays open, answered becomes stale', async (_, change) => {
    await declare([ask('x'), ask('y')]);
    await answer('y', 'a');
    await declare([ask('x', change), ask('y', change)]);
    expect(await states()).toEqual({ x: 'open 2', y: 'stale 2' });
    expect(await events('decision.stale')).toEqual([{ subject_id: await idOf('y'), actor_type: 'agent', actor_id: 'ao' }]);
    const old = await json(await call(`/v1/decisions/${await idOf('y')}`, { token }));
    expect(old.answer).toMatchObject({ revision: 1, question: 'y?', optionId: 'a', optionLabel: 'Object storage' });
    expect(old.agreement).toEqual([]);
    // Changed again: still stale, and told once.
    await declare([ask('x', change), ask('y', { question: 'Third?' })]);
    expect(await states()).toEqual({ x: 'open 2', y: 'stale 3' });
    expect(await events('decision.stale')).toHaveLength(1);
  });

  it('a withdrawn key that comes back is answered only with the wording that was answered', async () => {
    await declare([ask('same'), ask('changed'), ask('open'), ask('back')]);
    for (const key of ['same', 'changed', 'back']) await answer(key, 'a');
    await declare([ask('back', { question: 'Other?' })]);
    expect(await states()).toEqual({ same: 'withdrawn 1', changed: 'withdrawn 1', open: 'withdrawn 1', back: 'stale 2' });
    await declare([]);
    await declare([ask('same'), ask('changed', { question: 'Other?' }), ask('open'), ask('back')]);
    expect(await states()).toEqual({ same: 'answered 1', changed: 'open 2', open: 'open 1', back: 'answered 3' });
    expect((await json(await call(`/v1/decisions/${await idOf('back')}`, { token }))).answer).toMatchObject({ revision: 1, question: 'back?' });
  });

  it('a question is written once, also when its commit is sent twice', async () => {
    const { uploadId, missing } = await json(await start(token, await manifest({ 'index.html': 'x' }, { decisions: [ask('x')] })));
    expect(missing).toHaveLength(1);
    await put(token, uploadId, 'x');
    const [a, b] = await Promise.all([commit(token, uploadId, 'same'), commit(token, uploadId, 'same')]);
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(await one('SELECT (SELECT COUNT(*) FROM decisions) d, (SELECT COUNT(*) FROM decision_revisions) r')).toEqual({ d: 1, r: 1 });
  });

  it('a publish that fails changes no question', async () => {
    await declare([ask('x')]);
    const { uploadId } = await json(await start(token, await manifest({ 'index.html': 'late' }, { baseVersion: 1, page: {}, decisions: [] })));
    await put(token, uploadId, 'late');
    await declare();
    expect(await code(await commit(token, uploadId))).toEqual([409, 'conflict']);
    expect(await states()).toEqual({ x: 'open 1' });
  });

  it('50 long questions fit in one publish', async () => {
    await declare(Array.from({ length: 50 }, (_, i) => ask(`k${i}`, { context: 'x'.repeat(4000), options: Array.from({ length: 10 }, (_, o) => ({ id: `o${o}`, label: 'L', detail: 'y'.repeat(2000) })) })).map((d) => ({ ...d })));
    expect(await one("SELECT COUNT(*) n FROM decisions WHERE status='open'")).toEqual({ n: 50 });
  });

  it.each([
    ['not a list', {}], ['too many', Array.from({ length: 51 }, (_, i) => ask(`k${i}`))], ['a key twice', [ask('x'), ask('x')]], ['a key with a space', [ask('a b')]], ['a long key', [ask('x'.repeat(41))]], ['no key', [{ ...ask('x'), key: undefined }]],
    ['no question', [ask('x', { question: ' ' })]], ['a long question', [ask('x', { question: 'x'.repeat(501) })]], ['one option', [ask('x', { options: [OPTIONS[0]] })]], ['eleven options', [ask('x', { options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: 'L' })) })]],
    ['an option twice', [ask('x', { options: [OPTIONS[0], OPTIONS[0]] })]], ['an option without a label', [ask('x', { options: [OPTIONS[0], { id: 'b', label: '' }] })]], ['a field it does not know', [ask('x', { answer: 'a' })]],
    ['an option field it does not know', [ask('x', { options: [OPTIONS[0], { id: 'b', label: 'B', chosen: true }] })]], ['no object', ['x']], ['an option that is no object', [ask('x', { options: ['a', 'b'] })]],
  ])('refuses %s', async (_, decisions) => {
    expect(await code(await start(token, await manifest({ 'index.html': 'x' }, { decisions })))).toEqual([422, 'invalid']);
  });

  it('refuses a question with a key in it', async () => {
    expect(await code(await start(token, await manifest({ 'index.html': 'x' }, { decisions: [ask('x', { context: `AKIA${'Z'.repeat(16)}` })] })))).toEqual([422, 'secret_found']);
  });
});

describe('what an agent reads', () => {
  it('gives an answer with its person, wording and whether it decided, and the history newest first', async () => {
    await declare([ask('x')]);
    await answer('x', null, { notes: 'Later' });
    await answer('x', 'b', { member: 'd', notes: 'Cheaper' });
    const read = await json(await call(`/v1/decisions/${await idOf('x')}`, { token }));
    expect(read).toMatchObject({ status: 'answered', agreement: [{ seq: 1 }, { seq: 2 }], history: [{ seq: 2 }, { seq: 1 }] });
    expect(read.answer).toEqual({
      seq: 2, revision: 1, question: 'x?', optionId: 'b', optionLabel: 'Database', notes: 'Cheaper', answeredAt: expect.any(Number), answeredBy: { id: 'd', name: 'Dina' }, needed: 1, decides: true });
    expect(read.history[1]).toMatchObject({ optionId: null, optionLabel: null, notes: 'Later' });
  });

  it('with two needed, an answer that waits is not the answer, and one whose person left does not count', async () => {
    await sql("UPDATE projects SET answers_needed=2 WHERE id='p1'");
    await declare([ask('x')]);
    await answer('x', 'a', { member: 'd', needed: 2, decides: 0 });
    expect((await list())[0]).toMatchObject({ status: 'open', answer: null, answersNeeded: 2, agreement: [{ optionId: 'a', answeredBy: { id: 'd' }, decides: false }] });
    await sql("DELETE FROM team_members WHERE member_id='d'");
    expect((await list())[0]).toMatchObject({ status: 'open', agreement: [] });
    expect((await json(await call(`/v1/decisions/${await idOf('x')}`, { token }))).history).toHaveLength(1);
  });

  it('lists by status, project and page, each once, oldest change first', async () => {
    const page = await declare([ask('a'), ask('b'), ask('c')]);
    version = 0;
    const other = await declare([ask('z')], 'two/pages/other');
    await answer('b', 'a');
    const keys = async (query: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: { items: { key: string }[]; next: string | null } = await json(await call(`/v1/decisions?limit=1${query}${cursor ? `&cursor=${cursor}` : ''}`, { token }));
        seen.push(...body.items.map((d) => d.key)); cursor = body.next;
      } while (cursor);
      return seen.join();
    };
    expect(await keys(`&page=${page}`)).toBe('a,b,c');
    expect(await keys(`&page=${page}&project=one`)).toBe('a,b,c');
    expect(await keys(`&page=${page}&status=open`)).toBe('a,c');
    expect(await keys(`&page=${other}`)).toBe('z');
    expect((await keys('')).split(',').sort().join()).toBe('a,b,c,z');
    expect(await keys('&project=two')).toBe('z');
    expect(await keys('&status=answered')).toBe('b');
    expect((await keys('&project=one&status=open')).split(',').sort().join()).toBe('a,c');
    ({ token } = await makeKey({ projects: ['p1', 'p2'] }));
    expect((await keys('')).split(',').sort().join()).toBe('a,b,c,z');
    expect(await keys('&status=answered')).toBe('b');
    await sql("UPDATE pages SET deleted_at=1 WHERE slug='page'");
    expect(await keys('')).toBe('z');
    expect(await code(await call(`/v1/decisions?page=${page}`, { token }))).toEqual([404, 'not_found']);
    expect((await call(`/v1/decisions/${(await one<{ id: string }>("SELECT id FROM decisions WHERE key='a'"))!.id}`, { token })).status).toBe(404);
  });

  it('a key sees only the decisions of its projects, and needs its scope', async () => {
    const page = await declare([ask('x')]);
    const id = await idOf('x');
    for (const options of [{ projects: ['p2'] }, { projects: [] }, { agent: 'am' as const, projects: ['p2'] }]) {
      const { token: other } = await makeKey(options);
      expect((await json(await call('/v1/decisions', { token: other }))).items).toEqual([]);
      for (const path of [`/${id}`, '?project=one', `?page=${page}`, `?page=${page}&project=two`]) expect((await call(`/v1/decisions${path}`, { token: other })).status, path).toBe(404);
    }
    const { token: mona } = await makeKey({ agent: 'am', projects: ['p1'] });
    expect((await call(`/v1/decisions/${id}`, { token: mona })).status).toBe(200);
    await sql("UPDATE team_members SET level=3, set_by='o' WHERE member_id='m'");
    expect((await call(`/v1/decisions/${id}`, { token: mona })).status).toBe(404);
    const { token: blind } = await makeKey({ scopes: ['pages:read', 'pages:write', 'comments:read'] });
    for (const path of ['', `/${id}`]) expect(await code(await call(`/v1/decisions${path}`, { token: blind }))).toEqual([403, 'forbidden']);
  });

  it('no agent route answers', async () => {
    await declare([ask('x')]);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const path of ['', '/answers', '/answer']) {
      expect((await call(`/v1/decisions/${await idOf('x')}${path}`, { token, method, json: { optionId: 'a', revision: 1, seq: 0 }, idem: 'x' })).status).toBe(404);
    }
    expect(await code(await call(`/app-api/decisions/${await idOf('x')}/answers`, { token, method: 'POST', json: { optionId: 'a', revision: 1, seq: 0 } }))).toEqual([401, 'unauthorized']);
    expect(await states()).toEqual({ x: 'open 1' });
  });

  it.each(['?status=gone', '?limit=0', '?cursor=x'])('refuses %s', async (query) => { expect(await code(await call(`/v1/decisions${query}`, { token }))).toEqual([422, 'invalid']); });
});
