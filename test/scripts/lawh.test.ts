import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error a plain script
import { parseJsonc } from '../../scripts/local/jsonc.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)), wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
let state: string;
const env = () => ({ ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', LAWH_LOCAL_STATE: state });
const run = (input: string, ...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/lawh.mjs'), ...args], { input, env: env(), encoding: 'utf8' });
const query = (sql: string): Record<string, unknown>[] => (JSON.parse(execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', state, '-c', join(state, 'entry.json'), '--json', '--command', sql], { cwd: root, env: env() }).toString()) as { results: Record<string, unknown>[] }[])[0]!.results;

describe('pnpm lawh owner setup --local', { timeout: 120_000 }, () => {
  beforeAll(() => {
    state = mkdtempSync(join(tmpdir(), 'lawh-'));
    writeFileSync(join(state, 'entry.json'), `{ // a comment
      "name": "x", "main": ${JSON.stringify(join(root, 'scripts/local/entry.ts'))}, "compatibility_date": "2026-11-10", /* another */
      "vars": { "APP_ORIGIN": "http://localhost:8787", }, // not a "comment" in a string: "//"
      "d1_databases": [{ "binding": "DB", "database_name": "any-name", "database_id": "local", "migrations_dir": ${JSON.stringify(join(root, 'migrations'))}, }],
    }`);
    execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'any-name', '--local', '--persist-to', state, '-c', join(state, 'entry.json')], { cwd: root, env: env(), stdio: 'ignore' });
  }, 120_000);
  afterAll(() => rmSync(state, { recursive: true, force: true }));

  it('refuses a bad name and changes nothing', () => {
    for (const name of ['\n', '  \n', 'a\u0007b\n', `${'x'.repeat(81)}\n`]) expect(run(name, 'owner', 'setup', '--local').status, JSON.stringify(name)).toBe(1);
    expect(query('SELECT COUNT(*) n FROM members')).toEqual([{ n: 0 }]);
  });

  it('makes the owner once, and each time a link that replaces the unused one', () => {
    const first = run("Sara O'Neil سارة\n", 'owner', 'setup', '--local');
    expect(first.stderr + first.stdout).toMatch(/http:\/\/localhost:8787\/link#[A-Za-z0-9_-]{43}\n/);
    expect(first.stdout).not.toContain('removes your other passkeys');
    expect(query('SELECT name, role, joined_at FROM members')).toEqual([{ name: "Sara O'Neil سارة", role: 'owner', joined_at: null }]);
    const second = run('', 'owner', 'setup', '--local'), token = /#(.{43})/.exec(second.stdout)![1]!;
    const links = query('SELECT token_sha256, kind, expires_at - created_at life FROM access_links');
    expect(links).toEqual([{ token_sha256: createHash('sha256').update(token).digest('hex'), kind: 'owner', life: 900_000 }]);
    expect(query("SELECT COUNT(*) n FROM audit WHERE action='owner.setup' AND actor_type='command'")).toEqual([{ n: 2 }]);
    expect(query('SELECT COUNT(*) n FROM members')).toEqual([{ n: 1 }]);
  });

  it('explains its use', () => {
    for (const args of [[], ['owner'], ['owner', 'setup', '--nope'], ['owner', 'transfer'], ['owner', 'transfer', 'a', 'b'], ['x', 'setup']]) {
      expect(run('', ...args).status).toBe(2);
    }
  });

  it('transfers ownership in one transaction, disambiguates colliding agent names, revokes old keys, and cleans teams/links/invites', () => {
    // Seed owner joined, member Mona joined, unjoined invitee Lina, a team, unused links, and colliding agents + keys.
    const ownerId = query("SELECT id FROM members WHERE role='owner'")[0]!.id as string;
    const now = Date.now();
    query(`
      UPDATE members SET joined_at = ${now} WHERE id = '${ownerId}';
      INSERT INTO teams(id, name, created_at) VALUES('t_tr', 'Core', ${now});
      INSERT INTO members(id, name, role, created_by, created_at) VALUES('mem_mona', 'Mona', 'member', '${ownerId}', ${now});
      UPDATE members SET joined_at = ${now} WHERE id = 'mem_mona';
      INSERT INTO team_members(team_id, member_id, level, set_by, set_at) VALUES('t_tr', 'mem_mona', 4, '${ownerId}', ${now});
      INSERT INTO members(id, name, role, created_by, created_at) VALUES('mem_unjoined', 'Unjoined', 'member', '${ownerId}', ${now});
      INSERT INTO access_links(token_sha256, kind, member_id, created_by, created_at, expires_at, team_id, level)
        VALUES('${'1'.repeat(64)}', 'invite', 'mem_unjoined', '${ownerId}', ${now}, ${now + 86_400_000}, 't_tr', 2);
      INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_old_1', '${ownerId}', 'shared-bot', ${now});
      INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_old_2', '${ownerId}', 'solo-bot', ${now});
      INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_new_1', 'mem_mona', 'shared-bot', ${now});
      INSERT INTO agent_keys(id, agent_id, secret_hmac, scopes_json, all_projects, created_at, expires_at)
        VALUES('key_old_1', 'agt_old_1', 'h1', '["pages:read"]', 1, ${now}, ${now + 86_400_000});
    `);

    // Unjoined member is refused.
    const unjoinedRes = run('yes\n', 'owner', 'transfer', 'mem_unjoined', '--local');
    expect(unjoinedRes.status).toBe(1);
    expect(unjoinedRes.stderr).toContain('has not joined');

    // Declining confirmation changes nothing.
    const declined = run('no\n', 'owner', 'transfer', 'mem_mona', '--local');
    expect(declined.status).toBe(1);
    expect(declined.stdout).toContain('Both people leave every team');
    expect(declined.stdout).toContain('shared-bot -> shared-bot (agt_old_1)');
    expect(query("SELECT id FROM members WHERE role='owner'")).toEqual([{ id: ownerId }]);

    // Confirming with exact "yes" executes the transfer atomically.
    const done = run('yes\n', 'owner', 'transfer', 'mem_mona', '--local');
    expect(done.status, done.stderr + done.stdout).toBe(0);
    expect(query("SELECT id, role FROM members WHERE id IN ('mem_mona', '" + ownerId + "') ORDER BY id")).toEqual(
      [
        { id: ownerId, role: 'member' },
        { id: 'mem_mona', role: 'owner' },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    // Both left every team; unused links deleted; pending invitee canceled; agents moved & disambiguated; old keys revoked; audit written.
    expect(query('SELECT COUNT(*) n FROM team_members')).toEqual([{ n: 0 }]);
    expect(query('SELECT COUNT(*) n FROM access_links WHERE used_at IS NULL')).toEqual([{ n: 0 }]);
    expect(query("SELECT removed_at IS NOT NULL canceled FROM members WHERE id='mem_unjoined'")).toEqual([{ canceled: 1 }]);
    expect(query("SELECT id, member_id, name FROM agents WHERE id IN ('agt_old_1','agt_old_2') ORDER BY id")).toEqual([
      { id: 'agt_old_1', member_id: 'mem_mona', name: 'shared-bot (agt_old_1)' },
      { id: 'agt_old_2', member_id: 'mem_mona', name: 'solo-bot' },
    ]);
    expect(query("SELECT revoked_at IS NOT NULL revoked FROM agent_keys WHERE id='key_old_1'")).toEqual([{ revoked: 1 }]);
    expect(query("SELECT COUNT(*) n FROM audit WHERE action='owner.transfer' AND subject_id='mem_mona'")).toEqual([{ n: 1 }]);
  });

  it('re-prompts and moves newly added agents if the agent inventory changes during transfer confirmation', async () => {
    // @ts-expect-error plain script module
    const { runOwnerTransfer } = await import('../../scripts/cli/transfer.mjs');
    const currentOwner = query("SELECT id FROM members WHERE role='owner'")[0]!.id as string;
    const otherMember = query(`SELECT id FROM members WHERE role='member' AND joined_at IS NOT NULL AND id <> '${currentOwner}'`)[0]!.id as string;
    const now = Date.now();
    let promptCalls = 0;
    const logs: string[] = [];

    const result = await runOwnerTransfer({
      targetArg: otherMember,
      sql: (statements: string) =>
        JSON.parse(execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', '--local', '--persist-to', state, '-c', join(state, 'entry.json'), '--json', '--command', statements], { cwd: root, env: env() }).toString()),
      prompt: async () => {
        promptCalls++;
        if (promptCalls === 1) {
          // Simulate an agent connecting while the operator is reading the prompt!
          query(`INSERT INTO agents(id, member_id, name, created_at) VALUES('agt_mid_prompt', '${currentOwner}', 'late-bot', ${now});
                 INSERT INTO agent_keys(id, agent_id, secret_hmac, scopes_json, all_projects, created_at, expires_at)
                   VALUES('key_mid_prompt', 'agt_mid_prompt', 'h2', '["pages:read"]', 1, ${now}, ${now + 86_400_000});`);
        }
        return 'yes';
      },
      log: (line: string) => logs.push(line),
    });

    expect(promptCalls).toBe(2);
    expect(logs.join('\n')).toContain('The agent list changed while waiting for confirmation');
    expect(result.movedAgents.some((a: { id: string }) => a.id === 'agt_mid_prompt')).toBe(true);
    expect(query(`SELECT COUNT(*) n FROM agents WHERE member_id='${currentOwner}'`)).toEqual([{ n: 0 }]);
    expect(query("SELECT revoked_at IS NOT NULL revoked FROM agent_keys WHERE id='key_mid_prompt'")).toEqual([{ revoked: 1 }]);
  });
});

it('reads JSON with comments', () => {
  expect(parseJsonc('{"a": "// no /* no */ \\" ,}", /* x, ] */ "b": [1, 2, // y\n ], "c": {"d": 1,},}')).toEqual({ a: '// no /* no */ " ,}', b: [1, 2], c: { d: 1 } });
  expect(parseJsonc('{"a": 1, // e.g. {app} or [host]\n "b": 2, /* ] } */ "c": 3}')).toEqual({ a: 1, b: 2, c: 3 });
  expect(() => parseJsonc('{"a":1/* not joined */2}')).toThrow();
  expect(() => parseJsonc('{"a": 1 /* open')).toThrow();
  // Long runs of what looks like comments stay quick.
  expect(parseJsonc(`[1, ${'//\n'.repeat(50_000)} ${'/**/'.repeat(50_000)} ]`)).toEqual([1]);
});
