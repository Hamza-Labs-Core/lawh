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
    const gated: [string, string, unknown?][] = [
      ['GET', '/teams'],
      ['POST', '/teams', { name: 'Alpha' }],
      ['PATCH', '/teams/t1', { name: 'Beta' }],
      ['DELETE', '/teams/t1'],
      ['POST', '/teams/t1/members', { memberId: 'r', level: 1 }],
      ['PATCH', '/teams/t1/members/r', { level: 2 }],
      ['DELETE', '/teams/t1/members/r'],
      ['POST', '/teams/t1/projects', { project: 'three' }],
      ['DELETE', '/teams/t1/projects/one'],
      ['POST', '/agents/agt_00000000000000000000000001/take-over'],
    ];
    for (const [method, path, body] of gated) {
      expect(await code(await api(method, path, { cookie: owner, ...(body !== undefined ? { body } : {}) })), `${method} ${path}`).toEqual([404, 'feature_off']);
    }
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

  it('sets managesTeam for managers of teams without projects, paginates owner agents, handles repeated takeover collisions, and maps FK deletion races to 404', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');

    // Create a team with ZERO projects and make Mona its manager.
    const emptyTeam = await json(await api('POST', '/teams', { cookie: owner, body: { name: 'NoProjects' } }));
    expect((await api('POST', `/teams/${emptyTeam.id}/members`, { cookie: owner, body: { memberId: 'm', level: 4 } })).status).toBe(201);
    const monaMe = await json(await api('GET', '/me', { cookie: mona }));
    expect(monaMe.manages).toBe(false);
    expect(monaMe.managesTeam).toBe(true);
    const monaTeams = await json(await api('GET', '/teams', { cookie: mona }));
    expect(monaTeams.items.map((t: { id: string }) => t.id)).toEqual([emptyTeam.id]);

    // Owner agent pagination returns every agent across pages with no silent truncation.
    await sql(
      "INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01PAG000000000000000000001', 'o', 'bot-1', 1)",
      "INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01PAG000000000000000000002', 'm', 'bot-2', 1)",
      "INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01PAG000000000000000000003', 'r', 'bot-3', 1)",
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { name: string }[]; next: string | null } = await json(
        await api('GET', `/agents?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie: owner }),
      );
      seen.push(...page.items.map((a) => a.name));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(expect.arrayContaining(['bot-1', 'bot-2', 'bot-3']));
    expect(new Set(seen).size).toBe(seen.length);

    // Takeover still succeeds even when the owner already uses the original name AND all deterministic fallbacks!
    const colId = 'agt_01COL000000000000000000001';
    await sql(
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('${colId}', 'm', 'dup', 1)`,
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01COL000000000000000000002', 'o', 'dup', 1)`,
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01COL000000000000000000003', 'o', 'dup (${colId})', 1)`,
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01COL000000000000000000004', 'o', 'dup (${colId}-2)', 1)`,
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01COL000000000000000000005', 'o', 'dup (${colId}-3)', 1)`,
      `INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_01COL000000000000000000006', 'o', 'dup (${colId}-4)', 1)`,
    );
    const taken = await json(await api('POST', `/agents/${colId}/take-over`, { cookie: owner }));
    expect(taken.id).toBe(colId);
    expect(taken.name).toMatch(/^dup \(agt_01COL000-[0-9a-f]{16}\)$/);

    // Deleting a team concurrently before addTeamProject's INSERT returns 404 (not 500).
    const { env } = await import('cloudflare:workers');
    let armed = true;
    const racingDb = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (armed) {
              armed = false;
              await sql(`DELETE FROM teams WHERE id='${emptyTeam.id}'`);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await code(await api('POST', `/teams/${emptyTeam.id}/projects`, { cookie: owner, body: { project: 'one' } }, { DB: racingDb }))).toEqual([404, 'not_found']);
  });
});
