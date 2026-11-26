import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { matchOf } from '../../src/app/search';
import { normalize, visibleText, words } from '../../src/app/search/text';
import { call, code, json, makeKey, one, publish, seed, sql } from './api/helpers';
import { api as app, enter } from './people/helpers';

let token: string;
beforeEach(async () => { await seed(); ({ token } = await makeKey()); });
const html = (body: string, title = '') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const put = async (slug: string, body: string, page: object = {}, project = 'one', extra: object = {}) => {
  const response = await publish(token, { 'index.html': html(body) }, { page: { title: slug, ...page }, ...extra }, `${project}/pages/${slug}`);
  expect(response.status).toBe(200);
  return (await json(response)).id as string;
};
const find = async (q: string, query = '', by = token) => ((await json(await call(`/v1/pages?q=${encodeURIComponent(q)}${query}`, { token: by }))).items as { slug: string }[]).map((p) => p.slug).join();
const text = (source: string) => visibleText(new Response(source).body!);

describe('text', () => {
  it.each([
    ['مَرْحَباً', 'مرحبا'], ['أحمد إيمان آمال ٱلله', 'احمد ايمان امال الله'], ['مستشفى علي علی', 'مستشفي علي علي'], ['مدرسة', 'مدرسه'], ['كتاب کتاب', 'كتاب كتاب'], ['٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹', '0123456789 0123456789'],
    ['كـــلمة', 'كلمه'], ['ﻣﺮﺣﺒﺎ', 'مرحبا'], ['a‏b­c﻿', 'abc'], ['Café ＡＢＣ', 'Café ABC'],
  ])('%s is %s', (from, to) => { expect(normalize(from)).toBe(to); });

  it.each([
    ['<p>One</p><p>two</p>', 'One two'], ['<b>bo</b>ld', 'bold'], ['a<br>b', 'a b'], ['<script>var x="no"</script><style>.no{}</style><template>no</template><noscript>no</noscript>yes', 'yes'],
    ['<p hidden>secret</p><div style="color:red; display: none">gone</div><span hidden="until-found">found</span> ok', 'found ok'],
    ['<p hidden>hiddenword<p>visibleword</p>', 'visibleword'],
    ['<div hidden><p hidden>a<p>b</p></div>c', 'c'],
    ['<ul><li hidden>a<li>b</ul><dl><dt hidden>x<dd>y</dl><div><p hidden>z</div>w', 'b y w'],
    ['<img hidden src="x">shown<input hidden value="1">too', 'shown too'],
    ['<p style="display:none; display:block">shown</p><p style="display:none !important; display:block">gone</p><p style="display:none !important; display:flex !important">back</p><p style="content: \'; display: none\'">kept</p>', 'shown back kept'],
    ['Caf&eacute; h&aacute;&ccaron;ek &frac12; Tom &amp; Jerry &lt;3 &#1605;&#x631;&nbsp;x &unknown; &toString; &#0; &#xD800;', 'Café háček ½ Tom & Jerry <3 مر x &unknown; &toString;'], ['<title>T</title><h1>H</h1>', 'T H'], ['<svg><style/><text>in a chart</text></svg> after', 'in a chart after'], ['<!-- no -->yes', 'yes'],
    ['<div><script>1</script>a<script>2</script>b</div>', 'ab'], ['<p title="no">x', 'x'], ['', ''],
  ])('reads %s as %s', async (source, expected) => { expect(await text(source)).toBe(expected); });

  it('stops after 200 KB of UTF-8 text and 3 MB of HTML, wherever that is', async () => {
    expect(await text(`<p>${'word '.repeat(100_000)}</p>`)).toHaveLength(199_999);
    expect(await text(`${' '.repeat(205_000)}<p>after</p>`)).toBe('after');
    expect(await text(`<p>before${' '.repeat(205_000)}after</p>`)).toBe('before after');
    expect(await text(`<script>${'x'.repeat(3_500_000)}</script><p>far</p>`)).toBe('');
    const ar = await text(`<p>${'م'.repeat(1_700_000)}`);
    expect(new TextEncoder().encode(ar).byteLength).toBe(200_000);
    expect(ar).toHaveLength(100_000);
    const emoji = await text(`<p>${'😀'.repeat(150_000)}`);
    expect(new TextEncoder().encode(emoji).byteLength).toBe(200_000);
    expect(emoji.isWellFormed()).toBe(true);
  });

  it('finds an entity cut between two chunks or across the 64 KB buffer split', async () => {
    const parts = ['<p>a &am', 'p; b</p>'].map((part) => new TextEncoder().encode(part));
    expect(await visibleText(new ReadableStream({ pull(c) { const next = parts.shift(); if (next) c.enqueue(next); else c.close(); } }))).toBe('a & b');
    const pad = 'a'.repeat(65_534), split = [`<p>${pad}&am`, 'p; tail</p>'].map((part) => new TextEncoder().encode(part));
    expect((await visibleText(new ReadableStream({ pull(c) { const next = split.shift(); if (next) c.enqueue(next); else c.close(); } }))).endsWith('a& tail')).toBe(true);
    const longPad = 'a'.repeat(65_520), longSplit = [`<p>${longPad}&CounterClockwise`, 'ContourIntegral; end</p>'].map((part) => new TextEncoder().encode(part));
    expect((await visibleText(new ReadableStream({ pull(c) { const next = longSplit.shift(); if (next) c.enqueue(next); else c.close(); } }))).endsWith('a∳ end')).toBe(true);
  });

  it('makes words of a search, keeping every word typed', () => {
    expect(words('stor cost')).toBe('"stor"* AND "cost"*');
    expect(words('a"b')).toBe('"a""b"*');
    for (const nothing of ['', '  ', '"', '*', '- ^ () : {} \u0000']) expect(words(nothing), nothing).toBeNull();
    expect(words('a b c d e f g h i j k l')!.split(' AND ')).toHaveLength(12);
    expect(matchOf('x', { projects: [], status: null, tag: null })).toBeNull();
  });
});

