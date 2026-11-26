import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanUpPeople } from '../../../src/app/people/cleanUp';
import { purge } from '../../../src/app/housekeeping';
import { call as agent, json, makeKey, seed as seedAgents, sql } from '../api/helpers';
import { Authenticator } from './authenticator';
import { api, code, count, enter, one, register } from './helpers';

const DAY = 86_400_000;

beforeEach(async () => {
  await seedAgents();
  await sql('DELETE FROM team_members');
  await sql(
    "INSERT INTO members(id, name, role, created_by, created_at) VALUES('r', 'Rami', 'member', 'o', 1)",
    "UPDATE members SET joined_at=1 WHERE id='r'",
  );
});

describe('S18 people lifecycle, invites, resets, removal, and teams switch', () => {
  it('toggles the teams switch (owner only), hides /people behind it, and resets project answers_needed to 1 when turned off', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)");
    await sql("UPDATE projects SET answers_needed = 3 WHERE id = 'p1'");

    // Non-owner cannot toggle teams switch.
    expect(await code(await api('PUT', '/switches/teams', { cookie: mona, body: { on: false } }))).toEqual([403, 'forbidden']);

    // Owner turns teams off -> answers_needed resets to 1 via trigger, and all /people routes return 404 feature_off.
    expect(await json(await api('PUT', '/switches/teams', { cookie: owner, body: { on: false } }))).toEqual({ teams: false });
    expect((await one<{ answers_needed: number }>("SELECT answers_needed FROM projects WHERE id = 'p1'"))?.answers_needed).toBe(1);
    expect((await json(await api('GET', '/settings', { cookie: owner }))).teams).toBe(false);
    expect((await json(await api('GET', '/me', { cookie: owner }))).teams).toBe(false);

    const gated: [string, string, unknown?][] = [
      ['GET', '/people'],
      ['POST', '/people/invite', { name: 'Lina', teamId: 't1', level: 1 }],
      ['POST', '/people/m/invite-link'],
      ['DELETE', '/people/m/invite'],
      ['POST', '/people/m/reset'],
      ['DELETE', '/people/m'],
    ];
    for (const [method, path, body] of gated) {
      expect(await code(await api(method, path, { cookie: owner, ...(body !== undefined ? { body } : {}) })), `${method} ${path}`).toEqual([404, 'feature_off']);
    }

    // Other members get 404 feature_off while teams is off (per docs/spec/teams.md).
    expect(await code(await api('GET', '/me', { cookie: mona }))).toEqual([404, 'feature_off']);

    // Turning teams back on restores access and writes both audit entries.
    expect(await json(await api('PUT', '/switches/teams', { cookie: owner, body: { on: true } }))).toEqual({ teams: true });
    expect((await api('GET', '/me', { cookie: mona })).status).toBe(200);
    const audits = (await env.DB.prepare("SELECT action FROM audit WHERE action IN ('teams.off','teams.on') ORDER BY seq").all()).results;
    expect(audits).toEqual([{ action: 'teams.off' }, { action: 'teams.on' }]);
  });

  it('invites a person (3-day link), renews link replacing the old one, joins via passkey, and enforces manager invite limits', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)");

    // Manager cannot invite at level 4 (manager), CAN invite up to level 3 (decider).
    expect(await code(await api('POST', '/people/invite', { cookie: mona, body: { name: 'Boss', teamId: 't1', level: 4 } }))).toEqual([403, 'forbidden']);
    const invited = await json(await api('POST', '/people/invite', { cookie: mona, body: { name: 'Lina', teamId: 't1', level: 3 } }));
    expect(invited.id).toMatch(/^mem_/);
    expect(invited.url).toMatch(/^http:\/\/localhost:8787\/link#[A-Za-z0-9_-]{43}$/);
    const oldToken = invited.url.split('#')[1]!;

    // Invited person is NOT in any team yet.
    expect(await count('team_members', `member_id='${invited.id}'`)).toBe(0);

    // Renewing replaces the old link so the old token stops working.
    const renewed = await json(await api('POST', `/people/${invited.id}/invite-link`, { cookie: mona }));
    const newToken = renewed.url.split('#')[1]!;
    expect(newToken).not.toBe(oldToken);
    expect(await code(await api('POST', '/link/options', { body: { token: oldToken } }))).toEqual([404, 'not_found']);

    // New link shows inviter, team, and level, and joining adds Lina to t1 at level 3.
    const offered = await json(await api('POST', '/link/options', { body: { token: newToken } }));
    expect(offered.link).toEqual({ kind: 'invite', name: 'Lina', team: 'Team', level: 3, inviter: 'Mona' });
    const joinedRes = await register(newToken, await Authenticator.make());
    expect(joinedRes.status).toBe(204);
    expect(await one(`SELECT team_id, level FROM team_members WHERE member_id='${invited.id}'`)).toEqual({ team_id: 't1', level: 3 });

    // Owner sees Lina in joined members with her team.
    const list = await json(await api('GET', '/people', { cookie: owner }));
    expect(list.members.find((m: { id: string }) => m.id === invited.id)).toMatchObject({
      name: 'Lina',
      teams: [{ id: 't1', name: 'Team', level: 3 }],
    });
  });

  it('keeps expired invites in the list, lets inviter/team-manager/owner cancel them, and auto-cancels after 30 days', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)");

    const inv1 = await json(await api('POST', '/people/invite', { cookie: owner, body: { name: 'ExpiredOne', teamId: 't1', level: 2 } }));
    const inv2 = await json(await api('POST', '/people/invite', { cookie: mona, body: { name: 'OldOne', teamId: 't1', level: 1 } }));

    // Replace inv1's link with an already-expired invite link (access_links_fixed forbids UPDATE on expires_at) —
    // cleanUpPeople keeps it because the pending invite is < 30 days old!
    await sql(
      `DELETE FROM access_links WHERE member_id = '${inv1.id}'`,
      `INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level) VALUES('${'e'.repeat(64)}', 'invite', '${inv1.id}', 'o', ${Date.now() - 4 * DAY}, ${Date.now() - DAY}, 't1', 2)`,
    );
    // Make inv2 31 days old -> cleanUpPeople cancels it automatically!
    await sql(`UPDATE members SET created_at = ${Date.now() - 31 * DAY} WHERE id = '${inv2.id}'`);
    await cleanUpPeople(env);

    const listed = await json(await api('GET', '/people', { cookie: mona }));
    const found1 = listed.invites.find((i: { id: string }) => i.id === inv1.id);
    expect(found1).toMatchObject({ name: 'ExpiredOne', expired: true, canRenew: false, canCancel: true });
    expect(listed.invites.find((i: { id: string }) => i.id === inv2.id)).toBeUndefined();
    expect((await one<{ removed_at: number | null }>(`SELECT removed_at FROM members WHERE id='${inv2.id}'`))?.removed_at).not.toBeNull();

    // Manager of t1 CAN cancel the owner's invite to t1, even though they cannot renew it.
    expect(await code(await api('POST', `/people/${inv1.id}/invite-link`, { cookie: mona }))).toEqual([403, 'forbidden']);
    expect((await api('DELETE', `/people/${inv1.id}/invite`, { cookie: mona })).status).toBe(204);
    expect((await one<{ removed_at: number | null }>(`SELECT removed_at FROM members WHERE id='${inv1.id}'`))?.removed_at).not.toBeNull();
  });

  it('creates a 1-day reset link (owner only) that clears old sessions/passkeys without revoking agent keys, and removes members atomically', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    await sql("INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t1', 'm', 4, 'o', 1)");

    // Give Mona an agent + active key AND a pending invite she made.
    const monaAgent = 'agt_01S18MONA00000000000000001';
    await sql(`INSERT INTO agents(id, member_id, name, created_at) VALUES('${monaAgent}', 'm', 's18-mona-bot', 1)`);
    const { token: monaKey } = await makeKey({ agent: monaAgent, projects: ['p1'] });
    const monaInvite = await json(await api('POST', '/people/invite', { cookie: mona, body: { name: 'Guest', teamId: 't1', level: 1 } }));

    // Manager cannot make a reset link or remove a member.
    expect(await code(await api('POST', '/people/r/reset', { cookie: mona }))).toEqual([403, 'forbidden']);
    expect(await code(await api('DELETE', '/people/r', { cookie: mona }))).toEqual([403, 'forbidden']);

    // Owner makes a 1-day reset link for Mona.
    const reset = await json(await api('POST', '/people/m/reset', { cookie: owner }));
    expect(reset.url).toMatch(/^http:\/\/localhost:8787\/link#[A-Za-z0-9_-]{43}$/);
    const resetToken = reset.url.split('#')[1]!;
    expect((await register(resetToken, await Authenticator.make())).status).toBe(204);

    // Mona's old session ended, but her agent key STILL works (post-reset page lists it with Revoke).
    expect((await api('GET', '/me', { cookie: mona })).status).toBe(401);
    expect((await agent('/v1/me', { token: monaKey })).status).toBe(200);

    // Removing Mona atomically ends sessions/passkeys/memberships, cancels invites she made, and revokes her agent keys!
    expect((await api('DELETE', '/people/m', { cookie: owner })).status).toBe(204);
    expect((await agent('/v1/me', { token: monaKey })).status).toBe(401);
    expect(await count('team_members', "member_id='m'")).toBe(0);
    expect(await count('passkeys', "member_id='m'")).toBe(0);
    expect((await one<{ removed_at: number | null }>(`SELECT removed_at FROM members WHERE id='${monaInvite.id}'`))?.removed_at).not.toBeNull();

    // After 30 days, housekeeping clears the removed member's name to NULL ("Former member").
    await purge(env, Date.now() + 31 * DAY);
    expect((await one<{ name: string | null }>("SELECT name FROM members WHERE id='m'"))?.name).toBeNull();
  });
});
