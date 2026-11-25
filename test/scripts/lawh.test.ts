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
    for (const args of [[], ['owner'], ['owner', 'setup', '--nope'], ['x', 'setup']]) expect(run('', ...args).status).toBe(2);
  });
});

it('reads JSON with comments', () => {
  expect(parseJsonc('{"a": "// no /* no */ \\" ,}", /* x, ] */ "b": [1, 2, // y\n ], "c": {"d": 1,},}')).toEqual({ a: '// no /* no */ " ,}', b: [1, 2], c: { d: 1 } });
  expect(() => parseJsonc('{"a": 1 /* open')).toThrow();
  // Long runs of what looks like comments stay quick.
  expect(parseJsonc(`[1, ${'//\n'.repeat(50_000)} ${'/**/'.repeat(50_000)} ]`)).toEqual([1]);
});
