import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script
import { buildUi } from '../../scripts/build-ui.mjs';
// @ts-expect-error plain ESM script
import { createCloudflareClient, readCloudflareToken } from '../../scripts/cli/cloudflare.mjs';
// @ts-expect-error plain ESM script
import { runDestroy, runInit, runRollback, runUpgrade } from '../../scripts/cli/commands.mjs';
// @ts-expect-error plain ESM script
import { assertOutsideRepo } from '../../scripts/cli/export.mjs';
// @ts-expect-error plain ESM script
import { parseJsonc } from '../../scripts/local/jsonc.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const ACCOUNT_ID = 'acct_00000000000000000000000000000001';
const SUBDOMAIN = 'acme-test';
const TOKEN = 'test-cf-token-12345';

interface MockWorker {
  name: string;
  versions: { id: string; metadata: Record<string, unknown> }[];
  deployments: { id: string; versions: { version_id: string; percentage: number }[]; message: string }[];
  secrets: Record<string, string>;
}

interface MockD1 {
  uuid: string;
  name: string;
  db: InstanceType<typeof DatabaseSync>;
  bookmarkSeq: number;
  bookmarks: Map<string, string[]>;
}

interface MockCloudflareState {
  d1: Map<string, MockD1>;
  r2: Map<string, Map<string, Buffer>>;
  queues: Map<string, { queue_id: string; queue_name: string }>;
  stores: Map<string, { id: string; name: string; secrets: Map<string, { id: string; name: string; value: string }> }>;
  workers: Map<string, MockWorker>;
  subdomain: string | null;
  calls: { method: string; path: string }[];
  failAtCall: number | null;
  dropAfterCommitOn: { method: string; pathEndsWith: string } | null;
  secretsStoreMode: 'ok' | 'forbidden' | 'conflict';
  r2PageSize: number;
  hostStatus: { app: number; content: number; appHeaders?: Record<string, string>; contentHeaders?: Record<string, string>; contentBody?: string };
}

/**
 * Local HTTP mock of the Cloudflare v4 REST API backed by real SQLite (with FTS5 & triggers).
 * Rejects what real Cloudflare rejects, including D1 export when an FTS virtual table exists.
 */
