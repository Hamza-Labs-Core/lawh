// Runs both Workers locally with a fresh database, publishes e2e/pages through the real API, and serves the trap: a
// third host that records every request a page manages to send out. Nothing here talks to a deployed copy.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname, state = join(root, '.wrangler/e2e'), bin = join(root, 'node_modules/.bin/wrangler');
const PORT = 8797, APP = `http://localhost:${PORT}`, CONTENT = `http://127.0.0.1:${PORT}`;
const PEPPER = 'local-development-pepper-not-a-secret', CONTENT_KEY = 'local-development-content-key-not-a-secret';
rmSync(state, { recursive: true, force: true }); mkdirSync(state, { recursive: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };

// The Workers' own development configs, with these hosts. One process runs all three, so one opens the database.
const configs = ['app', 'content'].map((name) => {
  const config = JSON.parse(readFileSync(join(root, `wrangler.${name}.dev.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  Object.assign(config.vars, { APP_ORIGIN: APP, CONTENT_ORIGIN: CONTENT, CONTENT_KEY, ...(name === 'app' && { PEPPER }) });
  config.main = join(root, config.main);
  config.d1_databases[0].migrations_dir = join(root, 'migrations');
  const path = join(state, `${name}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
});
const entry = join(state, 'entry.json');
writeFileSync(entry, JSON.stringify({
  name: 'lawh-e2e', main: join(root, 'e2e/entry.ts'), compatibility_date: '2026-11-10', send_metrics: false,
  services: [{ binding: 'APP', service: 'lawh-app' }, { binding: 'CONTENT', service: 'lawh-content' }],
  d1_databases: [{ binding: 'DB', database_name: 'lawh', database_id: 'local', migrations_dir: join(root, 'migrations') }],
}));
execFileSync(bin, ['d1', 'migrations', 'apply', 'lawh', '--local', '--persist-to', state, '-c', entry], { cwd: root, env, stdio: 'ignore' });

const children = [];
let stopping = false;
function stop(code) {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  trap.close();
  setTimeout(() => process.exit(code), 500);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));

/** Requests that reached the trap, by the first part of their path: the test that made them. */
const hits = new Map();
let ready = null;
const trap = createServer((request, response) => {
  const url = new URL(request.url, 'http://trap');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/ready') { response.statusCode = ready ? 200 : 503; response.end(JSON.stringify(ready)); return; }
  const [, who, ...what] = url.pathname.split('/');
  if (who === 'hits') { response.end(JSON.stringify(hits.get(what[0]) ?? [])); return; }
  hits.set(who, [...(hits.get(who) ?? []), what.join('/')]);
  response.setHeader('Content-Type', 'text/html'); response.end('<title>trap</title>');
});
trap.on('upgrade', (request, socket) => { const [, who, ...what] = request.url.split('/'); hits.set(who, [...(hits.get(who) ?? []), what.join('/')]); socket.destroy(); });
trap.listen(8799, 'localhost');

const child = spawn(bin, ['dev', '-c', entry, ...configs.flatMap((path) => ['-c', path]), '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', state, '--inspector-port', '0', '--log-level', 'warn'],
  { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
children.push(child);
child.on('exit', (code) => { if (!stopping) { console.error(`The Workers stopped with ${code}`); stop(1); } });
for (;;) { try { await fetch(APP); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const db = async (...statements) => {
  const response = await fetch(`${APP}/`, { method: 'POST', headers: { 'X-Lawh-E2E': 'database' }, body: JSON.stringify(statements) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const keyId = `key_${'0'.repeat(26)}`, secret = randomBytes(32).toString('base64url');
const mac = createHmac('sha256', PEPPER).update(`${keyId}:${createHash('sha256').update(secret).digest('hex')}`).digest('hex');
await db(
  "INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1)",
  "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1)",
  "INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1)", 'UPDATE members SET joined_at=1',
  "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)",
  `INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,all_projects,created_at,expires_at) VALUES('${keyId}','a','${mac}','["pages:read","pages:write"]',1,1,${Date.now() + 86_400_000})`,
);

const api = async (path, init = {}) => {
  const response = await fetch(`${APP}/v1${path}`, { ...init, headers: { Authorization: `Bearer lawh_${keyId}_${secret}`, 'Idempotency-Key': randomBytes(8).toString('hex'), ...init.headers } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};
/** Each folder of e2e/pages is a page. */
const pages = {};
for (const slug of readdirSync(join(root, 'e2e/pages'))) {
  const files = readdirSync(join(root, 'e2e/pages', slug)).map((path) => ({ path, data: readFileSync(join(root, 'e2e/pages', slug, path)) }));
  const list = files.map(({ path, data }) => ({ path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }));
  const upload = await api(`/projects/one/pages/${slug}/versions`, { method: 'POST', body: JSON.stringify({ baseVersion: 0, page: { title: slug }, files: list }) });
  for (const [i, { data }] of files.entries()) if (upload.missing.includes(list[i].sha256)) await api(`/uploads/${upload.uploadId}/blobs/${list[i].sha256}`, { method: 'PUT', body: data });
  await api(`/uploads/${upload.uploadId}/commit`, { method: 'POST' });
}
const [versions] = await db('SELECT p.slug, v.id FROM pages p JOIN page_versions v ON v.page_id = p.id');
for (const { slug, id } of versions) pages[slug] = id;
ready = { pages, contentKey: CONTENT_KEY };
