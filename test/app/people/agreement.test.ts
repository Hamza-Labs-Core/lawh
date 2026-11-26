import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call as agent, json, makeKey, publish, seed as seedAgents, sql } from '../api/helpers';
import { api, code, enter, one } from './helpers';

beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
  await sql(
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('r', 'Rami', 'member', 'o', 1)",
    "UPDATE members SET joined_at=1 WHERE id='r'",
  );
});

describe('S19 multi-decider agreement', () => {
  it('configures answersNeeded (owner only, 1..5, requires teams on), counts each decider once across teams, and resets to 1 when teams turns off', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)");
    // Put Mona in a second team that also has p1 -> Mona must still count ONCE (+ owner = 2 total answerers).
    const t2 = await json(await api('POST', '/teams', { cookie: owner, body: { name: 'Second' } }));
    await api('POST', `/teams/${t2.id}/projects`, { cookie: owner, body: { project: 'one' } });
    await api('POST', `/teams/${t2.id}/members`, { cookie: owner, body: { memberId: 'm', level: 3 } });

    // Non-owner cannot set answersNeeded; invalid bounds rejected.
    expect(await code(await api('PATCH', '/projects/one', { cookie: mona, body: { answersNeeded: 2 } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 0 } }))).toEqual([422, 'invalid']);
    expect(await code(await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 6 } }))).toEqual([422, 'invalid']);
    expect(await code(await api('PATCH', '/projects/one', { cookie: owner, body: {} }))).toEqual([422, 'invalid']);

    // Owner sets answersNeeded = 3 (more than the 2 answerers: owner + Mona).
    const updated = await json(await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 3 } }));
    expect(updated).toMatchObject({ slug: 'one', answersNeeded: 3, answerers: 2 });
    const listed = (await json(await api('GET', '/projects', { cookie: owner }))).items as { slug: string; answersNeeded: number; answerers: number }[];
    expect(listed.find((p) => p.slug === 'one')).toMatchObject({ answersNeeded: 3, answerers: 2 });
    expect(await one("SELECT action FROM audit WHERE action='project.agreement' AND subject_id='p1'")).toEqual({ action: 'project.agreement' });

    // Turning teams off resets answers_needed back to 1, drops team deciders from answerers, and refuses ANY explicit answersNeeded PATCH (even to 1) with 409.
    expect((await api('PUT', '/switches/teams', { cookie: owner, body: { on: false } })).status).toBe(200);
    expect((await one<{ answers_needed: number }>("SELECT answers_needed FROM projects WHERE id='p1'"))?.answers_needed).toBe(1);
    const listedOff = (await json(await api('GET', '/projects', { cookie: owner }))).items as { slug: string; answersNeeded: number; answerers: number }[];
    expect(listedOff.find((p) => p.slug === 'one')).toMatchObject({ answersNeeded: 1, answerers: 1 });
    expect(await code(await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 2 } }))).toEqual([409, 'conflict']);
    expect(await code(await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 1 } }))).toEqual([409, 'conflict']);

    // Partial PATCH never clobbers a concurrently updated field (name-only PATCH preserves answersNeeded set concurrently).
    expect((await api('PUT', '/switches/teams', { cookie: owner, body: { on: true } })).status).toBe(200);
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 3 } })).status).toBe(200);
    const renamed = await json(await api('PATCH', '/projects/one', { cookie: owner, body: { name: { en: 'One Renamed', ar: 'واحد جديد' } } }));
    expect(renamed).toMatchObject({ slug: 'one', name: { en: 'One Renamed', ar: 'واحد جديد' }, answersNeeded: 3, answerers: 2 });

    // Non-owner member sees consistent `answerers` shape even when all visible projects have answersNeeded=1.
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 1 } })).status).toBe(200);
    const monaProjects = (await json(await api('GET', '/projects', { cookie: mona }))).items as { slug: string; answersNeeded: number; answerers: number }[];
    expect(monaProjects.find((p) => p.slug === 'one')).toMatchObject({ answersNeeded: 1, answerers: 2 });
  });

  it('tracks Waiting for others, requires an option when >1 needed, decides on agreement, keeps decided stable, and exposes agreement in /v1/decisions', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    const { cookie: rami } = await enter('r');
    await sql(
      "INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 3, 'o', 1)",
      "INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'r', 3, 'o', 1)",
    );

    const { token } = await makeKey();
    await publish(token, { 'index.html': '<p>agree</p>' }, {
      page: { title: 'Agreement Page', status: 'in_review' },
      decisions: [{ key: 'db', question: 'Which DB?', options: [{ id: 'a', label: 'SQLite' }, { id: 'b', label: 'Postgres' }] }],
    });
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 2 } })).status).toBe(200);

    const [dec] = (await json(await api('GET', '/projects/one/pages/page/decisions', { cookie: owner }))).items as { id: string }[];
    const decId = dec!.id;

    // Notes-only answer is refused when answersNeeded > 1.
    expect(await code(await api('POST', `/decisions/${decId}/answers`, { cookie: owner, body: { revision: 1, seq: 0, optionId: null, notes: 'maybe' } }))).toEqual([422, 'invalid']);

    // Owner picks 'a' -> stays open, decides=false, event=decision.vote; appears in owner's Waiting for others & Mona's To answer.
    const v1 = await json(await api('POST', `/decisions/${decId}/answers`, { cookie: owner, body: { revision: 1, seq: 0, optionId: 'a', notes: 'simple' } }));
    expect(v1.status).toBe('open');
    expect(v1.answer).toBeNull();
    expect(v1.answersNeeded).toBe(2);
    expect(v1.agreement).toHaveLength(1);
    expect(v1.agreement[0]).toMatchObject({ optionId: 'a', decides: false, needed: 2, answeredBy: { id: 'o' } });

    expect((await json(await api('GET', '/decisions?show=open', { cookie: owner }))).items).toHaveLength(0);
    expect((await json(await api('GET', '/decisions?show=waiting', { cookie: owner }))).items.map((d: { id: string }) => d.id)).toEqual([decId]);
    expect((await json(await api('GET', '/decisions?show=open', { cookie: mona }))).items.map((d: { id: string }) => d.id)).toEqual([decId]);
    expect((await json(await api('GET', '/decisions/count', { cookie: owner }))).count).toBe(0);
    expect((await json(await api('GET', '/decisions/count', { cookie: mona }))).count).toBe(1);

    // /v1/decisions exposes answersNeeded and agreement while answer is still null!
    const apiBefore = await json(await agent(`/v1/decisions/${decId}`, { token }));
    expect(apiBefore.status).toBe('open');
    expect(apiBefore.answer).toBeNull();
    expect(apiBefore.answersNeeded).toBe(2);
    expect(apiBefore.agreement).toHaveLength(1);

    // Mona disagrees (picks 'b') -> still open (1 on 'a', 1 on 'b').
    const v2 = await json(await api('POST', `/decisions/${decId}/answers`, { cookie: mona, body: { revision: 1, seq: 1, optionId: 'b', notes: '' } }));
    expect(v2.status).toBe('open');
    expect(v2.agreement).toHaveLength(2);

    // Changing answersNeeded back to 1 applies from the NEXT answer — it does NOT decide or reopen by itself!
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 1 } })).status).toBe(200);
    expect((await json(await api('GET', `/decisions/${decId}`, { cookie: owner }))).status).toBe('open');
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { answersNeeded: 2 } })).status).toBe(200);

    // Demoting Mona below decider drops her pending vote from agreement!
    await sql("UPDATE team_members SET level = 2, set_by = 'o' WHERE member_id = 'm'");
    const afterDemote = await json(await api('GET', `/decisions/${decId}`, { cookie: owner }));
    expect(afterDemote.agreement.map((a: { answeredBy: { id: string } }) => a.answeredBy.id)).toEqual(['o']);
    await sql("UPDATE team_members SET level = 3, set_by = 'o' WHERE member_id = 'm'");

    // Rami agrees with Owner on 'a' -> decides! Status becomes 'answered', page auto-decides, event = decision.answered.
    const v3 = await json(await api('POST', `/decisions/${decId}/answers`, { cookie: rami, body: { revision: 1, seq: 2, optionId: 'a', notes: 'agreed' } }));
    expect(v3.status).toBe('answered');
    expect(v3.answer).toMatchObject({ optionId: 'a', decides: true, answeredBy: { id: 'r' } });
    expect(v3.page.status).toBe('decided');

    // Rami changing their mind alone to 'b' does NOT reopen the decided answer, though it is recorded in history!
    // (Wait: Mona had 'b', so Rami switching to 'b' makes 2 for 'b' which decides 'b' — test owner switching alone to 'b' when Mona is demoted!)
    await sql("UPDATE team_members SET level = 2, set_by = 'o' WHERE member_id = 'm'");
    const v4 = await json(await api('POST', `/decisions/${decId}/answers`, { cookie: owner, body: { revision: 1, seq: 3, optionId: 'b', notes: 'second thoughts' } }));
    expect(v4.status).toBe('answered');
    expect(v4.answer).toMatchObject({ seq: 3, optionId: 'a' });
    expect(v4.history).toHaveLength(4);

    // Verify events recorded decision.vote (seq 1, 2, 4) and decision.answered (seq 3).
    const evs = (await env.DB.prepare("SELECT type FROM events WHERE type IN ('decision.vote','decision.answered') ORDER BY seq").all<{ type: string }>()).results.map((r) => r.type);
    expect(evs).toEqual(['decision.vote', 'decision.vote', 'decision.answered', 'decision.vote']);

    // Turning teams off drops non-owner votes from `agreement` while keeping the deciding `answer` and `history` intact!
    expect((await api('PUT', '/switches/teams', { cookie: owner, body: { on: false } })).status).toBe(200);
    const apiOff = await json(await agent(`/v1/decisions/${decId}`, { token }));
    expect(apiOff.status).toBe('answered');
    expect(apiOff.answer).toMatchObject({ seq: 3, optionId: 'a' });
    expect(apiOff.agreement.every((a: { answeredBy: { id: string } }) => a.answeredBy.id === 'o')).toBe(true);
    expect(apiOff.history).toHaveLength(4);

    // No-op PATCH requests must not write misleading project.rename or project.agreement audit rows.
    expect((await api('PUT', '/switches/teams', { cookie: owner, body: { on: true } })).status).toBe(200);
    const beforeAudit = (await env.DB.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('project.rename','project.agreement')").first<{ n: number }>())!.n;
    expect((await api('PATCH', '/projects/one', { cookie: owner, body: { name: { en: 'One', ar: 'واحد' }, answersNeeded: 1 } })).status).toBe(200);
    const afterAudit = (await env.DB.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('project.rename','project.agreement')").first<{ n: number }>())!.n;
    expect(afterAudit).toBe(beforeAudit);
  });
});