async function startMockCloudflare() {
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}_${String(++idCounter).padStart(8, '0')}`;

  const state: MockCloudflareState = {
    d1: new Map(),
    r2: new Map(),
    queues: new Map(),
    stores: new Map(),
    workers: new Map(),
    subdomain: SUBDOMAIN,
    calls: [],
    failAtCall: null,
    dropAfterCommitOn: null,
    secretsStoreMode: 'ok',
    r2PageSize: 2,
    hostStatus: { app: 200, content: 404 },
  };

  function seedNonLawhResources() {
    const foreignDb = new DatabaseSync(':memory:');
    foreignDb.exec('CREATE TABLE keep_me(id INTEGER PRIMARY KEY)');
    state.d1.set('d1_foreign_keep', { uuid: 'd1_foreign_keep', name: 'unrelated-blog', db: foreignDb, bookmarkSeq: 0, bookmarks: new Map() });
    state.r2.set('unrelated-media', new Map([['photo.jpg', Buffer.from('jpeg-data')]]));
    state.queues.set('q_foreign_keep', { queue_id: 'q_foreign_keep', queue_name: 'unrelated-jobs' });
    state.stores.set('ss_foreign_keep', {
      id: 'ss_foreign_keep',
      name: 'unrelated-store',
      secrets: new Map([['sec_foreign', { id: 'sec_foreign', name: 'OTHER_KEY', value: 'keep' }]]),
    });
    state.workers.set('unrelated-worker', {
      name: 'unrelated-worker',
      versions: [{ id: 'ver_foreign_1', metadata: {} }],
      deployments: [{ id: 'dep_foreign_1', versions: [{ version_id: 'ver_foreign_1', percentage: 100 }], message: 'init' }],
      secrets: { OTHER: 'secret' },
    });
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function ok(res: ServerResponse, result: unknown, status = 200) {
    json(res, status, { success: true, errors: [], messages: [], result });
  }

  function fail(res: ServerResponse, status: number, code: number, message: string) {
    json(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    // Worker host health-check routes (simulated via custom fetchImpl too).
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      fail(res, 401, 10000, 'Authentication error');
      return;
    }

    state.calls.push({ method, path: url.pathname });
    if (state.failAtCall !== null && state.calls.length === state.failAtCall) {
      state.failAtCall = null;
      fail(res, 503, 50000, 'Injected transient interruption');
      return;
    }

    const bodyText = method === 'GET' || method === 'DELETE' ? '' : await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};

    // Accounts & subdomain
    if (method === 'GET' && url.pathname === '/client/v4/accounts') {
      ok(res, [{ id: ACCOUNT_ID, name: 'Test Account' }]);
      return;
    }
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`) {
      if (method === 'GET') {
        if (!state.subdomain) { fail(res, 404, 10007, 'Subdomain not registered'); return; }
        ok(res, { subdomain: state.subdomain });
        return;
      }
      if (method === 'PUT') {
        state.subdomain = String(body.subdomain);
        ok(res, { subdomain: state.subdomain });
        return;
      }
    }

    // D1
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/d1/database`) {
      if (method === 'GET') {
        ok(res, [...state.d1.values()].map(({ uuid, name }) => ({ uuid, name })));
        return;
      }
      if (method === 'POST') {
        if ([...state.d1.values()].some((d) => d.name === body.name)) {
          fail(res, 409, 7502, `D1 database ${body.name} already exists`);
          return;
        }
        const uuid = nextId('d1');
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys = ON');
        state.d1.set(uuid, { uuid, name: body.name, db, bookmarkSeq: 0, bookmarks: new Map() });
        if (state.dropAfterCommitOn && state.dropAfterCommitOn.method === 'POST' && url.pathname.endsWith(state.dropAfterCommitOn.pathEndsWith)) {
          state.dropAfterCommitOn = null;
          fail(res, 502, 50002, 'Dropped response after remote commit');
          return;
        }
        ok(res, { uuid, name: body.name }, 201);
        return;
      }
    }

    const d1Match = new RegExp(`^/client/v4/accounts/${ACCOUNT_ID}/d1/database/([^/]+)(/.*)?$`).exec(url.pathname);
    if (d1Match) {
      const dbId = decodeURIComponent(d1Match[1]!);
      const sub = d1Match[2] ?? '';
      const entry = state.d1.get(dbId);
      if (!entry) { fail(res, 404, 7404, 'D1 database not found'); return; }

      if (method === 'DELETE' && sub === '') {
        entry.db.close();
        state.d1.delete(dbId);
        ok(res, {});
        return;
      }
      if (method === 'POST' && sub === '/export') {
        // Real Cloudflare D1 rejects export/re-import when virtual tables (e.g. FTS5) exist.
        const vt = entry.db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%VIRTUAL TABLE%' LIMIT 1").get();
        if (vt) {
          fail(res, 400, 7500, 'Export is not supported for databases containing virtual tables (pages_fts).');
          return;
        }
        ok(res, { status: 'complete', signed_url: 'https://example.invalid/dump.sql' });
        return;
      }
      if (method === 'GET' && sub === '/time_travel/bookmark') {
        entry.bookmarkSeq++;
        const bookmark = `00000000-${String(entry.bookmarkSeq).padStart(8, '0')}-00000000-abcdef0123456789`;
        ok(res, { bookmark });
        return;
      }
      if (method === 'POST' && sub === '/query') {
        try {
          const sql = String(body.sql ?? '');
          const params = (Array.isArray(body.params) ? body.params : []) as SQLInputValue[];
          const isSingleSelect = /^\s*(?:SELECT|WITH)\b/i.test(sql);
          if (params.length > 0 || isSingleSelect) {
            const stmt = entry.db.prepare(sql);
            const results = isSingleSelect || /\bRETURNING\b/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
            ok(res, [{ results, success: true }]);
          } else {
            // Execute multi-statement SQL atomically (matching Cloudflare D1 batch behavior).
            entry.db.exec('BEGIN');
            try {
              entry.db.exec(sql);
              entry.db.exec('COMMIT');
            } catch (txErr) {
              try { entry.db.exec('ROLLBACK'); } catch { /* ignore */ }
              throw txErr;
            }
            ok(res, [{ results: [], success: true }]);
          }
        } catch (err) {
          fail(res, 400, 7500, err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // R2
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`) {
      if (method === 'GET') {
        ok(res, { buckets: [...state.r2.keys()].map((name) => ({ name })) });
        return;
      }
      if (method === 'POST') {
        if (state.r2.has(body.name)) { fail(res, 409, 10004, 'Bucket already exists'); return; }
        state.r2.set(body.name, new Map());
        ok(res, { name: body.name }, 201);
        return;
      }
    }
    const r2BucketMatch = new RegExp(`^/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/([^/]+)(?:/objects(?:/(.+))?)?$`).exec(url.pathname);
    if (r2BucketMatch) {
      const bucketName = decodeURIComponent(r2BucketMatch[1]!);
      const objKey = r2BucketMatch[2] ? decodeURIComponent(r2BucketMatch[2]) : null;
      const bucket = state.r2.get(bucketName);
      if (!bucket) { fail(res, 404, 10006, 'Bucket not found'); return; }
      if (url.pathname.endsWith('/objects') && method === 'GET') {
        // Real Cloudflare R2 List Objects API uses keyset pagination with metadata in result_info.
        const allKeys = [...bucket.keys()].sort();
        const cursor = url.searchParams.get('cursor') ?? '';
        const remaining = cursor ? allKeys.filter((k) => k > cursor) : allKeys;
        const page = remaining.slice(0, state.r2PageSize);
        const isTruncated = remaining.length > page.length;
        json(res, 200, {
          success: true,
          errors: [],
          messages: [],
          result: page.map((key) => ({ key })),
          result_info: {
            count: page.length,
            is_truncated: isTruncated,
            ...(isTruncated ? { cursor: page.at(-1) } : {}),
          },
        });
        return;
      }
      if (objKey !== null) {
        if (method === 'GET') {
          const data = bucket.get(objKey);
          if (!data) { fail(res, 404, 10007, 'Object not found'); return; }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(data);
          return;
        }
        if (method === 'DELETE') {
          if (!bucket.has(objKey)) { fail(res, 404, 10007, 'Object not found'); return; }
          bucket.delete(objKey);
          ok(res, {});
          return;
        }
      }
      if (method === 'DELETE' && !url.pathname.includes('/objects')) {
        if (bucket.size > 0) { fail(res, 409, 10008, 'Bucket is not empty'); return; }
        state.r2.delete(bucketName);
        ok(res, {});
        return;
      }
    }

    // Queues
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/queues`) {
      if (method === 'GET') { ok(res, [...state.queues.values()]); return; }
      if (method === 'POST') {
        if ([...state.queues.values()].some((q) => q.queue_name === body.queue_name)) {
          fail(res, 409, 11009, 'Queue already exists');
          return;
        }
        const queue_id = nextId('q');
        const q = { queue_id, queue_name: body.queue_name };
        state.queues.set(queue_id, q);
        ok(res, q, 201);
        return;
      }
    }
    const qMatch = new RegExp(`^/client/v4/accounts/${ACCOUNT_ID}/queues/([^/]+)$`).exec(url.pathname);
    if (qMatch && method === 'DELETE') {
      const qId = decodeURIComponent(qMatch[1]!);
      if (!state.queues.has(qId)) { fail(res, 404, 11000, 'Queue not found'); return; }
      state.queues.delete(qId);
      ok(res, {});
      return;
    }

    // Secrets Store
    if (url.pathname.startsWith(`/client/v4/accounts/${ACCOUNT_ID}/secrets_store/`)) {
      if (state.secretsStoreMode === 'forbidden') {
        fail(res, 403, 9109, 'Secrets Store quota exceeded or not enabled on this account');
        return;
      }
      if (state.secretsStoreMode === 'conflict' && method === 'POST') {
        fail(res, 409, 9110, 'A store already exists');
        return;
      }
      if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/secrets_store/stores`) {
        if (method === 'GET') { ok(res, [...state.stores.values()].map(({ id, name }) => ({ id, name }))); return; }
        if (method === 'POST') {
          const id = nextId('ss');
          state.stores.set(id, { id, name: body.name, secrets: new Map() });
          ok(res, { id, name: body.name }, 201);
          return;
        }
      }
      const ssMatch = new RegExp(`^/client/v4/accounts/${ACCOUNT_ID}/secrets_store/stores/([^/]+)(?:/secrets(?:/([^/]+))?)?$`).exec(url.pathname);
      if (ssMatch) {
        const storeId = decodeURIComponent(ssMatch[1]!);
        const secretId = ssMatch[2] ? decodeURIComponent(ssMatch[2]) : null;
        const store = state.stores.get(storeId);
        if (!store) { fail(res, 404, 9404, 'Store not found'); return; }
        if (method === 'DELETE' && !url.pathname.includes('/secrets')) {
          if (store.secrets.size > 0) { fail(res, 409, 9409, 'Store still contains secrets'); return; }
          state.stores.delete(storeId);
          ok(res, {});
          return;
        }
        if (url.pathname.endsWith('/secrets') && method === 'GET') {
          ok(res, [...store.secrets.values()].map(({ id, name }) => ({ id, name })));
          return;
        }
        if (url.pathname.endsWith('/secrets') && method === 'POST') {
          const items = Array.isArray(body) ? body : [body];
          const created = items.map((s) => {
            const id = nextId('sec');
            store.secrets.set(id, { id, name: s.name, value: s.value });
            return { id, name: s.name };
          });
          ok(res, created, 201);
          return;
        }
        if (secretId && method === 'DELETE') {
          if (!store.secrets.has(secretId)) { fail(res, 404, 9404, 'Secret not found'); return; }
          store.secrets.delete(secretId);
          ok(res, {});
          return;
        }
      }
    }

    // Workers (versions, deployments, secrets, delete)
    const workerMatch = new RegExp(`^/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)(/.*)?$`).exec(url.pathname);
    if (workerMatch) {
      const scriptName = decodeURIComponent(workerMatch[1]!);
      const sub = workerMatch[2] ?? '';
      if (method === 'POST' && sub === '/versions') {
        let w = state.workers.get(scriptName);
        if (!w) {
          w = { name: scriptName, versions: [], deployments: [], secrets: {} };
          state.workers.set(scriptName, w);
        }
        const verId = nextId('ver');
        w.versions.unshift({ id: verId, metadata: body });
        ok(res, { id: verId }, 201);
        return;
      }
      const w = state.workers.get(scriptName);
      if (!w) { fail(res, 404, 10007, `Worker ${scriptName} not found`); return; }
      if (method === 'GET' && sub === '/deployments') {
        ok(res, { deployments: w.deployments });
        return;
      }
      if (method === 'POST' && sub === '/deployments') {
        const versionId = body.versions?.[0]?.version_id;
        if (!w.versions.some((v) => v.id === versionId)) {
          fail(res, 404, 10007, `Version ${versionId} not found`);
          return;
        }
        const dep = { id: nextId('dep'), versions: body.versions, message: body.annotations?.['workers/message'] ?? '' };
        w.deployments.unshift(dep);
        ok(res, dep, 201);
        return;
      }
      if (method === 'PUT' && sub === '/secrets') {
        w.secrets[body.name] = body.text;
        ok(res, { name: body.name, type: body.type });
        return;
      }
      if (method === 'DELETE' && sub === '') {
        state.workers.delete(scriptName);
        ok(res, {});
        return;
      }
    }

    fail(res, 404, 10000, `Unhandled mock route: ${method} ${url.pathname}`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
  const apiBase = `http://127.0.0.1:${addr.port}/client/v4`;

  function createDeployWorker() {
    return async ({ cf, accountId, workerName, configFile, root }: { cf: ReturnType<typeof createCloudflareClient>; accountId: string; workerName: string; configFile: string; root: string }) => {
      const parsed = parseJsonc(readFileSync(join(root, configFile), 'utf8'));
      const ver = await cf.createWorkerVersion(accountId, workerName, { config: parsed });
      await cf.createWorkerDeployment(accountId, workerName, ver.id, 'deploy');
      return ver.id as string;
    };
  }

  function createHealthFetch() {
    return async (url: string | URL) => {
      const u = String(url);
      if (u.includes('lawh-app')) {
        return new Response('<!doctype html><title>Lawh</title>', {
          status: state.hostStatus.app,
          headers: state.hostStatus.appHeaders ?? {
            'Content-Type': 'text/html; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'",
          },
        });
      }
      if (u.includes('lawh-content')) {
        return new Response(state.hostStatus.contentBody ?? JSON.stringify({ code: 'not_found', message: 'Not found.' }), {
          status: state.hostStatus.content,
          headers: state.hostStatus.contentHeaders ?? {
            'Content-Type': 'application/json',
            'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'",
          },
        });
      }
      return new Response('ok', { status: 200 });
    };
  }

  return {
    apiBase,
    state,
    seedNonLawhResources,
    createDeployWorker,
    createHealthFetch,
    close: () => new Promise<void>((resolve) => {
      for (const d of state.d1.values()) d.db.close();
      server.close(() => resolve());
    }),
  };
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'lawh-s15-ws-'));
  cpSync(join(repoRoot, 'migrations'), join(dir, 'migrations'), { recursive: true });
  return dir;
}

