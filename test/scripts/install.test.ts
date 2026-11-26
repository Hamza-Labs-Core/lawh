import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script
import { MissingCloudflareTokenError, readCloudflareToken } from '../../scripts/cli/cloudflare.mjs';
// @ts-expect-error plain ESM script
import { runUpgrade } from '../../scripts/cli/commands.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const installerPath = join(repoRoot, 'install.sh');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeReleaseTarball(
  dir: string,
  version: string,
  opts: {
    legacyV100?: boolean;
    badPackageJson?: boolean;
    includeReserved?: string;
    includeInstallSh?: boolean;
  } = {},
): string {
  const folder = `lawh-${version}-${Math.random().toString(16).slice(2, 8)}`;
  const srcRoot = join(dir, folder);
  mkdirSync(join(srcRoot, 'scripts/cli'), { recursive: true });
  mkdirSync(join(srcRoot, 'scripts/local'), { recursive: true });
  writeFileSync(
    join(srcRoot, 'package.json'),
    opts.badPackageJson ? '{not valid json' : JSON.stringify({ name: 'lawh', version, type: 'module' }),
  );
  if (opts.includeInstallSh !== false && !opts.legacyV100) {
    writeFileSync(join(srcRoot, 'install.sh'), readFileSync(installerPath, 'utf8'), { mode: 0o755 });
  }
  if (opts.legacyV100) {
    // Realistic v1.0.0 CLI that only knows init/upgrade/rollback/destroy/owner and rejects version/login/self-update.
    writeFileSync(
      join(srcRoot, 'scripts/lawh.mjs'),
      'console.error("Usage: pnpm lawh <init|upgrade|rollback|destroy|owner>"); process.exit(2);\n',
    );
  } else {
    for (const rel of [
      'scripts/lawh.mjs',
      'scripts/cli/cloudflare.mjs',
      'scripts/cli/commands.mjs',
      'scripts/cli/config.mjs',
      'scripts/cli/export.mjs',
      'scripts/cli/migrations.mjs',
      'scripts/cli/transfer.mjs',
      'scripts/local/jsonc.mjs',
    ]) {
      writeFileSync(join(srcRoot, rel), readFileSync(join(repoRoot, rel), 'utf8'));
    }
  }
  if (opts.includeReserved) {
    const target = join(srcRoot, opts.includeReserved);
    if (opts.includeReserved === '.wrangler') mkdirSync(target, { recursive: true });
    else writeFileSync(target, '{"injected":true}\n');
  }
  const archive = join(dir, `${folder}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, folder]);
  return archive;
}

function runAsync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string } = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

describe('no-clone installer (install.sh) and lawh CLI', () => {
  it('installs with relative/spaced paths, supports legacy v1.0.0 bootstrap, persists custom bin/repo on self-update, and rolls back post-swap failures cleanly', () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh install test '));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));

    const legacyTar = makeReleaseTarball(work, '1.0.0', { legacyV100: true });
    const tar101 = makeReleaseTarball(work, '1.0.1');
    const tar102 = makeReleaseTarball(work, '1.0.2');
    const badPkgTar = makeReleaseTarball(work, '1.0.3', { badPackageJson: true });
    const fakeHome = join(work, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });

    // Install using RELATIVE LAWH_HOME and custom LAWH_BIN_DIR + custom fork LAWH_REPO.
    const runLegacy = spawnSync('bash', [installerPath], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
        LAWH_HOME: './my lawh home',
        LAWH_BIN_DIR: './my custom bin',
        LAWH_REPO: 'myfork/lawh',
        LAWH_VERSION: 'v1.0.0',
        LAWH_TARBALL_URL: `file://${legacyTar}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(runLegacy.status, runLegacy.stdout + runLegacy.stderr).toBe(0);

    const lawhHome = join(work, 'my lawh home');
    const binDir = join(work, 'my custom bin');
    const wrapper = join(binDir, 'lawh');

    expect(statSync(lawhHome).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.0');

    // Run wrapper from a DIFFERENT working directory (verifies relative LAWH_HOME was normalized to absolute)
    // AND verifies legacy v1.0.0 wrapper fallback handles `version`.
    const verLegacy = spawnSync(wrapper, ['version'], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome } });
    expect(verLegacy.status, verLegacy.stderr).toBe(0);
    expect(verLegacy.stdout.trim()).toBe('lawh v1.0.0');

    // Seed local instance state.
    const cfgPath = join(lawhHome, 'app/lawh.config.json');
    const appWrangler = join(lawhHome, 'app/wrangler.app.jsonc');
    const contentWrangler = join(lawhHome, 'app/wrangler.content.jsonc');
    const wranglerDir = join(lawhHome, 'app/.wrangler');
    mkdirSync(wranglerDir, { recursive: true });
    writeFileSync(cfgPath, '{"instance":{"name":{"en":"KeepMe"}}}\n', { mode: 0o600 });
    chmodSync(cfgPath, 0o600);
    writeFileSync(appWrangler, '{"name":"lawh-app"}\n');
    writeFileSync(contentWrangler, '{"name":"lawh-content"}\n');
    writeFileSync(join(wranglerDir, 'lawh-upgrade.json'), '{"bookmark":"bm-1"}\n', { mode: 0o600 });

    // Run `lawh self-update` from legacy v1.0.0 WITHOUT re-exporting LAWH_HOME, LAWH_BIN_DIR, or LAWH_REPO!
    const runUp = spawnSync(wrapper, ['self-update'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        LAWH_VERSION: 'v1.0.1',
        LAWH_TARBALL_URL: `file://${tar101}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(runUp.status, runUp.stdout + runUp.stderr).toBe(0);
    expect(runUp.stdout).toContain('Existing instance config preserved');
    // Custom bin dir & fork repo must be preserved — no second wrapper leaked into $HOME/.local/bin.
    expect(existsSync(join(fakeHome, '.local/bin/lawh'))).toBe(false);
    const meta = JSON.parse(readFileSync(join(lawhHome, 'install.json'), 'utf8'));
    expect(meta).toMatchObject({ home: lawhHome, binDir, repo: 'myfork/lawh', version: 'v1.0.1' });

    const ver101 = spawnSync(wrapper, ['version'], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome } });
    expect(ver101.status, ver101.stderr).toBe(0);
    expect(ver101.stdout.trim()).toBe('lawh v1.0.1');
    expect(readFileSync(cfgPath, 'utf8')).toContain('KeepMe');
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(appWrangler, 'utf8')).toContain('lawh-app');
    expect(readFileSync(contentWrangler, 'utf8')).toContain('lawh-content');
    expect(readFileSync(join(wranglerDir, 'lawh-upgrade.json'), 'utf8')).toContain('bm-1');

    // Malformed package.json fails in staging before activation and leaves existing install intact with zero staging leftovers.
    const runBadPkg = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: fakeHome,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_VERSION: 'v1.0.3',
        LAWH_TARBALL_URL: `file://${badPkgTar}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(runBadPkg.status).not.toBe(0);
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.1');
    expect(readdirSync(lawhHome).filter((n) => n.startsWith('.staging.'))).toEqual([]);

    // Post-swap failure rolls back app symlink, version, wrapper, and removes failed release dir + staging dirs.
    const releasesBefore = readdirSync(join(lawhHome, 'releases'));
    const runPostSwapFail = spawnSync(wrapper, ['self-update'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        LAWH_VERSION: 'v1.0.2',
        LAWH_TARBALL_URL: `file://${tar102}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
        LAWH_TEST_FAIL_AFTER_SWAP: '1',
      },
    });
    expect(runPostSwapFail.status).not.toBe(0);
    expect(runPostSwapFail.stderr).toContain('Simulated failure after app swap');
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.1');
    expect(readFileSync(cfgPath, 'utf8')).toContain('KeepMe');
    expect(spawnSync(wrapper, ['version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: fakeHome } }).stdout.trim()).toBe('lawh v1.0.1');
    expect(readdirSync(join(lawhHome, 'releases'))).toEqual(releasesBefore);
    expect(readdirSync(lawhHome).filter((n) => n.startsWith('.staging.') || n.startsWith('.version.') || n.startsWith('.app.'))).toEqual([]);
  });

  it('rejects reserved archive entries, wrapper collisions, invalid tags/repos/URLs, and concurrent installs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh-install-guards-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));

    const lawhHome = join(work, 'home');
    const binDir = join(work, 'bin');
    const validTar = makeReleaseTarball(work, '1.0.1');

    // Reserved local-state file inside archive is rejected.
    const reservedCfgTar = makeReleaseTarball(work, '1.0.1', { includeReserved: 'lawh.config.json' });
    const resCfg = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${reservedCfgTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resCfg.status).not.toBe(0);
    expect(resCfg.stderr).toContain('reserved local state path: lawh.config.json');

    const reservedWranglerTar = makeReleaseTarball(work, '1.0.1', { includeReserved: '.wrangler' });
    const resWr = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${reservedWranglerTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resWr.status).not.toBe(0);
    expect(resWr.stderr).toContain('reserved local state path: .wrangler');

    // Wrapper collision: existing directory named `lawh`.
    mkdirSync(join(binDir, 'lawh'), { recursive: true });
    const resDir = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${validTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resDir.status).not.toBe(0);
    expect(resDir.stderr).toContain('existing directory');
    rmSync(join(binDir, 'lawh'), { recursive: true, force: true });

    // Wrapper collision: unrelated existing file named `lawh`.
    writeFileSync(join(binDir, 'lawh'), '#!/bin/sh\necho unrelated\n', { mode: 0o755 });
    const resUnmanaged = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${validTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resUnmanaged.status).not.toBe(0);
    expect(resUnmanaged.stderr).toContain('unmanaged file');
    expect(readFileSync(join(binDir, 'lawh'), 'utf8')).toContain('unrelated');
    rmSync(join(binDir, 'lawh'));

    // Multiline tag, invalid repo, option-injection URL, and non-loopback HTTP URL are all rejected.
    for (const [label, extraEnv, expected] of [
      ['multiline tag', { LAWH_VERSION: 'v1.0.1\n../evil' }, 'Invalid release tag'],
      ['invalid repo', { LAWH_REPO: 'bad repo/with spaces' }, 'Invalid LAWH_REPO'],
      ['option URL', { LAWH_API_URL: '--config=/etc/passwd' }, 'Invalid LAWH_API_URL'],
      ['non-loopback http', { LAWH_TARBALL_URL: 'http://example.com/a.tar.gz', LAWH_VERSION: 'v1.0.1' }, 'must use https://'],
    ] as const) {
      const r = spawnSync('bash', [installerPath], {
        encoding: 'utf8',
        env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_SKIP_INSTALL_DEPS: '1', ...extraEnv },
      });
      expect(r.status, label).not.toBe(0);
      expect(r.stderr, label).toContain(expected);
    }

    // Concurrent installer serialization: holding a live PID lock causes the second installer to exit cleanly without touching state.
    mkdirSync(join(lawhHome, '.install.lock'), { recursive: true });
    writeFileSync(join(lawhHome, '.install.lock/pid'), `${process.pid}\n`);
    const resLocked = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${validTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resLocked.status).not.toBe(0);
    expect(resLocked.stderr).toContain('already running');
    rmSync(join(lawhHome, '.install.lock'), { recursive: true, force: true });

    // Symlinked local state file in an existing install is refused rather than followed.
    const okInstall = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${validTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(okInstall.status, okInstall.stdout + okInstall.stderr).toBe(0);
    const outside = join(work, 'outside.txt');
    writeFileSync(outside, 'secret-outside');
    symlinkSync(outside, join(lawhHome, 'app/lawh.config.json'));
    const resSym = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_HOME: lawhHome, LAWH_BIN_DIR: binDir, LAWH_VERSION: 'v1.0.1', LAWH_TARBALL_URL: `file://${validTar}`, LAWH_SKIP_INSTALL_DEPS: '1' },
    });
    expect(resSym.status).not.toBe(0);
    expect(resSym.stderr).toContain('symlinked local state file');
  });

  it('resolves latest release via loopback HTTP API and downloads tarball over HTTP', async () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh-install-http-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const tar = makeReleaseTarball(work, '1.0.1');
    const tarBytes = readFileSync(tar);

    const server: Server = createServer((req, res) => {
      if (req.url === '/repos/example/lawh/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag_name: 'v1.0.1' }));
        return;
      }
      if (req.url === '/example/lawh/archive/refs/tags/v1.0.1.tar.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(tarBytes);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const { port } = server.address() as { port: number };

    const lawhHome = join(work, 'home');
    const binDir = join(work, 'bin');
    const run = await runAsync('bash', [installerPath], {
      env: {
        ...process.env,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_REPO: 'example/lawh',
        LAWH_API_URL: `http://127.0.0.1:${port}`,
        LAWH_ARCHIVE_BASE: `http://127.0.0.1:${port}`,
        LAWH_VERSION: 'latest',
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.1');
  });

  it('aligns Wrangler credential resolution (~/.wrangler + expiry), interactive init login, and managed recovery messages', async () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh-cli-auth-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));

    // 1) Legacy ~/.wrangler/config/default.toml is discovered when ~/.wrangler exists.
    const legacyHome = join(work, 'legacy-home');
    mkdirSync(join(legacyHome, '.wrangler/config'), { recursive: true });
    writeFileSync(
      join(legacyHome, '.wrangler/config/default.toml'),
      'oauth_token = "legacy-tok"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n',
    );
    expect(readCloudflareToken({}, legacyHome)).toBe('legacy-tok');

    // 2) Expired OAuth token throws MissingCloudflareTokenError with expired=true.
    const expiredHome = join(work, 'expired-home');
    mkdirSync(join(expiredHome, '.wrangler/config'), { recursive: true });
    writeFileSync(
      join(expiredHome, '.wrangler/config/default.toml'),
      'oauth_token = "old-tok"\nexpiration_time = "2020-01-01T00:00:00.000Z"\n',
    );
    let caught: unknown;
    try { readCloudflareToken({}, expiredHome); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(MissingCloudflareTokenError);
    expect((caught as { expired?: boolean }).expired).toBe(true);

    // 3) Interactive `init` with missing token prompts to run Wrangler login and succeeds into Cloudflare API call;
    // non-TTY `init` fails cleanly without prompting.
    const emptyHome = join(work, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const mockWrangler = join(work, 'mock-wrangler.cjs');
    writeFileSync(
      mockWrangler,
      `const fs = require('node:fs');
       const path = require('node:path');
       const dir = path.join(process.env.HOME, '.wrangler/config');
       fs.mkdirSync(dir, { recursive: true });
       fs.writeFileSync(path.join(dir, 'default.toml'), 'oauth_token = "fresh-login-tok"\\nexpiration_time = "2099-01-01T00:00:00.000Z"\\n');
       console.log('MOCK_WRANGLER_' + process.argv[2]);
      `,
    );

    const nonTty = await runAsync(process.execPath, [join(repoRoot, 'scripts/lawh.mjs'), 'init'], {
      env: { PATH: process.env.PATH, HOME: emptyHome, LAWH_WRANGLER_BIN: mockWrangler },
    });
    expect(nonTty.status).not.toBe(0);
    expect(nonTty.stderr).toContain('Not signed in to Cloudflare');
    expect(nonTty.stdout).not.toContain('MOCK_WRANGLER_login');

    // Mock Cloudflare API returning an error after login succeeds, proving `init` picked up the token written by mock Wrangler login.
    let sawAuth = '';
    const cfServer: Server = createServer((req, res) => {
      sawAuth = req.headers.authorization ?? '';
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Mock stop after auth' }] }));
    });
    await new Promise<void>((resolve) => cfServer.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => cfServer.close());
    const cfPort = (cfServer.address() as { port: number }).port;

    const ttyRun = await runAsync(process.execPath, [join(repoRoot, 'scripts/lawh.mjs'), 'init'], {
      env: {
        PATH: process.env.PATH,
        HOME: emptyHome,
        LAWH_WRANGLER_BIN: mockWrangler,
        LAWH_FORCE_TTY: '1',
        CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${cfPort}`,
      },
      stdin: 'y\n',
    });
    expect(ttyRun.stdout).toContain('MOCK_WRANGLER_login');
    expect(sawAuth).toBe('Bearer fresh-login-tok');
    expect(ttyRun.stderr).toContain('Mock stop after auth');

    // 4) Managed-mode `runUpgrade` prints `lawh init` when config is missing and absolute runnable restore command on migration failure.
    const emptyRoot = join(work, 'managed-root');
    mkdirSync(emptyRoot, { recursive: true });
    await expect(runUpgrade({ root: emptyRoot, cf: {} as never, bin: 'lawh', managed: true })).rejects.toThrow('Run `lawh init` first.');

    const managedMigRoot = join(work, 'managed-mig-root');
    mkdirSync(join(managedMigRoot, 'migrations'), { recursive: true });
    writeFileSync(join(managedMigRoot, 'migrations/0001_bad.sql'), 'BROKEN SQL;');
    writeFileSync(join(managedMigRoot, 'lawh.config.json'), JSON.stringify({
      instance: { name: { en: 'Lawh', ar: 'لوح' }, accent: '#e0b15a', icon: 'default', defaultLang: 'en', defaultTheme: 'dark' },
      hosts: { mode: 'custom', app: 'https://lawh.example.com', content: 'https://lawh-content.example.com' },
      secrets: { backend: 'worker_secrets', storeName: 'lawh-secrets' },
      workers: { app: 'lawh-app', content: 'lawh-content' },
      resources: {
        accountId: 'acct_test',
        database: { name: 'lawh-db', id: 'db_test' },
        bucket: { name: 'lawh-files', created: true },
        queue: { name: 'lawh-webhooks', id: 'q_test' },
        deadLetterQueue: { name: 'lawh-webhooks-dlq', id: 'dlq_test' },
        secretsStore: { id: '', created: false, secrets: {} },
        workersCreated: { app: true, content: true },
      },
    }));
    const mockCfForUpgrade = {
      queryD1: async (_acct: string, _db: string, sql: string) => {
        if (sql.includes('CREATE TABLE') || sql.includes('SELECT name FROM d1_migrations')) return [{ results: [] }];
        throw new Error('syntax error near BROKEN');
      },
      getD1Bookmark: async () => ({ bookmark: 'bm-managed-123' }),
      listWorkerDeployments: async () => [{ versions: [{ version_id: 'ver_prev_1' }] }],
    };
    const logs: string[] = [];
    let upgradeErr: (Error & { restoreCommand?: string }) | null = null;
    try {
      await runUpgrade({ root: managedMigRoot, cf: mockCfForUpgrade as never, log: (m: string) => logs.push(m), bin: 'lawh', managed: true });
    } catch (e) {
      upgradeErr = e as Error & { restoreCommand?: string };
    }
    expect(upgradeErr?.restoreCommand).toContain(`node "${join(managedMigRoot, 'node_modules/wrangler/bin/wrangler.js')}" d1 time-travel restore lawh-db --bookmark=bm-managed-123 -c "${join(managedMigRoot, 'wrangler.app.jsonc')}"`);

    // 5) Repo-mode `version` and `self-update` guidance.
    const ver = spawnSync(process.execPath, [join(repoRoot, 'scripts/lawh.mjs'), 'version'], { encoding: 'utf8' });
    expect(ver.status, ver.stderr).toBe(0);
    expect(ver.stdout.trim()).toMatch(/^lawh v\d+\.\d+\.\d+/);

    const selfUp = spawnSync(process.execPath, [join(repoRoot, 'scripts/lawh.mjs'), 'self-update'], {
      encoding: 'utf8',
      env: { ...process.env, LAWH_MANAGED_INSTALL: '0' },
    });
    expect(selfUp.status, selfUp.stderr).toBe(0);
    expect(selfUp.stdout).toContain('git pull && pnpm install && pnpm lawh upgrade');
  });
});
