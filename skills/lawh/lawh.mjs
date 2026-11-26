#!/usr/bin/env node
// Lawh agent CLI — single file, zero dependencies, Node >= 22.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

const SERVICE = 'lawh-agent';
const ACCOUNT = 'agents';

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function storeFilePath() {
  if (process.env.LAWH_STORE) return process.env.LAWH_STORE;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'lawh', 'agents.json');
}

function useKeychain() {
  return !process.env.LAWH_STORE && process.env.LAWH_NO_KEYCHAIN !== '1' && (process.platform === 'darwin' || process.platform === 'linux');
}

function readKeychain() {
  if (!useKeychain()) return null;
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
      return JSON.parse(out);
    }
    if (process.platform === 'linux') {
      const out = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
      return out ? JSON.parse(out) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function writeKeychain(data) {
  if (!useKeychain()) return false;
  const payload = JSON.stringify(data);
  try {
    if (process.platform === 'darwin') {
      execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', payload], { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'linux') {
      execFileSync('secret-tool', ['store', '--label=Lawh agents', 'service', SERVICE, 'account', ACCOUNT], { input: payload, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function readStore() {
  const fromChain = readKeychain();
  if (fromChain && Array.isArray(fromChain.agents)) return fromChain;
  const file = storeFilePath();
  if (!existsSync(file)) return { agents: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.agents) ? parsed : { agents: [] };
  } catch {
    return { agents: [] };
  }
}

function writeStore(store) {
  if (writeKeychain(store)) return;
  const file = storeFilePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

function saveEntry(entry) {
  const store = readStore();
  const next = store.agents.filter((a) => !(a.url === entry.url && a.name === entry.name));
  next.push(entry);
  writeStore({ agents: next });
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function pickCredentials(flags) {
  if (process.env.LAWH_URL && process.env.LAWH_KEY) {
    return { url: process.env.LAWH_URL.replace(/\/+$/, ''), key: process.env.LAWH_KEY, name: process.env.LAWH_AGENT || 'env' };
  }
  const store = readStore();
  const list = store.agents;
  if (list.length === 0) die('No saved Lawh agent. Run `lawh.mjs connect <url>` or set LAWH_URL and LAWH_KEY.');
  const wantedName = typeof flags.as === 'string' ? flags.as : process.env.LAWH_AGENT;
  const wantedClient = typeof flags.client === 'string' ? flags.client : undefined;
  const wantedUrl = typeof flags.url === 'string' ? flags.url.replace(/\/+$/, '') : undefined;

  let matches = list;
  if (wantedUrl) matches = matches.filter((a) => a.url === wantedUrl);
  if (wantedName) matches = matches.filter((a) => a.name === wantedName);
  else if (wantedClient) matches = matches.filter((a) => a.client === wantedClient);

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) die(`No matching agent found. Saved agents: ${list.map((a) => `${a.name} (${a.client}, ${a.url})`).join(', ')}`);
  die(`Multiple agents match (${matches.map((a) => a.name).join(', ')}). Pass --as <name> or set LAWH_AGENT.`);
}

async function apiRequest(cred, method, path, { body, rawBody, idem = false, headers = {} } = {}) {
  const reqHeaders = { Authorization: `Bearer ${cred.key}`, ...headers };
  if (idem) reqHeaders['Idempotency-Key'] = randomUUID();
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
  } else if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${cred.url}${path}`, { method, headers: reqHeaders, body: payload });
  if (response.status === 204) return null;
  const ct = response.headers.get('Content-Type') || '';
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      if (err && err.message) detail = `${err.code || response.status}: ${err.message}`;
    } catch { /* ignore */ }
    die(detail);
  }
  if (ct.includes('application/json')) return response.json();
  return Buffer.from(await response.arrayBuffer());
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* headless */ }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function walkFiles(dir, rootDir = dir, acc = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === '.git') continue;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) walkFiles(dir, full, acc);
    else if (entry.isFile()) {
      const rel = relative(dir, full).split(sep).join('/').normalize('NFC');
      const data = readFileSync(full);
      acc.push({ path: rel, data, sha256: sha256Hex(data), bytes: data.byteLength });
    }
  }
  return acc.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function printOut(data, asJson, human) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

async function cmdConnect(positional, flags) {
  const rawUrl = positional[0];
  if (!rawUrl) die('Usage: lawh.mjs connect <url> [--client <name>] [--machine <name>] [--no-open]');
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const client = String(flags.client || 'cli').slice(0, 40);
  const machine = String(flags.machine || hostname() || 'local').slice(0, 60);
  const secret = randomBytes(32).toString('base64url');
  const secretSha256 = sha256Hex(secret);

  const startRes = await fetch(`${baseUrl}/v1/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secretSha256, client, machine }),
  });
  if (!startRes.ok) {
    let msg = `HTTP ${startRes.status}`;
    try { const e = await startRes.json(); if (e?.message) msg = `${e.code}: ${e.message}`; } catch { /* ignore */ }
    die(`Could not start connection: ${msg}`);
  }
  const started = await startRes.json();
  const fullKey = `lawh_${started.id}_${secret}`;

  process.stderr.write(`Open: ${started.url}\nCode: ${started.code}\nWaiting for approval...\n`);
  if (!flags['no-open']) openBrowser(started.url);

  const intervalMs = Math.max(200, Number(flags['poll-ms'] || (started.interval || 3) * 1000));
  while (Date.now() < started.expiresAt + 10_000) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await fetch(`${baseUrl}/v1/connect/${started.id}`, {
      headers: { Authorization: `Bearer ${fullKey}` },
    });
    if (poll.status === 202) continue;
    if (poll.status === 403) die('Connection request was refused.');
    if (poll.status === 404) die('Connection request expired or was cancelled.');
    if (!poll.ok) continue;
    const me = await poll.json();
    saveEntry({
      url: baseUrl,
      client,
      machine,
      agentId: me.agentId,
      name: me.name,
      key: fullKey,
      expiresAt: me.expiresAt,
    });
    printOut(
      { url: baseUrl, agentId: me.agentId, name: me.name, projects: me.projects, expiresAt: me.expiresAt },
      Boolean(flags.json),
      `Connected as ${me.name} (${me.agentId}) at ${baseUrl}. Projects: ${me.projects.map((p) => p.slug).join(', ') || '(none)'}`,
    );
    return;
  }
  die('Connection request timed out.');
}