describe('what is found', () => {
  it('title, summary, tags and the text of the page, by the start of each word', async () => {
    await put('a', '<h1>Moving photos</h1><p>Copy each one once.</p>', { title: 'Storage options', summary: 'Compared by monthly cost', tags: ['infra-v2', 'صور'] });
    await put('b', 'Weather');
    for (const q of ['storage', 'STOR', 'option', 'monthly', 'moving phot', 'copy storage', 'infra', 'infra-v2', 'v2', 'صور', 'once']) expect(await find(q), q).toBe('a');
    for (const q of ['torage', 'moving weather', 'nothing', '   ', '"', 'h1', 'doctype']) expect(await find(q), q).toBe('');
    expect(await find('we')).toBe('b');
  });

  it('Arabic, however it is written', async () => {
    await put('ar', '<p>تَخزينُ الصُّوَرِ في المدرسة ٢٠٢٦، إلى مستشفى أحمد</p>', { title: 'خيارات' });
    for (const q of ['تخزين', 'الصور', 'المدرسه', 'المدرسة', '2026', '٢٠٢٦', '۲۰۲۶', 'مستشفي', 'احمد', 'أحمد', 'الي', 'خيار']) expect(await find(q), q).toBe('ar');
  });

  it('accents and case don’t matter', async () => {
    await put('c', 'Crème brûlée, Straße');
    for (const q of ['creme', 'BRÛLÉE', 'brulee', 'straße']) expect(await find(q), q).toBe('c');
  });

  it('filters apply before the limit: project, status and tag, together', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `pag_${String(i).padStart(26, '0')}`);
    await put('old', 'storage', { tags: ['api'], status: 'in_review' }, 'two');
    await env.DB.batch(many.flatMap((id, i) => [
      env.DB.prepare("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES(?,'p1',?,'storage','ao',1,1)").bind(id, `x${i}`), env.DB.prepare('INSERT INTO pages_fts_map(page_id) VALUES(?)').bind(id),
      env.DB.prepare("INSERT INTO pages_fts(rowid,scope,title,summary,tags,body) SELECT rowid,?,'storage','','','' FROM pages_fts_map WHERE page_id=?").bind(`p${Array.from('p1', (c) => c.charCodeAt(0).toString(16)).join('')} s6472616674`, id)]));
    expect((await find('storage', '&limit=100')).split(',')).toHaveLength(100);
    for (const query of ['&project=two', '&status=in_review', '&tag=api', '&project=two&status=in_review&tag=api']) expect(await find('storage', query), query).toBe('old');
    for (const query of ['&project=one&tag=api', '&status=archived', '&tag=ap', '&tag=api-v2']) expect(await find('storage', query), query).toBe('');
    expect((await find('storage', '&limit=5')).split(',')).toHaveLength(5);
    // Search paginates cleanly with a cursor without repeating or truncating.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { slug: string }[]; next: string | null } = await json(await call(`/v1/pages?q=storage&limit=40${cursor ? `&cursor=${cursor}` : ''}`, { token }));
      seen.push(...page.items.map((p) => p.slug));
      cursor = page.next;
    } while (cursor);
    expect(seen).toHaveLength(121);
    expect(new Set(seen).size).toBe(121);
    expect(await find('p7031')).toBe('');
  });

  it('requires every word even past ten, backfills pre-S9 pages on PATCH, and never reuses deleted rowids', async () => {
    await put('ten', 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10');
    expect(await find('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10')).toBe('ten');
    expect(await find('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11')).toBe('');
    // Simulate a page published before S9 (no FTS rows yet).
    const pre = await put('legacy', 'vintage body');
    await sql(`DELETE FROM pages_fts WHERE rowid=(SELECT rowid FROM pages_fts_map WHERE page_id='${pre}')`, `DELETE FROM pages_fts_map WHERE page_id='${pre}'`);
    expect(await find('vintage')).toBe('');
    expect((await call('/v1/projects/one/pages/legacy', { method: 'PATCH', token, json: { summary: 'Refreshed' }, idem: 'pre' })).status).toBe(200);
    expect(await find('vintage')).toBe('legacy');
    expect(await find('refreshed')).toBe('legacy');
    // Deleting the highest rowid and PATCHing an earlier page allocates a strictly higher rowid.
    const high = (await one<{ rowid: number }>(`SELECT rowid FROM pages_fts_map WHERE page_id='${pre}'`))!.rowid;
    await sql(`DELETE FROM pages_fts WHERE rowid=${high}`, `DELETE FROM pages_fts_map WHERE rowid=${high}`);
    expect((await call('/v1/projects/one/pages/ten', { method: 'PATCH', token, json: { summary: 'Moved' }, idem: 'mov' })).status).toBe(200);
    const moved = (await one<{ rowid: number }>("SELECT m.rowid FROM pages_fts_map m JOIN pages p ON p.id=m.page_id WHERE p.slug='ten'"))!.rowid;
    expect(moved).toBeGreaterThan(high);
  });

  it('newest change first', async () => {
    await put('a', 'storage'); await put('b', 'storage'); await put('c', 'storage');
    expect(await find('storage')).toBe('c,b,a');
    await call('/v1/projects/one/pages/a', { method: 'PATCH', token, json: { summary: 'New' }, idem: '1' });
    expect(await find('storage')).toBe('a,c,b');
    await put('b', 'storage again', {}, 'one', { baseVersion: 1 });
    expect(await find('storage')).toBe('b,a,c');
  });

  it('a new version replaces the text; new details keep it', async () => {
    await put('a', 'alpha', { title: 'First', tags: ['one'] });
    await put('a', 'beta', { title: 'Second' }, 'one', { baseVersion: 1 });
    expect([await find('alpha'), await find('first'), await find('beta'), await find('second'), await find('one')]).toEqual(['', '', 'a', 'a', 'a']);
    await call('/v1/projects/one/pages/a', { method: 'PATCH', token, json: { title: 'Third', tags: ['two'], status: 'in_review' }, idem: '1' });
    expect([await find('second'), await find('one'), await find('beta'), await find('third'), await find('two'), await find('beta', '&status=in_review'), await find('beta', '&status=draft'), await find('beta', '&tag=two'), await find('beta', '&tag=one')])
      .toEqual(['', '', 'a', 'a', 'a', 'a', '', 'a', '']);
    expect(await one('SELECT (SELECT COUNT(*) FROM pages_fts) f, (SELECT COUNT(*) FROM pages_fts_map) m')).toEqual({ f: 1, m: 1 });
  });

  it('an answer that decides a page changes its status in the index, and no other answer touches it', async () => {
    await put('a', 'storage', { status: 'in_review' }, 'one', { decisions: ['x', 'y'].map((key) => ({ key, question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })) });
    await put('b', 'storage');
    const { cookie } = await enter('o');
    const row = async () => (await one<{ rowid: number }>("SELECT m.rowid FROM pages_fts_map m JOIN pages p ON p.id=m.page_id WHERE p.slug='a'"))!.rowid, before = await row();
    const { items } = await json(await app('GET', '/decisions', { cookie }));
    const answer = (d: { id: string }) => app('POST', `/decisions/${d.id}/answers`, { cookie, body: { revision: 1, seq: 0, optionId: 'a' } });
    await answer(items[0]);
    expect([await row(), await find('storage', '&status=in_review')]).toEqual([before, 'a']);
    await answer(items[1]);
    expect([await find('storage', '&status=in_review'), await find('storage', '&status=decided'), await find('storage')]).toEqual(['', 'a', 'a,b']);
    expect(await one('SELECT COUNT(*) n FROM pages_fts f JOIN pages_fts_map m ON m.rowid=f.rowid')).toEqual({ n: 2 });
  });

  it('only what the caller sees: an agent by its key, a person by their teams', async () => {
    await put('a', 'storage'); await put('b', 'storage', {}, 'two'); await put('c', 'storage', {}, 'three');
    expect(await find('storage', '', (await makeKey({ projects: ['p1', 'p3'] })).token)).toBe('c,a');
    expect(await find('storage', '', (await makeKey({ projects: [] })).token)).toBe('');
    expect(await find('storage', '', (await makeKey({ agent: 'am', projects: ['p1'] })).token)).toBe('a');
    expect(await code(await call('/v1/pages?q=storage&project=three', { token: (await makeKey({ projects: ['p1'] })).token }))).toEqual([404, 'not_found']);
    const seen = async (cookie: string) => (await json(await app('GET', '/pages?q=storage', { cookie }))).items.map((p: { slug: string }) => p.slug).join();
    expect(await seen((await enter('o')).cookie)).toBe('c,b,a');
    const { cookie } = await enter('m');
    expect(await seen(cookie)).toBe('b,a');
    await sql("DELETE FROM team_members WHERE member_id='m'");
    expect(await seen(cookie)).toBe('');
    await sql("UPDATE pages SET deleted_at=1 WHERE slug='a'");
    expect(await find('storage')).toBe('c,b');
  });

  it('anything can be typed', async () => {
    await put('a', 'storage');
    const odd = ['"', '""', "'", '*', '(', ')', 'AND', 'OR storage', 'NOT', 'NEAR(storage)', 'title:storage', '{title}:x', '^storage', 'stor*', 'a-b', '-', ':', '\\', '%', '\u0000', '😀', 'scope:x', 'x"y*z', '"storage', 'storage"', 'ﷺ', '日本', '\uD800'];
    for (const q of odd) expect((await call(`/v1/pages?q=${encodeURIComponent(q.toWellFormed())}`, { token })).status, q).toBe(200);
    expect(await find('"storage')).toBe('a');
    expect(await code(await call(`/v1/pages?q=${'x'.repeat(101)}`, { token }))).toEqual([422, 'invalid']);
  });

  it('a search reads the index, not the pages', async () => {
    for (let i = 0; i < 20; i++) await put(`p${i}`, i === 3 ? 'needle' : 'hay');
    const result = await env.DB.prepare('SELECT p.id FROM pages_fts f CROSS JOIN pages_fts_map m ON m.rowid = f.rowid CROSS JOIN pages p ON p.id = m.page_id AND p.deleted_at IS NULL WHERE pages_fts MATCH ? ORDER BY f.rowid DESC LIMIT 30')
      .bind(matchOf('needle', { projects: null, status: null, tag: null })).run();
    expect(result.results).toHaveLength(1);
    expect(result.meta.rows_read).toBeLessThan(15);
  });

  it('a publish of 4,000 words writes far fewer rows than the cost table assumes', async () => {
    const long = Array.from({ length: 4000 }, (_, i) => `word${i * 7919 % 2500} `).join('');
    let written = 0;
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { const results = await target.batch(statements); written += results.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0); return results; };
    } });
    const { manifest, sha } = await import('./api/helpers');
    const source = html(long), started = await json(await call('/v1/projects/one/pages/long/versions', { method: 'POST', token, json: await manifest({ 'index.html': source }), idem: 'a' }, { DB }));
    await call(`/v1/uploads/${started.uploadId}/blobs/${await sha(source)}`, { method: 'PUT', token, body: source }, { DB });
    await call(`/v1/uploads/${started.uploadId}/commit`, { method: 'POST', token, idem: 'b' }, { DB });
    // 44 when this was written; docs/spec/README.md section 11 assumes 400.
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(100);
  });
});