function scriptedPrompt(answers: string[]) {
  let i = 0;
  return async () => answers[i++] ?? '';
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('S15 self-hosting lifecycle (init, upgrade, rollback, destroy)', () => {
  it('runs a clean init -> upgrade -> rollback -> destroy cycle while leaving non-Lawh resources untouched', async () => {
    const mock = await startMockCloudflare();
    cleanups.push(() => mock.close());
    mock.seedNonLawhResources();

    const ws = makeWorkspace();
    const outHome = mkdtempSync(join(tmpdir(), 'lawh-s15-home-'));
    cleanups.push(() => { rmSync(ws, { recursive: true, force: true }); rmSync(outHome, { recursive: true, force: true }); });

    const cf = createCloudflareClient({ apiBase: mock.apiBase, token: TOKEN });
    const logs: string[] = [];

    // 1) INIT
    const initRes = await runInit({
      root: ws,
      cf,
      prompt: scriptedPrompt([
        'Acme Lawh',    // English instance name
        'لوح أكمي',     // Arabic instance name
        '',             // workers.dev
        'yes',          // confirm cost/plan
        'Sara',         // owner name
        'design',       // first project slug
        'Design',       // first project name en
        'التصميم',      // first project name ar
        'yes',          // turn instance switch on
      ]),
      log: (m: string) => logs.push(m),
      deployWorker: mock.createDeployWorker(),
    });

    expect(initRes.instanceOn).toBe(true);
    expect(initRes.setupLink).toMatch(new RegExp(`^https://lawh-app\\.${SUBDOMAIN}\\.workers\\.dev/link#[A-Za-z0-9_-]{43}$`));

    // Generated Wrangler configs pin account_id, include LiveProject DO + v1 migration and Secrets Store bindings.
    const appWrangler = parseJsonc(readFileSync(join(ws, 'wrangler.app.jsonc'), 'utf8'));
    const contentWrangler = parseJsonc(readFileSync(join(ws, 'wrangler.content.jsonc'), 'utf8'));
    expect(appWrangler.account_id).toBe(ACCOUNT_ID);
    expect(contentWrangler.account_id).toBe(ACCOUNT_ID);
    expect(appWrangler.durable_objects).toEqual({ bindings: [{ name: 'LIVE', class_name: 'LiveProject' }] });
    expect(appWrangler.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['LiveProject'] }]);
    expect(appWrangler.secrets_store_secrets).toHaveLength(4);
    expect(contentWrangler.secrets_store_secrets).toHaveLength(1);

    // Seed 5 R2 objects (so r2PageSize=2 tests multi-page result_info pagination during destroy!) + 1 blob row.
    const dbEntry = mock.state.d1.get(initRes.config.resources.database.id)!;
    const fileBytes = Buffer.from('<h1>Exported Page</h1>');
    const sha = 'a'.repeat(64);
    dbEntry.db.exec(`INSERT INTO blobs(sha256, r2_key, bytes, created_at) VALUES('${sha}', 'blobs/${sha}/01TEST', ${fileBytes.byteLength}, 1000)`);
    const r2Bucket = mock.state.r2.get('lawh-files')!;
    r2Bucket.set(`blobs/${sha}/01TEST`, fileBytes);
    for (let k = 1; k <= 4; k++) r2Bucket.set(`blobs/extra/obj-${k}`, Buffer.from(`extra-${k}`));

    // Verify mock Cloudflare API rejects D1 export because pages_fts virtual table exists!
    const exportProbe = await fetch(`${mock.apiBase}/accounts/${ACCOUNT_ID}/d1/database/${initRes.config.resources.database.id}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(exportProbe.status).toBe(400);
    expect(await exportProbe.text()).toContain('virtual tables');

    const appV1 = mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id;
    const contentV1 = mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id;

    // 2) UPGRADE (with a new additive migration ending in a `--` comment without a semicolon)
    writeFileSync(join(ws, 'migrations/0004_upgrade_note.sql'), 'CREATE INDEX IF NOT EXISTS audit_at ON audit(at)\n-- trailing comment without semicolon');
    const upRes = await runUpgrade({
      root: ws,
      cf,
      log: (m: string) => logs.push(m),
      deployWorker: mock.createDeployWorker(),
      fetchImpl: mock.createHealthFetch(),
    });
    expect(upRes.state.previousVersions).toEqual({ app: appV1, content: contentV1 });
    expect(upRes.state.appliedMigrations).toEqual(['0004_upgrade_note.sql']);
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).not.toBe(appV1);
    expect(mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id).not.toBe(contentV1);
    // Upgrade MUST NEVER call D1 /export!
    expect(mock.state.calls.some((c) => c.path.endsWith('/export') && c.method === 'POST')).toBe(true); // only our explicit probe above!
    const callsAfterProbe = mock.state.calls.slice(mock.state.calls.findIndex((c) => c.path.endsWith('/export')) + 1);
    expect(callsAfterProbe.some((c) => c.path.endsWith('/export'))).toBe(false);

    // 3) ROLLBACK restores both Workers to v1.
    const rbRes = await runRollback({
      root: ws,
      cf,
      log: (m: string) => logs.push(m),
      fetchImpl: mock.createHealthFetch(),
    });
    expect(rbRes.restored).toEqual({ app: appV1, content: contentV1 });
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).toBe(appV1);
    expect(mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id).toBe(contentV1);

    // 4) DESTROY exports ZIP outside repo, requires exact instance name, deletes ONLY Lawh resources.
    const destroyRes = await runDestroy({
      root: ws,
      cf,
      prompt: scriptedPrompt([
        'y',           // export backup
        '',            // default ~/lawh-exports
        'Acme Lawh',   // confirm exact instance name
      ]),
      log: (m: string) => logs.push(m),
      homeDir: outHome,
    });
    expect(destroyRes.exportResult).not.toBeNull();
    expect(existsSync(destroyRes.exportResult!.zipPath)).toBe(true);
    expect(destroyRes.exportResult!.fileCount).toBe(1);
    const zipBytes = readFileSync(destroyRes.exportResult!.zipPath);
    expect(zipBytes.includes(Buffer.from('lawh.json'))).toBe(true);
    expect(zipBytes.includes(Buffer.from('rows/projects.ndjson'))).toBe(true);
    expect(zipBytes.includes(Buffer.from(`files/${sha}`))).toBe(true);
    expect(zipBytes.includes(Buffer.from('pages_fts'))).toBe(true); // mentioned in lawh.json note, NOT as a rows/pages_fts entry
    expect(zipBytes.includes(Buffer.from('rows/pages_fts'))).toBe(false);

    // All Lawh resources & local config files are gone.
    expect(existsSync(join(ws, 'lawh.config.json'))).toBe(false);
    expect(existsSync(join(ws, 'wrangler.app.jsonc'))).toBe(false);
    expect(existsSync(join(ws, 'wrangler.content.jsonc'))).toBe(false);
    expect(mock.state.d1.has(initRes.config.resources.database.id)).toBe(false);
    expect(mock.state.r2.has('lawh-files')).toBe(false);
    expect(mock.state.workers.has('lawh-app')).toBe(false);
    expect(mock.state.workers.has('lawh-content')).toBe(false);

    // Non-Lawh resources are 100% untouched!
    expect(mock.state.d1.has('d1_foreign_keep')).toBe(true);
    expect(mock.state.r2.get('unrelated-media')?.get('photo.jpg')?.toString()).toBe('jpeg-data');
    expect(mock.state.queues.has('q_foreign_keep')).toBe(true);
    expect(mock.state.stores.get('ss_foreign_keep')?.secrets.has('sec_foreign')).toBe(true);
    expect(mock.state.workers.has('unrelated-worker')).toBe(true);
  });

  it('recovers cleanly when stopped and resumed at every step of init, mid-upgrade rollback, and destroy', async () => {
    const mock = await startMockCloudflare();
    cleanups.push(() => mock.close());
    mock.seedNonLawhResources();

    const ws = makeWorkspace();
    cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
    const cf = createCloudflareClient({ apiBase: mock.apiBase, token: TOKEN });

    // Interrupt init repeatedly across every stage (account/subdomain, D1, R2, queues, secrets, migrations, deploy, owner/project) and resume until completion!
    const prompt = async (q: string) => {
      if (q.includes('Instance name (English)')) return 'Lawh';
      if (q.includes('Instance name (Arabic)')) return 'لوح';
      if (q.includes('Hosts')) return '';
      if (q.includes('Create these resources')) return 'yes';
      if (q.includes('Your name')) return 'Owner';
      if (q.includes('First project slug')) return 'alpha';
      if (q.includes('First project name (English)')) return 'Alpha';
      if (q.includes('First project name (Arabic)')) return 'ألفا';
      if (q.includes('Turn the instance switch ON')) return 'yes';
      return '';
    };
    let initRes = null;
    let attempts = 0;
    for (const failOffset of [2, 2, 2, 2, 2, 2, null]) {
      attempts++;
      mock.state.failAtCall = failOffset === null ? null : mock.state.calls.length + failOffset;
      try {
        initRes = await runInit({
          root: ws,
          cf,
          prompt,
          log: () => {},
          deployWorker: mock.createDeployWorker(),
        });
        break;
      } catch (err) {
        if (failOffset === null) throw err;
        expect(String(err)).toContain('Injected transient interruption');
      }
    }
    expect(attempts).toBeGreaterThan(2);
    expect(initRes?.instanceOn).toBe(true);
    // Exactly one Lawh D1, one R2, two queues, one store (plus the seeded foreign ones) — zero duplicates!
    expect(mock.state.d1.size).toBe(2);
    expect(mock.state.r2.size).toBe(2);
    expect(mock.state.queues.size).toBe(3);
    expect(mock.state.stores.size).toBe(2);

    const appV1 = mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id;
    const contentV1 = mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id;

    // Stop upgrade halfway (between app deploy and content deploy), then run rollback!
    let deployCount = 0;
    await expect(runUpgrade({
      root: ws,
      cf,
      log: () => {},
      deployWorker: async (opts: Parameters<ReturnType<typeof mock.createDeployWorker>>[0]) => {
        deployCount++;
        if (deployCount === 2) throw new Error('Stopped between app and content deploy');
        return mock.createDeployWorker()(opts);
      },
      fetchImpl: mock.createHealthFetch(),
    })).rejects.toThrow('Stopped between app and content deploy');

    // App moved to v2, content is still v1.
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).not.toBe(appV1);
    expect(mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id).toBe(contentV1);

    // Rollback puts BOTH Workers back to v1!
    await runRollback({ root: ws, cf, log: () => {}, fetchImpl: mock.createHealthFetch() });
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).toBe(appV1);
    expect(mock.state.workers.get('lawh-content')!.deployments[0]!.versions[0]!.version_id).toBe(contentV1);

    // Stop destroy midway, then resume destroy -> finishes cleanly!
    mock.state.failAtCall = mock.state.calls.length + 2;
    await expect(runDestroy({
      root: ws,
      cf,
      prompt: scriptedPrompt(['n', 'Lawh']),
      log: () => {},
    })).rejects.toThrow('Injected transient interruption');
    expect(existsSync(join(ws, 'lawh.config.json'))).toBe(true);

    await runDestroy({
      root: ws,
      cf,
      prompt: scriptedPrompt(['n', 'Lawh']),
      log: () => {},
    });
    expect(existsSync(join(ws, 'lawh.config.json'))).toBe(false);
    expect(mock.state.d1.size).toBe(1); // only foreign DB remains
    expect(mock.state.d1.has('d1_foreign_keep')).toBe(true);
  });

  it('falls back to Worker secrets when Secrets Store is unavailable, prints Time Travel restore on migration failure, and refuses in-repo export paths', async () => {
    const mock = await startMockCloudflare();
    cleanups.push(() => mock.close());
    mock.state.secretsStoreMode = 'forbidden';

    const ws = makeWorkspace();
    cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
    const cf = createCloudflareClient({ apiBase: mock.apiBase, token: TOKEN });

    const initRes = await runInit({
      root: ws,
      cf,
      prompt: scriptedPrompt(['Lawh', 'لوح', '', 'yes', 'Owner', 'main', 'Main', 'الرئيسي', 'yes']),
      log: () => {},
      deployWorker: mock.createDeployWorker(),
    });
    expect(initRes.config.secrets.backend).toBe('worker_secrets');
    const appSecrets = mock.state.workers.get('lawh-app')!.secrets;
    const contentSecrets = mock.state.workers.get('lawh-content')!.secrets;
    expect(Object.keys(appSecrets).sort()).toEqual(['CONTENT_KEY', 'LIVE_KEY', 'PEPPER', 'WEBHOOK_KEY']);
    expect(contentSecrets.CONTENT_KEY).toBe(appSecrets.CONTENT_KEY);
    // Temporary init secrets file was deleted after upload.
    expect(existsSync(join(ws, '.wrangler/lawh-init-secrets.json'))).toBe(false);

    // Failing migration during upgrade prints exact one-line Time Travel restore command and does NOT deploy.
    writeFileSync(join(ws, 'migrations/0004_broken.sql'), 'ALTER TABLE does_not_exist ADD COLUMN x TEXT;');
    const appBefore = mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id;
    const upLogs: string[] = [];
    await expect(runUpgrade({
      root: ws,
      cf,
      log: (m: string) => upLogs.push(m),
      deployWorker: mock.createDeployWorker(),
      fetchImpl: mock.createHealthFetch(),
    })).rejects.toThrow(/Migration 0004_broken\.sql failed/);
    expect(upLogs.join('\n')).toMatch(/wrangler d1 time-travel restore lawh --bookmark=00000000-/);
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).toBe(appBefore);

    // Export path inside working tree (including child dirs like `..exports`, `..\exports` on POSIX, and symlinks pointing inside) is refused!
    expect(() => assertOutsideRepo(ws, ws)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(ws, 'exports'), ws)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(ws, '..exports'), ws)).toThrow(/outside the repository/);
    if (process.platform !== 'win32') expect(() => assertOutsideRepo(join(ws, '..\\exports'), ws)).toThrow(/outside the repository/);
    const outsideDir = mkdtempSync(join(tmpdir(), 'lawh-s15-sym-'));
    cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));
    const linkIntoRepo = join(outsideDir, 'sneaky-link');
    symlinkSync(ws, linkIntoRepo);
    expect(() => assertOutsideRepo(linkIntoRepo, ws)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(linkIntoRepo, '..exports'), ws)).toThrow(/outside the repository/);

    // Destroy with wrong instance name deletes nothing.
    await expect(runDestroy({
      root: ws,
      cf,
      prompt: scriptedPrompt(['n', 'Wrong Name']),
      log: () => {},
    })).rejects.toThrow(/did not match/);
    expect(mock.state.workers.has('lawh-app')).toBe(true);
  });

  it('guards against overwriting pre-existing Workers, recovers dropped create responses, registers missing workers.dev subdomain, handles Secrets Store 409, validates host responses, and applies instance appearance in build-ui', async () => {
    const mock = await startMockCloudflare();
    cleanups.push(() => mock.close());
    const ws = makeWorkspace();
    cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
    const cf = createCloudflareClient({ apiBase: mock.apiBase, token: TOKEN });

    // 1) Pre-existing unrelated Worker with colliding name `lawh-app` must be refused, never overwritten!
    mock.state.workers.set('lawh-app', {
      name: 'lawh-app',
      versions: [{ id: 'ver_existing', metadata: {} }],
      deployments: [{ id: 'dep_existing', versions: [{ version_id: 'ver_existing', percentage: 100 }], message: 'unrelated' }],
      secrets: {},
    });
    // Also test missing workers.dev subdomain registration + Secrets Store 409 fallback + dropped response after D1 create!
    mock.state.subdomain = null;
    mock.state.secretsStoreMode = 'conflict';
    mock.state.dropAfterCommitOn = { method: 'POST', pathEndsWith: '/d1/database' };

    const prompt = async (q: string) => {
      if (q.includes('Instance name (English)')) return 'Studio Lawh';
      if (q.includes('Instance name (Arabic)')) return 'لوح الاستوديو';
      if (q.includes('Hosts')) return '';
      if (q.includes('No workers.dev subdomain')) return 'fresh-sub';
      if (q.includes('Create these resources')) return 'yes';
      if (q.includes('Your name')) return 'Owner';
      if (q.includes('First project slug')) return 'alpha';
      if (q.includes('First project name (English)')) return 'Alpha';
      if (q.includes('First project name (Arabic)')) return 'ألفا';
      if (q.includes('Turn the instance switch ON')) return 'yes';
      return '';
    };

    // First attempt registers subdomain, creates D1 remotely, then loses the HTTP response.
    await expect(runInit({ root: ws, cf, prompt, log: () => {}, deployWorker: mock.createDeployWorker() }))
      .rejects.toThrow('Dropped response after remote commit');
    expect(mock.state.subdomain).toBe('fresh-sub');
    expect(mock.state.d1.size).toBe(1);

    // Second attempt recovers the committed D1 database ID, falls back on Secrets Store 409, and REFUSES to overwrite `lawh-app`!
    await expect(runInit({ root: ws, cf, prompt, log: () => {}, deployWorker: mock.createDeployWorker() }))
      .rejects.toThrow(/Worker "lawh-app" already exists/);
    expect(mock.state.workers.get('lawh-app')!.deployments[0]!.versions[0]!.version_id).toBe('ver_existing');

    // Remove the colliding unrelated Worker, resume init -> succeeds!
    mock.state.workers.delete('lawh-app');

    // Simulate an interrupted deploy that left `appDeploying: true` even though the Worker was never created,
    // and then an unrelated Worker appears before retry -> must NOT overwrite it!
    const cfgBeforeResume = JSON.parse(readFileSync(join(ws, 'lawh.config.json'), 'utf8'));
    cfgBeforeResume.resources.workersCreated.appDeploying = true;
    writeFileSync(join(ws, 'lawh.config.json'), `${JSON.stringify(cfgBeforeResume, null, 2)}\n`);
    let injectedCollision = false;
    await expect(runInit({
      root: ws,
      cf,
      prompt,
      log: () => {},
      deployWorker: async (opts: Parameters<ReturnType<typeof mock.createDeployWorker>>[0]) => {
        if (!injectedCollision && opts.workerName === 'lawh-app') {
          injectedCollision = true;
          throw new Error('Transient deploy interruption before upload');
        }
        return mock.createDeployWorker()(opts);
      },
    })).rejects.toThrow('Transient deploy interruption before upload');
    // After the pre-upload failure, appDeploying is cleared back to false.
    expect(JSON.parse(readFileSync(join(ws, 'lawh.config.json'), 'utf8')).resources.workersCreated.appDeploying).toBe(false);

    // Even if appDeploying is manually left true while the Worker is absent, resuming clears it first.
    const cfgStale = JSON.parse(readFileSync(join(ws, 'lawh.config.json'), 'utf8'));
    cfgStale.resources.workersCreated.appDeploying = true;
    writeFileSync(join(ws, 'lawh.config.json'), `${JSON.stringify(cfgStale, null, 2)}\n`);
    const done = await runInit({ root: ws, cf, prompt, log: () => {}, deployWorker: mock.createDeployWorker() });
    expect(done.config.secrets.backend).toBe('worker_secrets');

    // 2) Upgrade host check rejects generic 404s on both hosts!
    mock.state.hostStatus = { app: 404, content: 404, appHeaders: {}, contentHeaders: {}, contentBody: 'not found' };
    await expect(runUpgrade({
      root: ws,
      cf,
      log: () => {},
      deployWorker: mock.createDeployWorker(),
      fetchImpl: mock.createHealthFetch(),
    })).rejects.toThrow(/Health check failed/);

    // 3) buildUi applies instance appearance settings (name, accent, defaultLang, defaultTheme) when lawh.config.json exists.
    const uiOut = mkdtempSync(join(tmpdir(), 'lawh-s15-ui-'));
    cleanups.push(() => rmSync(uiOut, { recursive: true, force: true }));
    const customCfgPath = join(uiOut, 'lawh.config.json');
    writeFileSync(customCfgPath, JSON.stringify({
      instance: { name: { en: 'Studio Board', ar: 'لوحة الاستوديو' }, accent: '#22aa88', icon: 'default', defaultLang: 'ar', defaultTheme: 'light' },
    }));
    await buildUi({ root: repoRoot, out: join(uiOut, 'dist'), configPath: customCfgPath });
    const builtHtml = readFileSync(join(uiOut, 'dist/index.html'), 'utf8');
    const builtManifest = JSON.parse(readFileSync(join(uiOut, 'dist/manifest.webmanifest'), 'utf8'));
    const builtSvg = readFileSync(join(uiOut, 'dist/icon.svg'), 'utf8');
    expect(builtHtml).toContain('<title>Studio Board</title>');
    expect(builtHtml).toContain('data-brand-en="Studio Board"');
    expect(builtHtml).toContain('data-brand-ar="لوحة الاستوديو"');
    expect(builtHtml).toContain('data-default-mode="light"');
    expect(builtHtml).toContain('data-default-lang="ar"');
    const cssMatch = /href="\/assets\/(style-[a-f0-9]+\.css)"/.exec(builtHtml);
    expect(cssMatch).not.toBeNull();
    expect(readFileSync(join(uiOut, 'dist/assets', cssMatch![1]!), 'utf8')).toContain(':root,:root[data-mode=light]{--ac:#22aa88;}');
    expect(builtManifest.name).toBe('Studio Board · لوحة الاستوديو');
    expect(builtManifest.theme_color).toBe('#f6f4ef');
    expect(builtSvg).toContain('#22aa88');

    // Explicit `#e0b15a` accent also emits the light-mode override so light mode honors it.
    const defaultAccentCfg = join(uiOut, 'lawh-default-accent.json');
    writeFileSync(defaultAccentCfg, JSON.stringify({
      instance: { name: { en: 'Gold Board', ar: 'لوحة' }, accent: '#e0b15a', defaultTheme: 'light' },
    }));
    await buildUi({ root: repoRoot, out: join(uiOut, 'dist-gold'), configPath: defaultAccentCfg });
    const goldHtml = readFileSync(join(uiOut, 'dist-gold/index.html'), 'utf8');
    const goldCss = /href="\/assets\/(style-[a-f0-9]+\.css)"/.exec(goldHtml);
    expect(goldCss).not.toBeNull();
    expect(readFileSync(join(uiOut, 'dist-gold/assets', goldCss![1]!), 'utf8')).toContain(':root,:root[data-mode=light]{--ac:#e0b15a;}');
  });

  it('reads Wrangler OAuth token from config file and enforces check_no_instance.py', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'lawh-wrangler-auth-'));
    cleanups.push(() => rmSync(fakeHome, { recursive: true, force: true }));
    const wranglerCfgDir = process.platform === 'darwin'
      ? join(fakeHome, 'Library/Preferences/.wrangler/config')
      : join(fakeHome, '.config/.wrangler/config');
    mkdirSync(wranglerCfgDir, { recursive: true });
    writeFileSync(join(wranglerCfgDir, 'default.toml'), 'oauth_token = "wrangler-oauth-xyz"\n');
    expect(readCloudflareToken({}, fakeHome)).toBe('wrangler-oauth-xyz');
    expect(readCloudflareToken({ CLOUDFLARE_API_TOKEN: 'env-tok' }, fakeHome)).toBe('env-tok');

    // check_no_instance.py passes on the real repository.
    const realCheck = spawnSync('python3', [join(repoRoot, 'scripts/check_no_instance.py'), '--root', repoRoot], { encoding: 'utf8' });
    expect(realCheck.status, realCheck.stdout + realCheck.stderr).toBe(0);

    // check_no_instance.py fails on tracked lawh.config.json, .wrangler secrets, custom example host/org, test workers.dev URL, or CI secrets.
    const dirtyRepo = mkdtempSync(join(tmpdir(), 'lawh-dirty-repo-'));
    cleanups.push(() => rmSync(dirtyRepo, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', dirtyRepo]);
    writeFileSync(join(dirtyRepo, '.gitignore'), '/lawh.config.json\n/wrangler.app.jsonc\n/wrangler.content.jsonc\n.dev.vars*\n.env\n');
    const fakeSub = ['real', 'user'].join('-');
    const fakeHost = `https://lawh-app.${fakeSub}.workers` + '.dev';
    writeFileSync(join(dirtyRepo, 'lawh.config.example.json'), JSON.stringify({
      instance: { name: { en: 'Private Corp', ar: 'شركة خاصة' } },
      hosts: { mode: 'custom', app: 'https://lawh.private.corp', content: 'https://content.private.corp' },
      resources: { accountId: '0123456789abcdef0123456789abcdef', database: { id: 'abcdef0123456789abcdef0123456789' } },
    }));
    mkdirSync(join(dirtyRepo, '.github/workflows'), { recursive: true });
    writeFileSync(join(dirtyRepo, '.github/workflows/ci.yml'), 'env:\n  TOKEN: ${{ secrets.CF_TOKEN }}\n');
    mkdirSync(join(dirtyRepo, '.wrangler'), { recursive: true });
    writeFileSync(join(dirtyRepo, '.wrangler/lawh-init-secrets.json'), '{"PEPPER":"secret"}');
    mkdirSync(join(dirtyRepo, 'test'), { recursive: true });
    writeFileSync(join(dirtyRepo, 'test/leak.ts'), `export const u = "${fakeHost}";\n`);
    writeFileSync(join(dirtyRepo, 'test/probe.yaml'), `url: ${fakeHost}\n`);
    writeFileSync(join(dirtyRepo, 'lawh.config.json'), '{}');
    execFileSync('git', ['-C', dirtyRepo, 'add', '-f', '.gitignore', 'lawh.config.example.json', '.github/workflows/ci.yml', 'lawh.config.json', '.wrangler/lawh-init-secrets.json', 'test/leak.ts', 'test/probe.yaml']);

    const badCheck = spawnSync('python3', [join(repoRoot, 'scripts/check_no_instance.py'), '--root', dirtyRepo], { encoding: 'utf8' });
    expect(badCheck.status).toBe(1);
    expect(badCheck.stdout).toContain('instance or secret file is tracked: lawh.config.json');
    expect(badCheck.stdout).toContain('instance or secret file is tracked: .wrangler/lawh-init-secrets.json');
    expect(badCheck.stdout).toContain('default Lawh instance names');
    expect(badCheck.stdout).toContain('placeholder host');
    expect(badCheck.stdout).toContain('test/leak.ts contains a real workers.dev host URL');
    expect(badCheck.stdout).toContain('test/probe.yaml contains a real workers.dev host URL');
    expect(badCheck.stdout).toContain('references GitHub secrets');
  });
});