async function cmdPublish(positional, flags) {
  const folder = positional[0];
  const project = typeof flags.project === 'string' ? flags.project : '';
  const slug = typeof flags.slug === 'string' ? flags.slug : '';
  if (!folder || !project || !slug) {
    die('Usage: lawh.mjs publish <folder> --project <slug> --slug <slug> [--title "..."] [--summary "..."] [--lang en|ar] [--tags a,b] [--status draft|in_review|archived] [--entry index.html] [--note "..."] [--decisions file.json]');
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) die(`Not a folder: ${folder}`);
  const cred = pickCredentials(flags);
  const files = walkFiles(folder);
  if (files.length === 0) die('Folder has no files to publish.');

  let baseVersion;
  if (flags.base !== undefined) {
    baseVersion = Number(flags.base);
  } else {
    const check = await fetch(`${cred.url}/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${cred.key}` },
    });
    if (check.status === 404) baseVersion = 0;
    else if (check.ok) baseVersion = (await check.json()).currentVersion;
    else die(`Could not check existing page: HTTP ${check.status}`);
  }

  const page = {};
  if (typeof flags.title === 'string') page.title = flags.title;
  else if (baseVersion === 0) page.title = slug;
  if (typeof flags.summary === 'string') page.summary = flags.summary;
  if (typeof flags.lang === 'string') page.lang = flags.lang;
  if (typeof flags.status === 'string') page.status = flags.status;
  if (typeof flags.tags === 'string') page.tags = flags.tags.split(',').map((s) => s.trim()).filter(Boolean);

  const manifest = {
    baseVersion,
    entry: typeof flags.entry === 'string' ? flags.entry : 'index.html',
    page,
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  };
  if (typeof flags.note === 'string') manifest.note = flags.note;
  if (typeof flags.decisions === 'string') {
    manifest.decisions = JSON.parse(readFileSync(flags.decisions, 'utf8'));
  }

  const upload = await apiRequest(cred, 'POST', `/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}/versions`, {
    body: manifest,
    idem: true,
  });
  const byHash = new Map(files.map((f) => [f.sha256, f.data]));
  for (const hash of upload.missing) {
    const data = byHash.get(hash);
    if (!data) die(`Missing local file for hash ${hash}`);
    await apiRequest(cred, 'PUT', `/v1/uploads/${encodeURIComponent(upload.uploadId)}/blobs/${hash}`, { rawBody: data });
  }
  const published = await apiRequest(cred, 'POST', `/v1/uploads/${encodeURIComponent(upload.uploadId)}/commit`, { idem: true });
  printOut(published, Boolean(flags.json), `${published.url} (v${published.currentVersion}, ${published.status})`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`Usage: lawh.mjs <command> [options]

Commands:
  connect <url> [--client <name>] [--machine <name>] [--no-open]
  agents [--json]
  whoami [--json]
  projects [--json]
  publish <folder> --project <slug> --slug <slug> [--title ...] [--decisions file.json] [--json]
  pages [--project <slug>] [--status <status>] [--tag <tag>] [--q <query>] [--limit <n>] [--cursor <c>] [--json]
  read <project> <slug> [--version <n>] [--file <path>] [--json]
  decisions [--project <slug>] [--page <pageId>] [--status <status>] [--id <decId>] [--json]
  comments [--project <slug> | --page <pageId>] [--json]
  reply <threadId> <body> [--json]
  events --project <slug> [--after <seq>] [--limit <n>] [--json]
`);
    return;
  }

  const { positional, flags } = parseArgs(rest);
  const asJson = Boolean(flags.json);

  if (cmd === 'connect') return cmdConnect(positional, flags);

  if (cmd === 'agents') {
    const list = readStore().agents.map(({ url, client, machine, agentId, name, expiresAt }) => ({ url, client, machine, agentId, name, expiresAt }));
    printOut({ items: list }, asJson, list.length ? list.map((a) => `${a.name} (${a.client} @ ${a.machine}) -> ${a.url}`).join('\n') : 'No saved agents.');
    return;
  }

  if (cmd === 'publish') return cmdPublish(positional, flags);

  const cred = pickCredentials(flags);

  if (cmd === 'whoami') {
    const data = await apiRequest(cred, 'GET', '/v1/me');
    printOut(data, asJson, `${data.name} (${data.agentId}) — projects: ${data.projects.map((p) => p.slug).join(', ') || '(none)'}`);
    return;
  }

  if (cmd === 'projects') {
    const data = await apiRequest(cred, 'GET', '/v1/projects');
    printOut(data, asJson, data.items.map((p) => `${p.slug}\t${p.name.en}`).join('\n') || 'No projects.');
    return;
  }

  if (cmd === 'pages') {
    const q = new URLSearchParams();
    for (const k of ['project', 'status', 'tag', 'q', 'limit', 'cursor']) if (typeof flags[k] === 'string') q.set(k, flags[k]);
    const qs = q.toString();
    const data = await apiRequest(cred, 'GET', `/v1/pages${qs ? `?${qs}` : ''}`);
    printOut(data, asJson, data.items.map((p) => `${p.project}/${p.slug}\t[${p.status}]\t${p.title}`).join('\n') || 'No pages.');
    return;
  }

  if (cmd === 'read') {
    const [project, slug] = positional;
    if (!project || !slug) die('Usage: lawh.mjs read <project> <slug> [--version <n>] [--file <path>]');
    if (typeof flags.file === 'string') {
      let version = typeof flags.version === 'string' ? flags.version : '';
      if (!version) {
        const page = await apiRequest(cred, 'GET', `/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}`);
        version = String(page.currentVersion);
      }
      const bytes = await apiRequest(cred, 'GET', `/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/file?path=${encodeURIComponent(flags.file)}`);
      process.stdout.write(bytes);
      return;
    }
    const path = typeof flags.version === 'string'
      ? `/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(flags.version)}`
      : `/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}`;
    const data = await apiRequest(cred, 'GET', path);
    printOut(data, asJson, `${data.title || `v${data.n}`} (${data.url || `${data.fileCount} files`})`);
    return;
  }

  if (cmd === 'decisions') {
    if (typeof flags.id === 'string') {
      const data = await apiRequest(cred, 'GET', `/v1/decisions/${encodeURIComponent(flags.id)}`);
      printOut(data, asJson, `${data.key} [${data.status}]: ${data.question}`);
      return;
    }
    const q = new URLSearchParams();
    for (const k of ['project', 'page', 'status', 'limit', 'cursor']) if (typeof flags[k] === 'string') q.set(k, flags[k]);
    const qs = q.toString();
    const data = await apiRequest(cred, 'GET', `/v1/decisions${qs ? `?${qs}` : ''}`);
    printOut(data, asJson, data.items.map((d) => `${d.id}\t${d.key}\t[${d.status}]\t${d.question}`).join('\n') || 'No decisions.');
    return;
  }

  if (cmd === 'comments') {
    const q = new URLSearchParams();
    for (const k of ['limit', 'cursor']) if (typeof flags[k] === 'string') q.set(k, flags[k]);
    let path;
    if (typeof flags.page === 'string') {
      const qs = q.toString();
      path = `/v1/pages/${encodeURIComponent(flags.page)}/comments${qs ? `?${qs}` : ''}`;
    } else if (typeof flags.project === 'string') {
      q.set('project', flags.project);
      path = `/v1/comments?${q.toString()}`;
    } else {
      die('Usage: lawh.mjs comments --project <slug> | --page <pageId>');
    }
    const data = await apiRequest(cred, 'GET', path);
    printOut(data, asJson, data.items.map((c) => `${c.id}\t[${c.authorType}${c.fromDecider ? ',decider' : ''}]\t${c.body}`).join('\n') || 'No comments.');
    return;
  }

  if (cmd === 'reply') {
    const [threadId, ...bodyParts] = positional;
    const body = bodyParts.join(' ');
    if (!threadId || !body) die('Usage: lawh.mjs reply <threadId> <body>');
    const data = await apiRequest(cred, 'POST', `/v1/comments/${encodeURIComponent(threadId)}/replies`, { body: { body }, idem: true });
    printOut(data, asJson, `Replied: ${data.id}`);
    return;
  }

  if (cmd === 'events') {
    if (typeof flags.project !== 'string') die('Usage: lawh.mjs events --project <slug> [--after <seq>] [--limit <n>]');
    const q = new URLSearchParams({ project: flags.project });
    for (const k of ['after', 'limit']) if (typeof flags[k] === 'string') q.set(k, flags[k]);
    const data = await apiRequest(cred, 'GET', `/v1/events?${q.toString()}`);
    printOut(data, asJson, data.items.length ? `${data.items.map((e) => `#${e.seq}\t${e.type}\t${e.actorType}`).join('\n')}\nnext=${data.next}` : `next=${data.next}`);
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
