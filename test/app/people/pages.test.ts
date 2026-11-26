import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { peopleRoutes } from '../../../src/app/people/router';
import { readContentToken } from '../../../src/shared/contentToken';
import { api, call, code, enter, json, seed, sql } from './helpers';

const VERSIONS = ['1', '2', '3'].map((n) => `ver_${n.repeat(26)}`);

/** Projects p1 to p3; team t1 has p1 and p2, t2 has p1. Pages a (p1, 3 versions), b (p2), c (p3), d (p1, deleted). */
beforeEach(async () => {
  await seed();
  await sql(
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1),('p3','three','Three','ثلاثة',1)",
    "INSERT INTO teams(id,name,created_at) VALUES('t2','Ops',1)", "INSERT INTO team_projects(team_id,project_id) VALUES('t1','p1'),('t1','p2'),('t2','p1')",
    "UPDATE members SET joined_at=1 WHERE id='o'", "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)", "INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('k','a','h','[]',1,9)",
    ...['a:p1:draft', 'b:p2:in_review', 'c:p3:draft', 'd:p1:draft'].map((s) => { const [slug, project, status] = s.split(':'); return `INSERT INTO pages(id,project_id,slug,title,summary,status,created_by,created_at,updated_at) VALUES('${slug}','${project}','${slug}','Page ${slug}','S','${status}','a',1,1)`; }),
    ...VERSIONS.map((id, i) => `INSERT INTO page_versions VALUES('${id}','a',${i + 1},'in dex.html','note ${i + 1}',1,1,'a','k',${i + 10})`),
    ...['b', 'c', 'd'].map((page, i) => `INSERT INTO page_versions VALUES('ver_${String(i + 4).repeat(26)}','${page}',1,'index.html','',1,1,'a','k',${i + 20})`),
    "INSERT INTO page_tags VALUES('a','alpha','p1',1),('a','beta','p1',1),('b','alpha','p2',1),('c','gamma','p3',1),('b','عربي','p2',1)",
    "UPDATE pages SET deleted_at=1 WHERE id='d'",
  );
});
const member = async (...levels: [team: string, level: number][]) => {
  const { cookie } = await enter('m');
  for (const [team, level] of levels) await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('${team}','m',${level},'o',1)`);
  return cookie;
};
const slugs = async (cookie: string, query = ''): Promise<string> => (await json(await api('GET', `/pages${query}`, { cookie }))).items.map((p: { slug: string }) => p.slug).sort().join();

describe('what a person sees', () => {
  it('the owner sees every project and page', async () => {
    const { cookie } = await enter('o');
    expect((await json(await api('GET', '/projects', { cookie }))).items).toEqual([
      { slug: 'one', name: { en: 'One', ar: 'واحد' }, level: 5 }, { slug: 'three', name: { en: 'Three', ar: 'ثلاثة' }, level: 5 }, { slug: 'two', name: { en: 'Two', ar: 'اثنان' }, level: 5 }]);
    expect(await slugs(cookie)).toBe('a,b,c');
  });

  it('a member sees only the projects of their teams, at the highest level', async () => {
    const cookie = await member(['t1', 1], ['t2', 3]);
    expect((await json(await api('GET', '/projects', { cookie }))).items.map((p: { slug: string; level: number }) => [p.slug, p.level])).toEqual([['one', 3], ['two', 1]]);
    expect(await slugs(cookie)).toBe('a,b');
    expect(await slugs(cookie, '?project=two')).toBe('b');
    expect(await code(await api('GET', '/pages?project=three', { cookie }))).toEqual([404, 'not_found']);
    expect(await code(await api('GET', '/pages?project=nope', { cookie }))).toEqual([404, 'not_found']);
  });

  it('a member of no team sees nothing', async () => {
    const cookie = await member();
    expect((await json(await api('GET', '/projects', { cookie }))).items).toEqual([]);
    expect(await slugs(cookie)).toBe('');
    expect((await json(await api('GET', '/tags', { cookie }))).items).toEqual([]);
  });

  it('every route with a project answers 404 without a level, and works from viewer up', async () => {
    const paths = ['/projects/one/pages/a', '/projects/one/pages/a/versions', '/pages?project=one', '/tags?project=one'];
    // Each route is either tested here or about nothing in a project: a new one must be put in one of the lists.
    const without = ['/me', '/sessions/current', `/sessions/${'0'.repeat(64)}`, '/switches/instance', '/sessions', '/passkeys', '/passkeys/options', '/passkeys/a', '/projects', '/device/look', '/device/approve',
      // In decisions.test.ts, at every level.
      '/decisions', '/decisions/count', `/decisions/dec_${'0'.repeat(26)}`, `/decisions/dec_${'0'.repeat(26)}/answers`, '/projects/one/pages/a/decisions',
      // In manage.test.ts, at every level.
      '/projects/one', '/projects/one/pages/a/status', '/deleted', `/deleted/pag_${'0'.repeat(26)}/restore`, '/agents', `/agents/agt_${'0'.repeat(26)}/off`, '/agent-keys', `/agent-keys/key_${'0'.repeat(26)}`, '/settings', '/settings/retention', '/export', '/export/rows', '/export/files',
      // In comments.test.ts, at every level.
      '/comments', '/projects/one/pages/a/comments', `/comments/cmt_${'0'.repeat(26)}`, `/comments/cmt_${'0'.repeat(26)}/replies`, `/comments/cmt_${'0'.repeat(26)}/resolved`,
      // In webhooks.test.ts, at every level.
      '/switches/webhooks', '/settings/webhook-hosts', '/webhooks', `/webhooks/whk_${'0'.repeat(26)}`, `/webhooks/whk_${'0'.repeat(26)}/deliveries/1/resend`,
      // In connect.test.ts, at every level.
      '/connect/look', '/connect/answer'];
    for (const route of peopleRoutes.filter((r) => r.who === 'person')) {
      expect([...paths, ...without].some((p) => route.path.test(`/app-api${p.split('?')[0]!}`)), route.path.source).toBe(true);
    }
    const cookie = await member();
    for (const path of paths) expect(await code(await api('GET', path, { cookie })), path).toEqual([404, 'not_found']);
    await sql("INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',1,'o',1)");
    for (const level of [1, 2, 3, 4]) {
      await sql(`UPDATE team_members SET level=${level}, set_by='o' WHERE member_id='m'`);
      for (const path of paths) expect((await api('GET', path, { cookie })).status, `${path} ${level}`).toBe(200);
      expect((await json(await api('GET', paths[0]!, { cookie }))).level).toBe(level);
    }
    await sql("DELETE FROM team_members WHERE member_id='m'");
    for (const path of paths) expect((await api('GET', path, { cookie })).status, path).toBe(404);
  });
});

describe('lists', () => {
  it.each([['?status=in_review', 'b'], ['?tag=alpha', 'a,b'], ['?tag=alpha&project=two', 'b'], ['?tag=alpha&status=draft', 'a'], ['?tag=%D8%B9%D8%B1%D8%A8%D9%8A', 'b'], ['?tag=gamma', 'c'], ['?project=one', 'a']])('filters %s', async (query, expected) => {
    expect(await slugs((await enter('o')).cookie, query)).toBe(expected);
  });

  it('pages through every row once, for the owner and a member', async () => {
    for (const cookie of [(await enter('o')).cookie, await member(['t1', 1])]) {
      const all = await slugs(cookie), seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: { items: { slug: string }[]; next: string | null } = await json(await api('GET', `/pages?limit=1${cursor ? `&cursor=${cursor}` : ''}`, { cookie }));
        seen.push(...body.items.map((p) => p.slug)); cursor = body.next;
      } while (cursor);
      expect(seen.sort().join()).toBe(all);
    }
  });

  it('gives what a card shows', async () => {
    const { cookie } = await enter('o');
    expect((await json(await api('GET', '/pages?project=one', { cookie }))).items).toEqual([{
      id: 'a', project: { slug: 'one', name: { en: 'One', ar: 'واحد' } }, slug: 'a', title: 'Page a', summary: 'S', lang: 'en', tags: ['alpha', 'beta'], status: 'draft', currentVersion: 3, updatedAt: 12 }]);
  });

  it('refuses bad filters', async () => {
    const { cookie } = await enter('o');
    for (const query of ['?status=gone', '?limit=0', '?cursor=x']) expect(await code(await api('GET', `/pages${query}`, { cookie })), query).toEqual([422, 'invalid']);
  });

  it.each([['', 'alpha,beta,gamma,عربي'], ['?q=al', 'alpha'], ['?q=%D8%B9', 'عربي'], ['?q=zz', ''], ['?project=two', 'alpha,عربي'], ['?project=one&q=b', 'beta']])('lists the tags in use: %s', async (query, expected) => {
    const { cookie } = await enter('o');
    expect((await json(await api('GET', `/tags${query}`, { cookie }))).items.sort().join()).toBe(expected.split(',').sort().join());
  });

  it('lists each tag once and 50 at most, however many pages have it, with no scan', async () => {
    const { cookie } = await enter('o');
    await sql(...Array.from({ length: 60 }, (_, i) => `INSERT INTO page_tags VALUES('a','x${String(i).padStart(2, '0')}','p1',1)`));
    const items = (await json(await api('GET', '/tags?q=x', { cookie }))).items;
    expect(items).toHaveLength(50);
    expect([items[0], items[49]]).toEqual(['x00', 'x49']);
  });

  it('leaves out tags only deleted pages have', async () => {
    const { cookie } = await enter('o');
    await sql("INSERT INTO page_tags VALUES('d','only-deleted','p1',1),('d','alpha','p1',1)");
    for (const query of ['', '?project=one', '?q=only']) expect((await json(await api('GET', `/tags${query}`, { cookie }))).items).not.toContain('only-deleted');
    expect((await json(await api('GET', '/tags?q=al', { cookie }))).items).toEqual(['alpha']);
  });

  it('finds tags of every project, also past the hundredth, with one query for the owner', async () => {
    const { cookie } = await enter('o');
    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<150) INSERT INTO projects(id,slug,name_en,name_ar,created_at) SELECT 'x'||i, 'aa'||printf('%04d',i), 'X', 'X', 1 FROM n").run();
    await sql("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('far','x150','far','F','a',1,1)", "INSERT INTO page_tags VALUES('far','far-away','x150',1)");
    let batches = 0;
    const DB = new Proxy(env.DB, { get(target, name) {
      if (name === 'batch') return (statements: D1PreparedStatement[]) => { batches += statements.length; return target.batch(statements); };
      const value = Reflect.get(target, name) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await json(await api('GET', '/tags?q=far', { cookie }, { DB }))).items).toEqual(['far-away']);
    expect(batches).toBe(1);
  });

  it('keeps the order of the database, and finds tags at the edges of Unicode', async () => {
    const { cookie } = await enter('o');
    const tags = ['Z', 'a', '\u{10FFFF}', '\u{10FFFF}x', '\uD7FFq', '\uE000', `r${'🚀'.repeat(30)}`, '🚀'];
    await env.DB.batch(tags.map((t) => env.DB.prepare("INSERT INTO page_tags VALUES('a',?,'p1',1)").bind(t)));
    const items = async (q: string): Promise<string[]> => (await json(await api('GET', `/tags?q=${encodeURIComponent(q)}`, { cookie }))).items;
    expect((await items('')).filter((t) => tags.includes(t))).toEqual(['Z', 'a', tags[6], '\uD7FFq', '\uE000', '🚀', '\u{10FFFF}', '\u{10FFFF}x']);
    expect(await items('\u{10FFFF}')).toEqual(['\u{10FFFF}', '\u{10FFFF}x']);
    expect(await items('\uD7FF')).toEqual(['\uD7FFq']);
    expect(await items(`r${'🚀'.repeat(20)}`)).toEqual([tags[6]]);
    for (const t of Array.from({ length: 60 }, (_, i) => `A${String(i).padStart(2, '0')}`)) await env.DB.prepare("INSERT INTO page_tags VALUES('a',?,'p1',1)").bind(t).run();
    expect((await items(''))[0]).toBe('A00');
  });

  it('tags of a project a member does not see stay hidden', async () => {
    expect((await json(await api('GET', '/tags', { cookie: await member(['t1', 1]) }))).items).not.toContain('gamma');
  });
});

describe('reading a page', () => {
  it('gives the current version, with an address that opens only it', async () => {
    const page = await json(await api('GET', '/projects/one/pages/a?mode=light&lang=ar', { cookie: await member(['t2', 2]) }));
    expect(page).toMatchObject({ title: 'Page a', level: 2, currentVersion: 3, version: { n: 3, note: 'note 3', publishedBy: 'bot', createdAt: 12 } });
    const url = new URL(page.frame);
    expect([url.origin, url.pathname.split('/')[2], url.search]).toEqual([env.CONTENT_ORIGIN, 'in%20dex.html', '?mode=light&lang=ar']);
    expect(await readContentToken(env.CONTENT_KEY as string, url.pathname.split('/')[1]!)).toBe(VERSIONS[2]);
    expect(JSON.stringify(page)).not.toContain(VERSIONS[0]);
    expect(await readContentToken(env.CONTENT_KEY as string, new URL(page.viewer).pathname.split('/')[1]!)).toBe(VERSIONS[2]);
  });

  it('gives an old version when asked', async () => {
    const { cookie } = await enter('o'), page = await json(await api('GET', '/projects/one/pages/a?v=1', { cookie }));
    expect([page.version.n, page.currentVersion]).toEqual([1, 3]);
    expect(await readContentToken(env.CONTENT_KEY as string, new URL(page.frame).pathname.split('/')[1]!)).toBe(VERSIONS[0]);
  });

  it.each(['/projects/one/pages/a?v=4', '/projects/one/pages/a?v=0', '/projects/one/pages/a?v=x', '/projects/one/pages/a?v=-1', '/projects/one/pages/a?v=', '/projects/one/pages/d', '/projects/one/pages/b', '/projects/two/pages/a', '/projects/nope/pages/a', '/projects/one/pages/d/versions'])('answers 404 for %s', async (path) => {
    expect(await code(await api('GET', path, { cookie: (await enter('o')).cookie }))).toEqual([404, 'not_found']);
  });

  it('lists versions, newest first', async () => {
    const { cookie } = await enter('o'), first = await json(await api('GET', '/projects/one/pages/a/versions?limit=2', { cookie }));
    expect(first.items.map((v: { n: number }) => v.n)).toEqual([3, 2]);
    expect((await json(await api('GET', `/projects/one/pages/a/versions?limit=2&cursor=${first.next}`, { cookie }))).items.map((v: { n: number }) => v.n)).toEqual([1]);
  });

  it('ends at once when the person is removed or loses the team', async () => {
    const cookie = await member(['t1', 4]);
    expect((await api('GET', '/projects/two/pages/b', { cookie })).status).toBe(200);
    await sql("DELETE FROM team_projects WHERE project_id='p2'");
    expect((await api('GET', '/projects/two/pages/b', { cookie })).status).toBe(404);
    await sql("UPDATE members SET removed_at=1 WHERE id='m'");
    expect((await api('GET', '/projects/one/pages/a', { cookie })).status).toBe(401);
  });

  it('the address of a page gives the app’s document, and nothing of the page', async () => {
    for (const path of ['/p/one/a', '/p/nope/nope', '/settings', '/settings/agents', '/settings/data']) {
      const response = await call('GET', path);
      expect([response.status, response.headers.get('Content-Type')]).toEqual([200, 'text/html; charset=utf-8']);
      expect(await response.text()).not.toContain('Page a');
    }
    for (const path of ['/p', '/p/one', '/p/one/a/', '/p/ONE/a', '/p/one/a/b', '/settings/', '/settings/nope', '/account']) expect((await call('GET', path)).status, path).toBe(404);
  });
});

it('people’s queries never scan a table, and never sort without an index', async () => {
  const [d1, d2] = [`dec_${'1'.repeat(26)}`, `dec_${'2'.repeat(26)}`];
  await sql(
    "UPDATE projects SET answers_needed=2 WHERE id='p1'",
    `INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES('${d1}','a','p1','k1',0,1,1),('${d2}','a','p1','k2',1,1,2)`,
    `INSERT INTO decision_revisions(decision_id,revision,question,context,options_json,version_id,version_n,created_at) VALUES('${d1}',1,'Q1?','','[{"id":"a","label":"A"},{"id":"b","label":"B"}]','${VERSIONS[0]}',1,1),('${d2}',1,'Q2?','','[{"id":"a","label":"A"},{"id":"b","label":"B"}]','${VERSIONS[0]}',1,1)`,
    `INSERT INTO decision_answers(decision_id,seq,revision,option_id,notes,answered_at,member_id,needed,decides) VALUES('${d1}',1,1,'a','',5,'o',2,0),('${d2}',1,1,'a','',6,'o',2,0)`,
  );
  const seen = new Set<string>();
  const DB = new Proxy(env.DB, { get(target, name) {
    if (name === 'prepare') return (query: string) => { seen.add(query); return target.prepare(query); };
    const value = Reflect.get(target, name) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const cookie of [(await enter('o')).cookie, await member(['t1', 4], ['t2', 1])]) {
    for (const path of ['/me', '/projects', '/sessions', '/passkeys', '/pages', '/pages?project=one', '/pages?tag=alpha', '/pages?status=draft', '/pages?project=one&tag=alpha&status=draft', '/pages?q=a', '/pages?q=a&project=one&tag=alpha&status=draft', '/comments', '/projects/one/pages/a/comments', `/comments/cmt_${'0'.repeat(26)}/replies`, '/decisions', '/decisions?show=waiting', '/decisions?show=answered', '/decisions/count', '/projects/one/pages/a/decisions', `/decisions/${d1}`, '/tags', '/tags?q=a&project=one',
      '/projects/one/pages/a', '/projects/one/pages/a?v=1', '/projects/one/pages/a/versions']) expect((await api('GET', path, { cookie }, { DB })).status, path).toBe(path.includes('000') ? 404 : 200);
  }
  expect(seen.size).toBeGreaterThan(18);
  for (const query of seen) {
    const marks = (query.match(/\?(?!\d)/g) ?? []).length, numbered = Math.max(0, ...[...query.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...Array(marks + numbered).fill(null)).all<{ detail: string }>();
    // The recursive table of the tags list holds at most 51 rows.
    for (const { detail } of results) expect(/^SCAN (?!j\b|json_each\b|CONSTANT ROW|t$|\w+(?: EXISTS)? VIRTUAL TABLE INDEX)/.test(detail) || detail.includes('TEMP B-TREE'), `${detail} | ${query}`).toBe(false);
  }
});
