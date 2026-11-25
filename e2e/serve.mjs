// Runs both Workers locally with a fresh database, publishes e2e/pages through the real API, and serves the trap: a
// third host that records every request a page manages to send out. Nothing here talks to a deployed copy.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_KEY, PEPPER, runLocal } from '../scripts/local/run.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), state = join(root, '.wrangler/e2e');
rmSync(state, { recursive: true, force: true });
// A server that is already there would be taken for ours.
const taken = await Promise.all(['127.0.0.1', 'localhost'].map((host) => fetch(`http://${host}:8797/`).then(() => true, () => false)));
if (taken.includes(true)) { console.error('Port 8797 is in use'); process.exit(1); }
const { child, app: APP } = runLocal({ port: 8797, state, testing: true });

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  const end = () => { rmSync(state, { recursive: true, force: true }); process.exit(code); };
  if (child.exitCode !== null || child.signalCode !== null) end();
  child.once('exit', end);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 5000);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));
child.on('exit', (code) => { if (!stopping) { console.error(`The Workers stopped with ${code}`); stop(1); } });

/** Requests that reached the trap, by the first part of their path: the test that made them. */
const hits = new Map();
let ready = null;
const answer = (request, response) => {
  const url = new URL(request.url, 'http://trap');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/ready') { response.statusCode = ready ? 200 : 503; response.end(JSON.stringify(ready)); return; }
  const [, who, ...what] = url.pathname.split('/');
  if (who === 'hits') { response.end(JSON.stringify(hits.get(what[0]) ?? [])); return; }
  hits.set(who, [...(hits.get(who) ?? []), what.join('/')]);
  response.setHeader('Content-Type', 'text/html'); response.end('<title>trap</title>');
};
// Both loopback addresses, because browsers differ in which one `localhost` is.
for (const address of ['127.0.0.1', '::1']) {
  const trap = createServer(answer);
  trap.on('upgrade', (request, socket) => { const [, who, ...what] = request.url.split('/'); hits.set(who, [...(hits.get(who) ?? []), what.join('/')]); socket.destroy(); });
  trap.on('error', (error) => { if (address === '::1' && error.code === 'EADDRNOTAVAIL') return; console.error(error.message); stop(1); });
  trap.listen(8799, address);
}

// Anything that fails from here on also stops the Workers.
process.on('unhandledRejection', (error) => { console.error(error); stop(1); });
process.on('uncaughtException', (error) => { console.error(error); stop(1); });
while (!stopping) { try { await fetch(APP); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
if (stopping) await new Promise(() => undefined);

const db = async (...statements) => {
  const response = await fetch(`${APP}/`, { method: 'POST', headers: { 'X-Lawh-E2E': 'database' }, body: JSON.stringify(statements) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const keyId = `key_${'0'.repeat(26)}`, secret = randomBytes(32).toString('base64url');
const mac = createHmac('sha256', PEPPER).update(`${keyId}:${createHash('sha256').update(secret).digest('hex')}`).digest('hex');
await db(
  "INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1),('teams','true',1)",
  "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1),('p2','two','Two','اثنان',1)",
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
// More of `good`: an old version, tags, a status. And many pages, for the list.
for (const [method, path, body] of [['PATCH', '/projects/one/pages/good', { title: 'Photo storage options', summary: 'Three ways to keep photos, compared by monthly cost and effort.', tags: ['storage', 'صور'], status: 'in_review' }],
  ['PATCH', '/projects/one/pages/forge', { title: 'مقارنة مزوّدي الطقس', lang: 'ar', tags: ['weather'], status: 'draft' }]]) await api(path, { method, body: JSON.stringify(body) });
for (let i = 0; i < 40; i++) await db(`INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('fill${i}','p1','fill-${i}','Filler ${i}','a',1,${i + 1})`);
{
  const data = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Second</title></head><body><h1>Second version</h1></body></html>');
  const file = { path: 'index.html', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length };
  const upload = await api('/projects/one/pages/versions/versions', { method: 'POST', body: JSON.stringify({ baseVersion: 1, note: 'Second thoughts', page: {}, files: [file] }) });
  await api(`/uploads/${upload.uploadId}/blobs/${file.sha256}`, { method: 'PUT', body: data });
  await api(`/uploads/${upload.uploadId}/commit`, { method: 'POST' });
}
await db("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('second','p2','second','In the second project','a',1,5)", "INSERT INTO page_tags VALUES('second','second-only','p2',5)",
  "INSERT INTO pages_fts_map(page_id) VALUES('second')", "INSERT INTO pages_fts(rowid,scope,title,summary,tags,body) SELECT rowid,'p7032 s6472616674 t' || lower(hex('second-only')),'In the second project','','second-only','zebra' FROM pages_fts_map WHERE page_id='second'");
const [versions] = await db('SELECT p.slug, v.id FROM pages p JOIN page_versions v ON v.page_id = p.id AND v.n = p.current_version');
for (const { slug, id } of versions) pages[slug] = id;
ready = { pages, contentKey: CONTENT_KEY };
