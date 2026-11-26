#!/usr/bin/env node
// Lawh agent CLI — single file, zero dependencies, Node >= 22.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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

function readDarwinKeychainRaw() {
  return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
}

function decodeKeychainPayload(raw) {
  if (!raw) return null;
  if (raw.startsWith('b64:')) return JSON.parse(Buffer.from(raw.slice(4), 'base64').toString('utf8'));
  return JSON.parse(raw);
}

function readKeychain() {
  if (!useKeychain()) return null;
  try {
    if (process.platform === 'darwin') {
      return decodeKeychainPayload(readDarwinKeychainRaw());
    }
    if (process.platform === 'linux') {
      const out = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
      return decodeKeychainPayload(out);
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
      // Pass payload via stdin (`security -i`) so credentials never appear in subprocess argv.
      const encoded = `b64:${Buffer.from(payload, 'utf8').toString('base64')}`;
      execFileSync('security', ['-i'], {
        input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${encoded}\n`,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return readDarwinKeychainRaw() === encoded;
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

function readFileStore() {
  const file = storeFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.agents) ? parsed : null;
  } catch {
    return null;
  }
}

function readStore() {
  const fromChain = readKeychain();
  const validChain = fromChain && Array.isArray(fromChain.agents) ? fromChain : null;
  const fromFile = readFileStore();
  if (validChain && fromFile) {
    const chainTs = typeof validChain.updatedAt === 'number' ? validChain.updatedAt : 0;
    const fileTs = typeof fromFile.updatedAt === 'number' ? fromFile.updatedAt : 0;
    return fileTs >= chainTs ? fromFile : validChain;
  }
  return validChain ?? fromFile ?? { updatedAt: 0, agents: [] };
}

function writeStore(store) {
  const stamped = { updatedAt: Date.now(), agents: store.agents };
  const file = storeFilePath();
  if (writeKeychain(stamped)) {
    // Remove any older fallback file so keychain and disk never diverge.
    try { if (existsSync(file)) unlinkSync(file); } catch { /* ignore */ }
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stamped, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

function saveEntry(entry) {
  const store = readStore();
  const next = store.agents.filter((a) => !(a.url === entry.url && a.name === entry.name && a.client === entry.client));
  next.push(entry);
  writeStore({ agents: next });
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let afterDash = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      afterDash = argv.slice(i + 1);
      positional.push(...afterDash);
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
  return { positional, flags, afterDash };
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
  if (wantedClient && (!wantedName || matches.length > 1)) matches = matches.filter((a) => a.client === wantedClient);

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) die(`No matching agent found. Saved agents: ${list.map((a) => `${a.name} (${a.client}, ${a.url})`).join(', ')}`);
  die(`Multiple agents match (${matches.map((a) => `${a.name} (${a.client}, ${a.url})`).join(', ')}). Pass --as <name>, --client <program>, or --url <url>.`);
}

class ApiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function apiRequest(cred, method, path, { body, rawBody, idem = false, headers = {}, signal, throwOnHttpError = false } = {}) {
  const reqHeaders = { Authorization: `Bearer ${cred.key}`, ...headers };
  if (idem) reqHeaders['Idempotency-Key'] = randomUUID();
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
  } else if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${cred.url}${path}`, { method, headers: reqHeaders, body: payload, signal });
  if (response.status === 204) return null;
  const ct = response.headers.get('Content-Type') || '';
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const err = await response.json();
      if (err && err.message) detail = `${err.code || response.status}: ${err.message}`;
    } catch { /* ignore */ }
    if (throwOnHttpError) throw new ApiHttpError(response.status, detail);
    die(detail);
  }
  if (ct.includes('application/json')) return response.json();
  return Buffer.from(await response.arrayBuffer());
}

function safeConnectUrl(rawUrl, baseUrl) {
  try {
    const parsed = new URL(rawUrl);
    const base = new URL(baseUrl);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== base.origin) return null;
    if (parsed.pathname !== '/connect' || parsed.search || parsed.hash) return null;
    return `${parsed.origin}/connect`;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    const safe = parsed.href;
    // Never invoke a shell (e.g., cmd /c) so server-supplied URLs cannot be interpreted by cmd.exe.
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', safe] : [safe];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => { /* headless or missing opener */ });
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

  const baseOrigin = new URL(baseUrl).origin;
  const connectUrl = safeConnectUrl(started.url, baseUrl) ?? `${baseOrigin}/connect`;
  process.stderr.write(`Open: ${connectUrl}\nCode: ${started.code}\nWaiting for approval...\n`);
  if (!flags['no-open']) openBrowser(connectUrl);

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
  wait [--project <slug>] [--page <pageId>] [--decision <decId>] [--agents] [--cursor <name>] [--after <seq>] [--timeout <sec>] [--json]
  listen [--project <slug>] [--page <pageId>] [--decision <decId>] [--agents] [--cursor <name>] [--after <seq>] -- <command> [args...]
`);
    return;
  }

  const { positional, flags, afterDash } = parseArgs(rest);
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
      const fileUrl = `${cred.url}/v1/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/file?path=${encodeURIComponent(flags.file)}`;
      const res = await fetch(fileUrl, { headers: { Authorization: `Bearer ${cred.key}` } });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const err = await res.json(); if (err?.message) detail = `${err.code || res.status}: ${err.message}`; } catch { /* ignore */ }
        die(detail);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (asJson) {
        const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
        const textType = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|svg\+xml))/.test(contentType);
        const textExt = /\.(?:html?|css|m?js|cjs|json|txt|md|markdown|csv|tsv|svg|xml|ya?ml)$/i.test(flags.file);
        let encoding = 'base64';
        let content = '';
        if (textType || textExt) {
          try {
            content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            encoding = 'utf8';
          } catch {
            content = bytes.toString('base64');
          }
        } else {
          content = bytes.toString('base64');
        }
        printOut({
          project,
          slug,
          version: Number(version),
          path: flags.file,
          contentType,
          bytes: bytes.byteLength,
          encoding,
          content,
        }, true, '');
        return;
      }
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

  if (cmd === 'wait') return cmdWatch('wait', cred, flags, null);
  if (cmd === 'listen') {
    if (!afterDash || afterDash.length === 0) die('Usage: lawh.mjs listen [--project <slug>] [--page <pageId>] [--decision <decId>] [--agents] [--cursor <name>] [--after <seq>] -- <command> [args...]');
    return cmdWatch('listen', cred, flags, afterDash);
  }

  die(`Unknown command: ${cmd}`);
}

function cursorDirPath() {
  if (process.env.LAWH_CURSOR_DIR) return process.env.LAWH_CURSOR_DIR;
  const base = process.env.XDG_STATE_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'lawh', 'cursors');
}

function cursorFilePath(cred, agentId, project, mode, filterKey) {
  const digest = sha256Hex(JSON.stringify([cred.url, agentId, project, mode, filterKey]));
  return join(cursorDirPath(), `${digest}.json`);
}

function readSavedCursor(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed?.seq === 'number' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0) return parsed.seq;
  } catch { /* ignore corrupted cursor */ }
  return null;
}

function writeSavedCursor(file, seq) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ seq, updatedAt: Date.now() })}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && typeof err === 'object' && 'code' in err && err.code === 'EPERM'; }
}

function readLockInfo(lockFile) {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (parsed && typeof parsed.pid === 'number') return parsed;
  } catch { /* empty or unreadable */ }
  return null;
}

function tryLinkLock(targetFile, payload) {
  const tmp = `${targetFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
    try {
      linkSync(tmp, targetFile);
      return true;
    } catch (linkErr) {
      const code = linkErr && typeof linkErr === 'object' && 'code' in linkErr ? linkErr.code : '';
      if (code === 'EEXIST') return false;
      // Fallback on filesystems that disallow hard links.
      try {
        const fd = openSync(targetFile, 'wx', 0o600);
        try { writeFileSync(fd, payload); } finally { closeSync(fd); }
        return true;
      } catch (openErr) {
        if (openErr && typeof openErr === 'object' && 'code' in openErr && openErr.code === 'EEXIST') return false;
        throw openErr;
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function acquireLock(cursorFile) {
  const lockFile = `${cursorFile}.lock`;
  const recoverFile = `${lockFile}.recover`;
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  const token = randomBytes(8).toString('hex');
  const payload = `${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`;

  for (let attempt = 0; attempt < 6; attempt++) {
    if (tryLinkLock(lockFile, payload)) {
      return { lockFile, token };
    }

    const existing = readLockInfo(lockFile);
    if (existing !== null && isPidAlive(existing.pid)) {
      throw new Error(`Another process (pid ${existing.pid}) is already using this cursor.`);
    }
    if (existing === null) {
      try {
        if (Date.now() - statSync(lockFile).mtimeMs < 5_000) {
          throw new Error('Another process is already using this cursor.');
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('already using')) throw err;
        continue; // lock disappeared; retry
      }
    }

    // Serialize stale-lock recovery through a dedicated atomic recover lock so two racing watchers never unlink each other's fresh lock.
    const recPayload = `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`;
    if (tryLinkLock(recoverFile, recPayload)) {
      try {
        const recheck = readLockInfo(lockFile);
        if (recheck !== null && isPidAlive(recheck.pid)) {
          throw new Error(`Another process (pid ${recheck.pid}) is already using this cursor.`);
        }
        if (recheck === null) {
          try {
            if (Date.now() - statSync(lockFile).mtimeMs < 5_000) {
              throw new Error('Another process is already using this cursor.');
            }
          } catch (err) {
            if (err instanceof Error && err.message.includes('already using')) throw err;
          }
        }
        try { unlinkSync(lockFile); } catch { /* already gone */ }
      } finally {
        try { unlinkSync(recoverFile); } catch { /* ignore */ }
      }
    } else {
      // Another process is actively recovering or owns the recover lock; clean up only if that recoverer died.
      const recInfo = readLockInfo(recoverFile);
      if (recInfo !== null && !isPidAlive(recInfo.pid)) {
        try { unlinkSync(recoverFile); } catch { /* raced */ }
      } else if (recInfo === null) {
        try {
          if (Date.now() - statSync(recoverFile).mtimeMs >= 5_000) unlinkSync(recoverFile);
        } catch { /* ignore */ }
      } else {
        throw new Error('Another process is already using this cursor.');
      }
    }
  }
  throw new Error('Could not acquire cursor lock.');
}

function releaseLocks(locks) {
  for (const { lockFile, token } of locks) {
    try {
      const current = readLockInfo(lockFile);
      if (current && current.pid === process.pid && current.token === token) {
        unlinkSync(lockFile);
      }
    } catch { /* ignore */ }
  }
}

function writeStdoutLine(line) {
  const buf = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      const written = writeSync(1, buf, offset, buf.length - offset);
      if (written <= 0) throw new Error('Failed to write event to stdout.');
      offset += written;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EAGAIN') {
        // Brief spin on non-blocking stdout pipe; EPIPE throws immediately and synchronously before cursor save.
        continue;
      }
      throw err;
    }
  }
}

function matchesEvent(ev, { agentId, includeAgents, pageId, decisionId }) {
  if (ev.actorType === 'agent' && ev.actorId === agentId) return false;
  if (!includeAgents && ev.actorType === 'agent') return false;
  if (pageId && ev.pageId !== pageId) return false;
  if (decisionId && ev.subjectId !== decisionId) return false;
  return true;
}

function runHandlerCommand(command, event, onChild) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    onChild?.(child);
    child.on('error', (err) => {
      onChild?.(null);
      process.stderr.write(`Command error: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => {
      onChild?.(null);
      resolve(code ?? 1);
    });
    child.stdin.on('error', () => { /* child closed stdin early */ });
    child.stdin.end(`${JSON.stringify(event)}\n`);
  });
}

async function cmdWatch(mode, cred, flags, command) {
  const afterOverride = flags.after !== undefined ? Number(flags.after) : null;
  if (afterOverride !== null && (!Number.isSafeInteger(afterOverride) || afterOverride < 0)) {
    die('--after must be a non-negative integer.');
  }
  const pollMs = Math.max(50, Number(flags['poll-ms'] || 30_000));
  const catchupMs = Math.max(100, Number(flags['catchup-ms'] || 300_000));
  const timeoutSec = flags.timeout !== undefined ? Number(flags.timeout) : null;
  const once = Boolean(flags.once);
  const deadline = timeoutSec !== null && Number.isFinite(timeoutSec) ? Date.now() + Math.max(0, timeoutSec * 1000) : null;

  let stopping = false;
  let timedOut = false;
  let exitSignal = null;
  let activeChild = null;
  const runAbort = new AbortController();
  let pendingWake = false;
  let wakeResolve = null;
  const wake = () => {
    if (wakeResolve) {
      const r = wakeResolve;
      wakeResolve = null;
      pendingWake = false;
      r();
    } else {
      pendingWake = true;
    }
  };

  let timeoutTimer = null;
  if (deadline !== null) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stopping = true;
      runAbort.abort();
      wake();
    }, Math.max(0, deadline - Date.now()));
  }

  let states = [];
  const acquiredLocks = [];
  const closeSockets = () => {
    for (const s of states) {
      try { s.ws?.close(); } catch { /* ignore */ }
      s.ws = null;
      s.wsOpen = false;
    }
  };
  const cleanup = () => {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    closeSockets();
    releaseLocks(acquiredLocks);
  };

  const onSignal = (sig) => {
    exitSignal = sig;
    stopping = true;
    closeSockets();
    runAbort.abort();
    wake();
    if (activeChild) {
      try { activeChild.kill(sig); } catch { /* ignore */ }
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const sleepInterruptible = (ms) => new Promise((resolve) => {
    const wait = deadline !== null ? Math.max(0, Math.min(ms, deadline - Date.now())) : ms;
    if (wait <= 0 || stopping) { resolve(); return; }
    const timer = setTimeout(() => { wakeResolve = null; resolve(); }, wait);
    wakeResolve = () => { clearTimeout(timer); resolve(); };
  });

  const isPermanentClientError = (err) =>
    err instanceof ApiHttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

  async function requestWithRetry(method, path) {
    let streak = 0;
    while (!stopping) {
      try {
        return await apiRequest(cred, method, path, { signal: runAbort.signal, throwOnHttpError: true });
      } catch (err) {
        if (stopping || timedOut || runAbort.signal.aborted) throw err;
        if (isPermanentClientError(err)) throw err;
        streak++;
        process.stderr.write(`Transient error on ${path}: ${err instanceof Error ? err.message : String(err)}; retrying...\n`);
        const backoff = Math.min(pollMs, 250 * 2 ** Math.min(streak - 1, 4));
        await sleepInterruptible(backoff);
      }
    }
    throw new Error('Aborted.');
  }

  let exitCodeOnReturn = 0;
  try {
    const me = await requestWithRetry('GET', '/v1/me');

    const agentId = me.agentId;
    const projects = typeof flags.project === 'string'
      ? [flags.project]
      : (me.projects || []).map((p) => p.slug);
    if (projects.length === 0) die('No accessible projects to watch.');

    const pageId = typeof flags.page === 'string' ? flags.page : null;
    const decisionId = typeof flags.decision === 'string' ? flags.decision : null;
    const includeAgents = Boolean(flags.agents);
    const filterKey = typeof flags.cursor === 'string'
      ? `named:${flags.cursor}`
      : JSON.stringify({ pageId, decisionId, includeAgents });

    states = projects.map((slug) => {
      const file = cursorFilePath(cred, agentId, slug, mode, filterKey);
      return { slug, file, lock: null, seq: 0, ws: null, wsOpen: false, connecting: false, reconnectAt: 0 };
    });

    for (const s of states) {
      s.lock = acquireLock(s.file);
      acquiredLocks.push(s.lock);
    }

    // Initialize cursors: --after overrides AND persists immediately so a restart after a failed handler never loses the event.
    for (const s of states) {
      if (stopping) break;
      if (afterOverride !== null) {
        s.seq = afterOverride;
        writeSavedCursor(s.file, s.seq);
      } else {
        const saved = readSavedCursor(s.file);
        if (saved !== null) {
          s.seq = saved;
        } else {
          const head = await requestWithRetry('GET', `/v1/events?project=${encodeURIComponent(s.slug)}`);
          s.seq = typeof head?.next === 'number' ? head.next : 0;
          writeSavedCursor(s.file, s.seq);
        }
      }
    }

    const filterOpts = { agentId, includeAgents, pageId, decisionId };

    async function drainProject(s) {
      while (!stopping) {
        const beforeSeq = s.seq;
        let data;
        try {
          data = await apiRequest(cred, 'GET', `/v1/events?project=${encodeURIComponent(s.slug)}&after=${s.seq}`, { signal: runAbort.signal, throwOnHttpError: true });
        } catch (err) {
          if (stopping || timedOut || runAbort.signal.aborted) return 'aborted';
          if (isPermanentClientError(err)) throw err;
          process.stderr.write(`Transient error reading events for ${s.slug}: ${err instanceof Error ? err.message : String(err)}; retrying...\n`);
          return 'retry';
        }
        const items = Array.isArray(data?.items) ? data.items : [];
        const nextSeq = typeof data?.next === 'number' ? data.next : s.seq;

        for (const ev of items) {
          if (stopping) return 'aborted';
          if (!matchesEvent(ev, filterOpts)) continue;
          const out = { project: s.slug, ...ev };
          if (mode === 'wait') {
            // Confirm stdout write succeeds synchronously BEFORE advancing the saved cursor so broken pipes never drop an event.
            writeStdoutLine(`${JSON.stringify(out)}\n`);
            s.seq = ev.seq;
            writeSavedCursor(s.file, s.seq);
            return 'done';
          }
          const exitCode = await runHandlerCommand(command, out, (c) => { activeChild = c; });
          if (exitCode !== 0) {
            if (stopping) return 'aborted';
            process.stderr.write(`Handler exited with code ${exitCode} on event #${ev.seq}; cursor kept at ${s.seq}.\n`);
            return 'handler_failed';
          }
          s.seq = ev.seq;
          writeSavedCursor(s.file, s.seq);
          if (once) return 'done';
        }

        if (nextSeq > s.seq) {
          s.seq = nextSeq;
          writeSavedCursor(s.file, s.seq);
        }
        // Keep draining immediately while the server returned a full page that advanced the cursor.
        if (items.length === 0 || nextSeq <= beforeSeq) break;
      }
      return 'idle';
    }

    // Run ticket probe non-blocking with a bounded per-probe timeout so a stalled ticket endpoint never blocks event polling.
    function triggerSocketProbe(s) {
      if (stopping || s.ws || s.connecting || typeof globalThis.WebSocket !== 'function') return;
      if (Date.now() < s.reconnectAt) return;
      s.connecting = true;
      const probeTimeoutMs = Math.min(Math.max(pollMs, 1_000), 10_000);
      const probeSignal = AbortSignal.any([runAbort.signal, AbortSignal.timeout(probeTimeoutMs)]);
      void (async () => {
        try {
          const res = await fetch(`${cred.url}/v1/events/ticket`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: s.slug }),
            signal: probeSignal,
          });
          if (res.status === 404) {
            s.reconnectAt = Date.now() + Math.max(0, pollMs - 50);
            return;
          }
          if (!res.ok) {
            s.reconnectAt = Date.now() + Math.min(pollMs, 5_000);
            return;
          }
          const { url: wsUrl } = await res.json();
          if (stopping) return;
          const ws = new WebSocket(wsUrl);
          s.ws = ws;
          s.wsOpen = false;
          ws.addEventListener('open', () => {
            if (s.ws === ws) s.wsOpen = true;
            wake();
          });
          ws.addEventListener('message', () => wake());
          ws.addEventListener('close', () => {
            if (s.ws === ws) { s.ws = null; s.wsOpen = false; }
            s.reconnectAt = Date.now() + Math.min(pollMs, 1_000);
            wake();
          });
          ws.addEventListener('error', () => {
            if (s.ws === ws) { s.ws = null; s.wsOpen = false; }
            s.reconnectAt = Date.now() + Math.min(pollMs, 5_000);
            wake();
          });
        } catch {
          s.reconnectAt = Date.now() + Math.min(pollMs, 5_000);
        } finally {
          s.connecting = false;
        }
      })();
    }

    let transientStreak = 0;
    while (!stopping) {
      let hadTransientError = false;
      for (const s of states) {
        const res = await drainProject(s);
        if (res === 'done') return;
        if (res === 'aborted') break;
        if (res === 'retry') hadTransientError = true;
        if (res === 'handler_failed') {
          cleanup();
          process.exit(1);
        }
      }
      transientStreak = hadTransientError ? transientStreak + 1 : 0;
      if (stopping) break;
      if (deadline !== null && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      for (const s of states) triggerSocketProbe(s);
      if (stopping) break;
      if (pendingWake) {
        pendingWake = false;
        continue;
      }
      const allLiveOpen = states.length > 0 && states.every((s) => s.ws !== null && s.wsOpen);
      const retryBackoff = Math.min(pollMs, 250 * 2 ** Math.min(Math.max(transientStreak - 1, 0), 4));
      const waitMs = hadTransientError ? retryBackoff : allLiveOpen ? catchupMs : pollMs;
      await sleepInterruptible(waitMs);
    }
    if (timedOut) exitCodeOnReturn = 124;
  } catch (err) {
    if (timedOut) {
      exitCodeOnReturn = 124;
    } else if (exitSignal) {
      exitCodeOnReturn = 0;
    } else {
      throw err;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
  if (exitCodeOnReturn !== 0) process.exit(exitCodeOnReturn);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
