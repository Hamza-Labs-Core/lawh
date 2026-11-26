import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'skills/lawh/lawh.mjs');

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err ? 1 : 0;
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe('lawh.mjs CLI connect & read behavior', () => {
  let server: Server;
  let baseUrl = '';
  let workDir = '';
  let seq = 0;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'lawh-cli-test-'));
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/v1/connect') {
        seq++;
        const id = `key_${String(seq).padStart(26, '0')}`;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, code: 'BBBB-CCCC', url: `${baseUrl}/connect`, expiresAt: Date.now() + 60_000, interval: 1 }));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/connect/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agentId: 'agt_01TEST',
          name: 'shared-agent',
          scopes: ['pages:read'],
          allProjects: false,
          projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
          expiresAt: Date.now() + 86_400_000,
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agentId: 'agt_01TEST',
          name: 'shared-agent',
          auth: req.headers.authorization,
          projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects/one/pages/demo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ currentVersion: 2, title: 'Demo' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/projects/one/pages/demo/versions/2/file') {
        const file = url.searchParams.get('path');
        if (file === 'index.html') {
          // Real /v1/.../file endpoint always sends application/octet-stream!
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end('<h1>Hello</h1>');
          return;
        }
        if (file === 'dot.png') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'not_found', message: 'Not found.' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workDir, { recursive: true, force: true });
  });

  it('keeps separate credentials per program for the same copy and agent name, and survives missing browser opener', async () => {
    const storePath = join(workDir, 'agents.json');
    // Use an empty PATH dir so `open` / `xdg-open` is missing — must NOT crash with ENOENT.
    const emptyBin = join(workDir, 'empty-bin');
    chmodSync(workDir, 0o700);
    const baseEnv = { ...process.env, LAWH_STORE: storePath, LAWH_NO_KEYCHAIN: '1', PATH: emptyBin };

    const c1 = await runCli(['connect', baseUrl, '--client', 'claude', '--poll-ms', '200', '--json'], baseEnv);
    expect(c1.status, c1.stderr).toBe(0);
    const c2 = await runCli(['connect', baseUrl, '--client', 'codex', '--poll-ms', '200', '--json'], baseEnv);
    expect(c2.status, c2.stderr).toBe(0);

    const listed = await runCli(['agents', '--json'], baseEnv);
    expect(listed.status, listed.stderr).toBe(0);
    const items = JSON.parse(listed.stdout).items as { name: string; client: string }[];
    expect(items.map((i) => `${i.name}:${i.client}`).sort()).toEqual(['shared-agent:claude', 'shared-agent:codex']);

    const w1 = await runCli(['whoami', '--client', 'claude', '--json'], baseEnv);
    const w2 = await runCli(['whoami', '--client', 'codex', '--json'], baseEnv);
    expect(w1.status, w1.stderr).toBe(0);
    expect(w2.status, w2.stderr).toBe(0);
    expect(JSON.parse(w1.stdout).auth).not.toBe(JSON.parse(w2.stdout).auth);
  });

  it('outputs valid JSON for read --file --json (UTF-8 for HTML and base64 for binary) and raw bytes without --json', async () => {
    const env = { ...process.env, LAWH_URL: baseUrl, LAWH_KEY: 'lawh_key_00000000000000000000000001_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };

    const htmlJson = await runCli(['read', 'one', 'demo', '--file', 'index.html', '--json'], env);
    expect(htmlJson.status, htmlJson.stderr).toBe(0);
    expect(JSON.parse(htmlJson.stdout)).toMatchObject({
      project: 'one',
      slug: 'demo',
      version: 2,
      path: 'index.html',
      encoding: 'utf8',
      content: '<h1>Hello</h1>',
    });

    const pngJson = await runCli(['read', 'one', 'demo', '--file', 'dot.png', '--json'], env);
    expect(pngJson.status, pngJson.stderr).toBe(0);
    expect(JSON.parse(pngJson.stdout)).toMatchObject({
      path: 'dot.png',
      encoding: 'base64',
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    });

    const htmlRaw = await runCli(['read', 'one', 'demo', '--file', 'index.html'], env);
    expect(htmlRaw.status, htmlRaw.stderr).toBe(0);
    expect(htmlRaw.stdout).toBe('<h1>Hello</h1>');
  });

  it('passes macOS keychain credentials via stdin (`security -i`) and never in argv', async () => {
    if (process.platform !== 'darwin') return;
    const binDir = mkdtempSync(join(tmpdir(), 'lawh-sec-bin-'));
    const argvLog = join(binDir, 'argv.log');
    const savedFile = join(binDir, 'saved.txt');
    const stub = join(binDir, 'security');
    writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args[0] === '-i') {
  const input = fs.readFileSync(0, 'utf8');
  const m = /-w\\s+(\\S+)/.exec(input);
  if (m) fs.writeFileSync(${JSON.stringify(savedFile)}, m[1]);
  process.exit(0);
}
if (args[0] === 'find-generic-password') {
  if (!fs.existsSync(${JSON.stringify(savedFile)})) process.exit(44);
  process.stdout.write(fs.readFileSync(${JSON.stringify(savedFile)}, 'utf8') + '\\n');
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(stub, 0o755);

    const xdg = mkdtempSync(join(tmpdir(), 'lawh-xdg-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: binDir, XDG_CONFIG_HOME: xdg };
      delete env.LAWH_STORE;
      delete env.LAWH_NO_KEYCHAIN;
      const res = await runCli(['connect', baseUrl, '--client', 'claude', '--no-open', '--poll-ms', '200', '--json'], env);
      expect(res.status, res.stderr).toBe(0);
      const loggedArgs = readFileSync(argvLog, 'utf8');
      expect(loggedArgs).toContain('["-i"]');
      expect(loggedArgs).not.toContain('lawh_key_');
      expect(loggedArgs).not.toContain('b64:');
      expect(readFileSync(savedFile, 'utf8')).toMatch(/^b64:/);

      // Simulate stale Keychain (write silently fails, read returns old claude-only entry): fallback file must win!
      writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-i') process.exit(0); // silently fails without updating savedFile
if (args[0] === 'find-generic-password') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(savedFile)}, 'utf8') + '\\n');
  process.exit(0);
}
process.exit(1);
`);
      chmodSync(stub, 0o755);
      const res2 = await runCli(['connect', baseUrl, '--client', 'codex', '--no-open', '--poll-ms', '200', '--json'], env);
      expect(res2.status, res2.stderr).toBe(0);
      const whoCodex = await runCli(['whoami', '--client', 'codex', '--json'], env);
      expect(whoCodex.status, whoCodex.stderr).toBe(0);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
