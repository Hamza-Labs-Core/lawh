import { beforeEach, describe, expect, it } from 'vitest';
import { call as agent, json, makeKey, seed as seedAgents, sql } from '../api/helpers';
import { api, code, enter, one } from './helpers';

beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
  await sql(
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('r', 'Rami', 'member', 'o', 1)",
    "UPDATE members SET joined_at=1 WHERE id='r'",
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('u', 'Unjoined', 'member', 'o', 1)",
  );
});

describe('S17 teams API, caps, highest-level-wins, and managers’ agents', () => {
  it('hides every /teams route and /agents/:id/take-over behind the teams switch', async () => {
    await sql("UPDATE settings SET value_json='false' WHERE key='teams'");
    const { cookie: owner } = await enter('o');
    expect((await json(await api('GET', '/me', { cookie: owner }))).teams).toBe(false);
    expect(await code(await api('GET', '/teams', { cookie: owner }))).toEqual([404, 'feature_off']);
    expect(await code(await api('POST', '/teams', { cookie: owner, body: { name: 'Alpha' } }))).toEqual([404, 'feature_off']);
    expect(await code(await api('POST', '/agents/agt_00000000000000000000000001/take-over', { cookie: owner }))).toEqual([404, 'feature_off']);
  });

  it('supports owner team CRUD, project assignment with 10-project cap, and member assignment with 5-team cap', async () => {
    const { cookie: owner } = await enter('o');
    expect((await json(await api('GET', '/me', { cookie: owner }))).teams).toBe(true);

    // Create, duplicate -> 409, rename, list.
    const created = await json(await api('POST', '/teams', { cookie: owner, body: { name: 'Engineering' } }));
    expect(created.id).toMatch(/^tem_/);
    expect(await code(await api('POST', '/teams', { cookie: owner, body: { name: 'Engineering' } }))).toEqual([409, 'conflict']);
    expect(await json(await api('PATCH', `/teams/${created.id}`, { cookie: owner, body: { name: 'Core Eng' } }))).toEqual({ id: created.id, name: 'Core Eng' });

    // Assign projects up to 10 -> 11th gets 409.
    for (let i = 1; i <= 11; i++) {
      await sql(`INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES('pc${i}', 'cap-${i}', 'Cap ${i}', 'م${i}', 1)`);
    }
    for (let i = 1; i <= 10; i++) {
      expect((await api('POST', `/teams/${created.id}/projects`, { cookie: owner, body: { project: `cap-${i}` } })).status).toBe(201);
    }
    expect(await code(await api('POST', `/teams/${created.id}/projects`, { cookie: owner, body: { project: 'cap-11' } }))).toEqual([409, 'conflict']);
    expect((await api('DELETE', `/teams/${created.id}/projects/cap-10`, { cookie: owner })).status).toBe(204);
    expect((await api('POST', `/teams/${created.id}/projects`, { cookie: owner, body: { project: 'cap-11' } })).status).toBe(201);

    // Assign a joined member to 5 teams -> 6th gets 409; unjoined member gets 404.
    expect(await code(await api('POST', `/teams/${created.id}/members`, { cookie: owner, body: { memberId: 'u', level: 1 } }))).toEqual([404, 'not_found']);
    const extraTeams: string[] = [created.id];
    for (let i = 1; i <= 5; i++) {
      const t = await json(await api('POST', '/teams', { cookie: owner, body: { name: `T-${i}` } }));
      extraTeams.push(t.id);
    }
    for (let i = 0; i < 5; i++) {
      expect((await api('POST', `/teams/${extraTeams[i]}/members`, { cookie: owner, body: { memberId: 'r', level: 2 } })).status).toBe(201);
    }
    expect(await code(await api('POST', `/teams/${extraTeams[5]}/members`, { cookie: owner, body: { memberId: 'r', level: 2 } }))).toEqual([409, 'conflict']);

    // Delete team cascades memberships & projects.
    expect((await api('DELETE', `/teams/${created.id}`, { cookie: owner })).status).toBe(204);
    expect(await one('SELECT id FROM teams WHERE id=?', created.id)).toBeNull();
  });

  it('enforces manager scope, guarded DELETE against managers, and highest-level-wins across teams', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    const { cookie: rami } = await enter('r');

    // t1 already has p1, p2; create t2 with p1 too.
    const t2 = await json(await api('POST', '/teams', { cookie: owner, body: { name: 'Second' } }));
    expect((await api('POST', `/teams/${t2.id}/projects`, { cookie: owner, body: { project: 'one' } })).status).toBe(201);

    // Owner makes Mona manager of t1 and Dina manager of t1; Rami viewer in t1 and decider in t2.
    expect((await api('POST', '/teams/t1/members', { cookie: owner, body: { memberId: 'm', level: 4 } })).status).toBe(201);
    expect((await api('POST', '/teams/t1/members', { cookie: owner, body: { memberId: 'd', level: 4 } })).status).toBe(201);
    expect((await api('POST', '/teams/t1/members', { cookie: owner, body: { memberId: 'r', level: 1 } })).status).toBe(201);
    expect((await api('POST', `/teams/${t2.id}/members`, { cookie: owner, body: { memberId: 'r', level: 3 } })).status).toBe(201);

    // Highest level wins for Rami on project one (level 3 from t2 > level 1 from t1).
    const ramiProjects = (await json(await api('GET', '/projects', { cookie: rami }))).items as { slug: string; level: number }[];
    expect(ramiProjects.find((p) => p.slug === 'one')?.level).toBe(3);

    // Manager Mona sees only t1 (not t2), cannot create/rename/delete teams or assign projects.
    const monaTeams = await json(await api('GET', '/teams', { cookie: mona }));
    expect(monaTeams.items.map((t: { id: string }) => t.id)).toEqual(['t1']);
    expect(await code(await api('POST', '/teams', { cookie: mona, body: { name: 'Nope' } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('POST', '/teams/t1/projects', { cookie: mona, body: { project: 'three' } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('POST', `/teams/${t2.id}/members`, { cookie: mona, body: { memberId: 'd', level: 1 } }))).toEqual([404, 'not_found']);

    // Manager Mona can raise Rami to 3 (decider), cannot raise Rami to 4 (manager), cannot demote or remove manager Dina.
    expect((await api('PATCH', '/teams/t1/members/r', { cookie: mona, body: { level: 3 } })).status).toBe(200);
    expect(await code(await api('PATCH', '/teams/t1/members/r', { cookie: mona, body: { level: 4 } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('PATCH', '/teams/t1/members/d', { cookie: mona, body: { level: 2 } }))).toEqual([403, 'forbidden']);
    expect(await code(await api('DELETE', '/teams/t1/members/d', { cookie: mona }))).toEqual([403, 'forbidden']);

    // Manager Mona CAN remove non-manager Rami from t1; owner CAN remove manager Dina.
    expect((await api('DELETE', '/teams/t1/members/r', { cookie: mona })).status).toBe(204);
    expect((await api('DELETE', '/teams/t1/members/d', { cookie: owner })).status).toBe(204);
  });

  it('shows managers’ agents to the owner, stops manager agent keys immediately on demotion, and lets owner take over an agent (revoking old keys)', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    expect((await api('POST', '/teams/t1/members', { cookie: owner, body: { memberId: 'm', level: 4 } })).status).toBe(201);

    // Give Mona an agent with the same name as one of the owner's agents (`shared-bot`) to test name disambiguation on takeover.
    const monaAgentId = 'agt_01MONABOT00000000000000001';
    const ownerAgentId = 'agt_01OWNERBOT0000000000000001';
    await sql(`INSERT INTO agents(id, member_id, name, created_at) VALUES('${monaAgentId}', 'm', 'shared-bot', 1), ('${ownerAgentId}', 'o', 'shared-bot', 1)`);
    const { token: monaKey } = await makeKey({ agent: monaAgentId, projects: ['p1'] });

    // Key works on p1 while Mona manages t1.
    expect((await agent('/v1/projects', { token: monaKey })).status).toBe(200);
    expect((await json(await agent('/v1/projects', { token: monaKey }))).items.map((p: { slug: string }) => p.slug)).toEqual(['one']);

    // Owner sees Mona's agent with owner attribution on GET /app-api/agents.
    const listed = (await json(await api('GET', '/agents', { cookie: owner }))).items as { id: string; name: string; isMine: boolean; owner: { id: string; name: string } }[];
    expect(listed.find((a) => a.id === monaAgentId)).toMatchObject({
      name: 'shared-bot',
      isMine: false,
      owner: { id: 'm', name: 'Mona' },
    });

    // Demoting Mona to decider immediately strips p1 from Mona's agent key.
    expect((await api('PATCH', '/teams/t1/members/m', { cookie: owner, body: { level: 3 } })).status).toBe(200);
    expect((await json(await agent('/v1/projects', { token: monaKey }))).items).toEqual([]);
    expect((await api('PATCH', '/teams/t1/members/m', { cookie: owner, body: { level: 4 } })).status).toBe(200);
    expect((await json(await agent('/v1/projects', { token: monaKey }))).items.map((p: { slug: string }) => p.slug)).toEqual(['one']);

    // Manager cannot take over agents; owner takes over Mona's agent -> disambiguates name & revokes its old key atomically!
    expect(await code(await api('POST', `/agents/${monaAgentId}/take-over`, { cookie: mona }))).toEqual([403, 'forbidden']);
    const taken = await json(await api('POST', `/agents/${monaAgentId}/take-over`, { cookie: owner }));
    expect(taken.id).toBe(monaAgentId);
    expect(taken.name).toContain('shared-bot');
    expect(taken.name).toContain(monaAgentId);
    // Old key is immediately revoked (401)!
    expect((await agent('/v1/me', { token: monaKey })).status).toBe(401);
  });
});
