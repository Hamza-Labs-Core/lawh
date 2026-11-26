import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const installerPath = join(repoRoot, 'install.sh');

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeReleaseTarball(dir: string, version: string): string {
  const srcRoot = join(dir, `lawh-${version}`);
  mkdirSync(join(srcRoot, 'scripts/cli'), { recursive: true });
  mkdirSync(join(srcRoot, 'scripts/local'), { recursive: true });
  writeFileSync(join(srcRoot, 'package.json'), JSON.stringify({ name: 'lawh', version, type: 'module' }));
  writeFileSync(join(srcRoot, 'install.sh'), readFileSync(installerPath, 'utf8'), { mode: 0o755 });
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
  const archive = join(dir, `lawh-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, `lawh-${version}`]);
  return archive;
}

describe('no-clone installer (install.sh) and lawh CLI', () => {
  it('installs from a release tarball into LAWH_HOME, creates executable wrapper, and preserves instance state on update', () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh install test '));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));

    const tar1 = makeReleaseTarball(work, '1.0.0');
    const tar2 = makeReleaseTarball(work, '1.1.0');
    const lawhHome = join(work, 'my lawh home');
    const binDir = join(work, 'my bin');

    const run1 = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_VERSION: 'v1.0.0',
        LAWH_TARBALL_URL: `file://${tar1}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    expect(run1.stdout).toContain('Installed Lawh v1.0.0');
    expect(run1.stdout).toContain('lawh init');

    expect(statSync(lawhHome).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.0');
    expect(existsSync(join(lawhHome, 'app/scripts/lawh.mjs'))).toBe(true);

    const wrapper = join(binDir, 'lawh');
    expect(existsSync(wrapper)).toBe(true);
    const ver1 = spawnSync(wrapper, ['version'], { encoding: 'utf8' });
    expect(ver1.status, ver1.stderr).toBe(0);
    expect(ver1.stdout.trim()).toBe('lawh v1.0.0');

    // Simulate existing deployed instance state (config + generated wrangler files + .wrangler state).
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

    // Re-running installer (or `lawh self-update`) updates code while preserving all instance state.
    const run2 = spawnSync(wrapper, ['self-update'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_VERSION: 'v1.1.0',
        LAWH_TARBALL_URL: `file://${tar2}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(run2.status, run2.stdout + run2.stderr).toBe(0);
    expect(run2.stdout).toContain('Existing instance config preserved');
    expect(run2.stdout).toContain('lawh upgrade');

    const ver2 = spawnSync(wrapper, ['version'], { encoding: 'utf8' });
    expect(ver2.status, ver2.stderr).toBe(0);
    expect(ver2.stdout.trim()).toBe('lawh v1.1.0');
    expect(readFileSync(cfgPath, 'utf8')).toContain('KeepMe');
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(appWrangler, 'utf8')).toContain('lawh-app');
    expect(readFileSync(contentWrangler, 'utf8')).toContain('lawh-content');
    expect(readFileSync(join(wranglerDir, 'lawh-upgrade.json'), 'utf8')).toContain('bm-1');

    // Corrupt tarball fails cleanly without destroying the existing install or leaving staging dirs behind.
    const badTar = join(work, 'corrupt.tar.gz');
    writeFileSync(badTar, 'not-a-tarball');
    const runBad = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_VERSION: 'v1.2.0',
        LAWH_TARBALL_URL: `file://${badTar}`,
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(runBad.status).not.toBe(0);
    expect(readFileSync(cfgPath, 'utf8')).toContain('KeepMe');
    const verStill = spawnSync(wrapper, ['version'], { encoding: 'utf8' });
    expect(verStill.stdout.trim()).toBe('lawh v1.1.0');
  });

  it('resolves latest release via HTTP API and downloads tarball over HTTP', async () => {
    const work = mkdtempSync(join(tmpdir(), 'lawh-install-http-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const tar = makeReleaseTarball(work, '1.0.0');
    const tarBytes = readFileSync(tar);

    const server: Server = createServer((req, res) => {
      if (req.url === '/repos/example/lawh/releases/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag_name: 'v1.0.0' }));
        return;
      }
      if (req.url === '/example/lawh/archive/refs/tags/v1.0.0.tar.gz') {
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
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('bash', [installerPath], {
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
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(readFileSync(join(lawhHome, 'version'), 'utf8').trim()).toBe('v1.0.0');

    // Also verify invalid release tags are rejected before any download.
    const badTag = spawnSync('bash', [installerPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAWH_HOME: lawhHome,
        LAWH_BIN_DIR: binDir,
        LAWH_VERSION: '../evil',
        LAWH_SKIP_INSTALL_DEPS: '1',
      },
    });
    expect(badTag.status).not.toBe(0);
    expect(badTag.stderr).toContain('Invalid release tag');
  });

  it('reports version and repo-mode guidance from scripts/lawh.mjs', () => {
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
