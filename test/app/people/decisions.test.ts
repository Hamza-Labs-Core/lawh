import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, code, count, enter, json, one, seed, sql } from './helpers';

const ID = (n: number | string) => `dec_${String(n).repeat(26)}`;
const OPTIONS = JSON.stringify([{ id: 'a', label: 'One', cost: '$2' }, { id: 'b', label: 'Two' }]);
const decision = (n: number, page = 'a', project = 'p1') => [
  `INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES('${ID(n)}','${page}','${project}','k${n}',${n},1,${n})`,
  `INSERT INTO decision_revisions(decision_id,revision,question,options_json,version_n,created_at) VALUES('${ID(n)}',1,'Question ${n}?','${OPTIONS}',1,1)`];

/** Projects p1 and p2 in team t1, p3 in none. Page a (p1, in review) asks 1 and 2, page b (p2) asks 3, page c (p3) asks 4. */
beforeEach(async () => {
  await seed();
  await sql(
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1),('p3','three','Three','ثلاثة',1)",
    "INSERT INTO team_projects(team_id,project_id) VALUES('t1','p1'),('t1','p2')", "UPDATE members SET joined_at=1", "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)",
    ...['a:p1:in_review', 'b:p2:draft', 'c:p3:draft'].map((s) => { const [slug, project, status] = s.split(':'); return `INSERT INTO pages(id,project_id,slug,title,status,created_by,created_at,updated_at) VALUES('${slug}','${project}','${slug}','Page ${slug}','${status}','a',1,1)`; }),
    ...decision(1), ...decision(2), ...decision(3, 'b', 'p2'), ...decision(4, 'c', 'p3'),
  );
});
const member = async (level: number) => {
  const { cookie } = await enter('m');
  await sql(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('t1','m',${level},'o',1)`);
  return cookie;
};
const answer = (cookie: string, n: number, body: object = {}) => api('POST', `/decisions/${ID(n)}/answers`, { cookie, body: { revision: 1, seq: 0, optionId: 'a', ...body } });
const shown = async (cookie: string, show = 'open') => (await json(await api('GET', `/decisions?show=${show}`, { cookie }))).items.map((d: { key: string }) => d.key).join();
const pageStatus = async (id = 'a') => (await one<{ status: string }>('SELECT status FROM pages WHERE id = ?', id))!.status;

describe('answering', () => {
  it('records the option and notes with the person, decides, and tells agents', async () => {
    const { cookie } = await enter('o');
    const response = await answer(cookie, 1, { notes: '  Because  ' });
    expect(response.status).toBe(200);
    const after = await json(response);
    expect(after).toMatchObject({ status: 'answered', answerSeq: 1, mayAnswer: true, answersNeeded: 1, answerers: null, page: { slug: 'a', title: 'Page a', lang: 'en', status: 'in_review' }, projectName: { en: 'One', ar: 'واحد' } });
    expect(after.answer).toEqual({ seq: 1, revision: 1, question: 'Question 1?', optionId: 'a', optionLabel: 'One', notes: 'Because', answeredAt: expect.any(Number), answeredBy: { id: 'o', name: 'Sara' }, needed: 1, decides: true });
    expect(after.history).toEqual([after.answer]);
    expect((await env.DB.prepare('SELECT type, subject_id, page_id, project_id, actor_type, actor_id FROM events').all()).results)
      .toEqual([{ type: 'decision.answered', subject_id: ID(1), page_id: 'a', project_id: 'p1', actor_type: 'person', actor_id: 'o' }]);
  });

  it('notes alone answer; nothing at all does not', async () => {
    const { cookie } = await enter('o');
    expect((await answer(cookie, 1, { optionId: null, notes: 'None of these' })).status).toBe(200);
    for (const body of [{ optionId: null }, { optionId: null, notes: '  ' }, { optionId: undefined }, { optionId: 'z' }, { optionId: 5 }, { notes: 5 }, { notes: 'x'.repeat(4001) }, { revision: '1' }, { seq: -1 }, { more: 1 }]) {
      expect(await code(await answer(cookie, 2, body)), JSON.stringify(body)).toEqual([422, 'invalid']);
    }
    expect(await count('decision_answers')).toBe(1);
  });

  it('an answer can be changed; every one is kept', async () => {
    const { cookie } = await enter('o');
    await answer(cookie, 1);
    const after = await json(await answer(cookie, 1, { seq: 1, optionId: 'b' }));
    expect(after.history.map((a: { optionId: string }) => a.optionId)).toEqual(['b', 'a']);
    expect(after.answer.optionId).toBe('b');
  });

  it('an answer to an older wording, or after another answer, is refused and changes nothing', async () => {
    const { cookie } = await enter('o');
    expect(await code(await answer(cookie, 1, { revision: 2 }))).toEqual([409, 'conflict']);
    expect(await code(await answer(cookie, 1, { seq: 1 }))).toEqual([409, 'conflict']);
    await sql(`UPDATE decisions SET status='withdrawn' WHERE id='${ID(1)}'`);
    expect(await code(await answer(cookie, 1))).toEqual([409, 'conflict']);
    await answer(cookie, 2);
    expect(await code(await answer(cookie, 2))).toEqual([409, 'conflict']);
    expect([await count('decision_answers'), await count('events', "type='decision.answered'")]).toEqual([1, 1]);
  });

  it('of two at once, one is recorded and the other is refused', async () => {
    const { cookie } = await enter('o');
    const codes = (await Promise.all([answer(cookie, 1), answer(cookie, 1, { optionId: 'b' })])).map((r) => r.status);
    expect(codes.sort()).toEqual([200, 409]);
    expect([await count('decision_answers'), await count('events')]).toEqual([1, 1]);
  });

  it.each([
    ['a republish', `UPDATE decisions SET revision=2 WHERE id='${ID(1)}'`, [409, 'conflict']],
    ['another answer', `INSERT INTO decision_answers(decision_id,seq,revision,option_id,answered_at,member_id) VALUES('${ID(1)}',1,1,'b',9,'o')`, [409, 'conflict']],
    ['a withdrawal', `UPDATE decisions SET status='withdrawn' WHERE id='${ID(1)}'`, [409, 'conflict']],
    ['a deleted page', "UPDATE pages SET deleted_at=1 WHERE id='a'", [409, 'conflict']],
    ['a lost level', "DELETE FROM team_members WHERE member_id='m'", [403, 'forbidden']],
  ])('%s between the read and the write is refused by the database', async (_, change, expected) => {
    const cookie = await member(3), before = await count('decision_answers');
    const DB = new Proxy(env.DB, { get: (target, key) => {
      if (key !== 'batch') { const value = Reflect.get(target, key) as unknown; return typeof value === 'function' ? (value as () => void).bind(target) : value; }
      return async (statements: D1PreparedStatement[]) => { if (statements.length === 4) await sql(change); return target.batch(statements); };
    } });
    expect(await code(await api('POST', `/decisions/${ID(1)}/answers`, { cookie, body: { revision: 1, seq: 0, optionId: 'a' } }, { DB }))).toEqual(expected);
    expect([await count('decision_answers', "member_id='m'"), await count('events')]).toEqual([before, 0]);
  });

  it('the last open question decides a page in review, and only then', async () => {
    const { cookie } = await enter('o');
    await answer(cookie, 1);
    expect(await pageStatus()).toBe('in_review');
    expect((await json(await answer(cookie, 2))).page.status).toBe('decided');
    expect((await env.DB.prepare("SELECT subject_id, actor_type, actor_id FROM events WHERE type='page.status'").all()).results).toEqual([{ subject_id: 'a', actor_type: 'person', actor_id: 'o' }]);
    expect((await one<{ t: number }>("SELECT updated_at t FROM pages WHERE id='a'"))!.t).toBeGreaterThan(1);
    // A draft stays a draft.
    await answer(cookie, 3);
    expect(await pageStatus('b')).toBe('draft');
    // Back in review: a changed answer decides it again.
    await sql("UPDATE pages SET status='in_review' WHERE id='a'");
    await answer(cookie, 2, { seq: 1, optionId: 'b' });
    expect(await pageStatus()).toBe('decided');
  });

  it('a stale question keeps a page in review; a withdrawn one does not', async () => {
    const { cookie } = await enter('o');
    await sql(`UPDATE decisions SET status='stale' WHERE id='${ID(2)}'`);
    await answer(cookie, 1);
    expect(await pageStatus()).toBe('in_review');
    await sql(`UPDATE decisions SET status='withdrawn' WHERE id='${ID(2)}'`);
    await answer(cookie, 1, { seq: 1 });
    expect(await pageStatus()).toBe('decided');
  });

  it('every level: who sees, and who answers', async () => {
    const cookie = await member(1), paths = [`/decisions/${ID(1)}`, '/projects/one/pages/a/decisions'];
    for (const level of [1, 2, 3, 4]) {
      await sql(`UPDATE team_members SET level=${level}, set_by='o' WHERE member_id='m'`);
      for (const path of paths) expect((await api('GET', path, { cookie })).status, `${path} ${level}`).toBe(200);
      expect((await json(await api('GET', paths[0]!, { cookie }))).mayAnswer).toBe(level >= 3);
      expect(await code(await answer(cookie, 1, { seq: Math.max(0, level - 3) }))).toEqual(level >= 3 ? [200, undefined] : [403, 'forbidden']);
    }
    expect(await code(await answer(cookie, 4))).toEqual([404, 'not_found']);
    expect(await code(await api('GET', `/decisions/${ID(4)}`, { cookie }))).toEqual([404, 'not_found']);
    await sql("DELETE FROM team_members WHERE member_id='m'");
    for (const path of paths) expect((await api('GET', path, { cookie })).status, path).toBe(404);
    expect(await code(await answer(cookie, 1, { seq: 2 }))).toEqual([404, 'not_found']);
    expect((await answer((await enter('o')).cookie, 4)).status).toBe(200);
    expect(await code(await api('GET', `/decisions/${ID(9)}`, { cookie }))).toEqual([404, 'not_found']);
  });

  it('nothing on a deleted page is read or answered', async () => {
    const { cookie } = await enter('o');
    await sql("UPDATE pages SET deleted_at=1 WHERE id='a'");
    expect(await code(await answer(cookie, 1))).toEqual([404, 'not_found']);
    expect((await api('GET', '/projects/one/pages/a/decisions', { cookie })).status).toBe(404);
    expect(await shown(cookie)).toBe('k3,k4');
  });
});

describe('agreement of two people', () => {
  beforeEach(async () => { await sql("UPDATE projects SET answers_needed=2 WHERE id='p1'"); });

  it('one answer waits, the second to the same option decides', async () => {
    const owner = (await enter('o')).cookie, cookie = await member(3);
    const first = await json(await answer(cookie, 1));
    expect(first).toMatchObject({ status: 'open', answer: null, answersNeeded: 2, answerers: 2, agreement: [{ optionId: 'a', decides: false, answeredBy: { id: 'm', name: 'Mona' } }] });
    expect([await shown(cookie), await shown(cookie, 'waiting'), await shown(owner), await shown(owner, 'waiting')]).toEqual(['k2,k3', 'k1', 'k2,k3,k4,k1', '']);
    const apart = await json(await answer(owner, 1, { seq: 1, optionId: 'b' }));
    expect(apart).toMatchObject({ status: 'open', answer: null, agreement: [{ optionId: 'a' }, { optionId: 'b' }] });
    const agreed = await json(await answer(cookie, 1, { seq: 2, optionId: 'b' }));
    expect(agreed).toMatchObject({ status: 'answered', answer: { optionId: 'b', decides: true, needed: 2, answeredBy: { id: 'm' } } });
    expect((await env.DB.prepare('SELECT type FROM events ORDER BY seq').all()).results.map((e) => e.type)).toEqual(['decision.vote', 'decision.vote', 'decision.answered']);
    // Alone, someone who changes their mind reopens nothing.
    expect(await json(await answer(owner, 1, { seq: 3, optionId: 'a' }))).toMatchObject({ status: 'answered', answer: { optionId: 'b', seq: 3 } });
  });

  it('needs an option, and an answer that waits decides no page', async () => {
    const { cookie } = await enter('o');
    expect(await code(await answer(cookie, 1, { optionId: null, notes: 'x' }))).toEqual([422, 'invalid']);
    await sql(`UPDATE decisions SET status='answered' WHERE page_id='a'`);
    await answer(cookie, 1);
    expect(await pageStatus()).toBe('in_review');
  });

  it('does not count a person who may no longer answer', async () => {
    const cookie = await member(3), owner = (await enter('o')).cookie;
    await answer(cookie, 1);
    await sql("UPDATE team_members SET level=2, set_by='o' WHERE member_id='m'");
    expect(await json(await answer(owner, 1, { seq: 1 }))).toMatchObject({ status: 'open', agreement: [{ answeredBy: { id: 'o' } }], answerers: 1 });
  });
});

describe('the lists', () => {
  it('a page lists its questions in its order, then the withdrawn ones that were answered', async () => {
    const { cookie } = await enter('o');
    await sql(...decision(5), ...decision(6), `UPDATE decisions SET status='withdrawn' WHERE id='${ID(6)}'`, `UPDATE decisions SET position=0 WHERE id='${ID(2)}'`);
    await answer(cookie, 5);
    await sql(`UPDATE decisions SET status='withdrawn', position=0 WHERE id='${ID(5)}'`);
    const body = await json(await api('GET', '/projects/one/pages/a/decisions', { cookie }));
    expect(body.items.map((d: { key: string }) => d.key)).toEqual(['k2', 'k1', 'k5']);
    expect(body.answerers).toBeNull();
    expect(body.items[0].history).toBeUndefined();
  });

  it('the open ones are only those the person may answer', async () => {
    expect(await shown((await enter('o')).cookie)).toBe('k1,k2,k3,k4');
    const cookie = await member(3);
    expect(await shown(cookie)).toBe('k1,k2,k3');
    await sql("UPDATE team_members SET level=2, set_by='o' WHERE member_id='m'");
    for (const show of ['open', 'waiting', 'answered']) expect(await shown(cookie, show)).toBe('');
    expect(await json(await api('GET', '/decisions/count', { cookie }))).toEqual({ count: 0, more: false });
  });

  it('answered ones leave the open list, newest first; a stale one is open again', async () => {
    const { cookie } = await enter('o');
    await answer(cookie, 1); await new Promise((r) => setTimeout(r, 3)); await answer(cookie, 3);
    expect([await shown(cookie), await shown(cookie, 'answered')]).toEqual(['k2,k4', 'k3,k1']);
    await sql(`UPDATE decisions SET status='stale' WHERE id='${ID(1)}'`);
    expect([await shown(cookie), await shown(cookie, 'answered')]).toEqual(['k2,k4,k1', 'k3']);
    expect(await json(await api('GET', '/decisions/count', { cookie }))).toEqual({ count: 3, more: false });
  });

  it.each(['open', 'answered'])('pages through every row of %s once, for the owner and a member', async (show) => {
    const owner = (await enter('o')).cookie, cookie = await member(3);
    if (show === 'answered') for (const n of [1, 2, 3]) await answer(owner, n);
    for (const person of [owner, cookie]) {
      const all = await shown(person, show), seen: string[] = [];
      let cursor: string | null = null;
      do {
        const body: { items: { key: string }[]; next: string | null } = await json(await api('GET', `/decisions?show=${show}&limit=1${cursor ? `&cursor=${cursor}` : ''}`, { cookie: person }));
        seen.push(...body.items.map((d) => d.key)); cursor = body.next;
      } while (cursor);
      expect(seen.join()).toBe(all);
    }
  });

  it('counts up to 99', async () => {
    const { cookie } = await enter('o');
    await env.DB.batch(Array.from({ length: 99 }, (_, i) => env.DB.prepare("INSERT INTO decisions(id,page_id,project_id,key,position,created_at,updated_at) VALUES(?,'a','p1',?,1,1,1)").bind(`dec_${i}`, `x${i}`)));
    expect(await json(await api('GET', '/decisions/count', { cookie }))).toEqual({ count: 99, more: true });
  });

  it('refuses bad filters', async () => {
    const { cookie } = await enter('o');
    for (const query of ['show=gone', 'limit=0', 'cursor=x']) expect(await code(await api('GET', `/decisions?${query}`, { cookie })), query).toEqual([422, 'invalid']);
  });
});
