// Lawh's own export for `lawh destroy`: ZIP of JSON rows + page files, without the search index.
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Tables in loadable order (matching src/app/people/exportData.ts). Search index and secrets are excluded. */
export const EXPORT_TABLES = [
  ['projects', ['id']],
  ['members', ['id']],
  ['teams', ['id']],
  ['team_members', ['team_id', 'member_id']],
  ['team_projects', ['team_id', 'project_id']],
  ['agents', ['id']],
  ['agent_keys', ['id'], 'id, agent_id, scopes_json, all_projects, created_at, expires_at, last_used_at, revoked_at, label'],
  ['agent_key_projects', ['key_id', 'project_id']],
  ['pages', ['id']],
  ['page_tags', ['page_id', 'tag']],
  ['page_versions', ['id']],
  ['blobs', ['sha256'], 'sha256, bytes, created_at'],
  ['version_files', ['version_id', 'path']],
  ['project_blobs', ['project_id', 'sha256']],
  ['decisions', ['id']],
  ['decision_revisions', ['decision_id', 'revision']],
  ['decision_answers', ['decision_id', 'seq']],
  ['comments', ['id']],
  ['events', ['seq']],
  ['webhooks', ['id'], 'id, project_id, url, event_types_json, enabled, created_by, created_at'],
  ['settings', ['key']],
  ['audit', ['seq']],
];

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX32 = 0xffffffff;

function pack(...fields) {
  const out = new Uint8Array(fields.reduce((n, [size]) => n + size, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [size, value] of fields) {
    if (size === 2) view.setUint16(at, value, true);
    else if (size === 4) view.setUint32(at, value, true);
    else view.setBigUint64(at, BigInt(value), true);
    at += size;
  }
  return out;
}

const LFH_ZIP64 = pack([2, 1], [2, 16], [8, 0], [8, 0]);

function centralEntry(encoded, crc, size, offset) {
  const big = size >= MAX32;
  const far = offset >= MAX32;
  const fields = [];
  if (big) fields.push([8, size], [8, size]);
  if (far) fields.push([8, offset]);
  const extra = fields.length > 0 ? pack([2, 1], [2, fields.length * 8], ...fields) : new Uint8Array();
  const header = pack(
    [4, 0x02014b50], [2, 45], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21],
    [4, crc], [4, big ? MAX32 : size], [4, big ? MAX32 : size], [2, encoded.length], [2, extra.length],
    [2, 0], [2, 0], [2, 0], [4, 0], [4, far ? MAX32 : offset],
  );
  return [header, encoded, extra];
}

async function* streamZip(entries) {
  const directory = [];
  let at = 0;
  const encoder = new TextEncoder();
  for await (const { name, chunks } of entries) {
    const encoded = encoder.encode(name);
    const offset = at;
    if (encoded.length > 0xffff) throw new RangeError('ZIP entry name is too long.');
    const head = pack(
      [4, 0x04034b50], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21],
      [4, 0], [4, 0], [4, 0], [2, encoded.length], [2, LFH_ZIP64.length],
    );
    yield head;
    yield encoded;
    yield LFH_ZIP64;
    at += head.length + encoded.length + LFH_ZIP64.length;
    let crc = 0;
    let size = 0;
    for await (const chunk of chunks) {
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      crc = crc32(buf, crc);
      size += buf.length;
      yield buf;
    }
    const tail = pack([4, 0x08074b50], [4, crc], [8, size], [8, size]);
    yield tail;
    at += size + tail.length;
    directory.push(...centralEntry(encoded, crc, size, offset));
  }
  const start = at;
  const size = directory.reduce((n, part) => n + part.length, 0);
  const count = directory.length / 3;
  yield* directory;
  at += size;
  if (count >= 0xffff || start >= MAX32 || size >= MAX32) {
    yield pack([4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0], [8, count], [8, count], [8, size], [8, start]);
    yield pack([4, 0x07064b50], [4, 0], [8, at], [4, 1]);
  }
  yield pack(
    [4, 0x06054b50], [2, 0], [2, 0],
    [2, Math.min(count, 0xffff)], [2, Math.min(count, 0xffff)],
    [4, Math.min(size, MAX32)], [4, Math.min(start, MAX32)], [2, 0],
  );
}

function resolveWithExistingAncestor(targetPath) {
  const abs = resolve(targetPath);
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length).replace(/^[/\\]/, ''));
    cur = parent;
  }
  const baseReal = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(baseReal, ...tail) : baseReal;
}

export function defaultExportDir(homeDir = homedir()) {
  return join(homeDir, 'lawh-exports');
}

export function expandUserPath(raw, homeDir = homedir()) {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homeDir, raw.slice(2));
  return raw;
}

/** Refuses any export path that equals or falls inside the git working tree. */
export function assertOutsideRepo(exportDir, repoRoot, homeDir = homedir()) {
  const expanded = expandUserPath(exportDir, homeDir);
  const targetReal = resolveWithExistingAncestor(expanded);
  const repoReal = resolveWithExistingAncestor(repoRoot);
  const rel = relative(repoReal, targetReal);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`Export folder must be outside the repository (${repoRoot}). Choose a folder such as ${defaultExportDir(homeDir)}.`);
  }
  return targetReal;
}

async function* queryRowsNdjson(cf, accountId, dbId, table, key, columns) {
  const encoder = new TextEncoder();
  const limit = 500;
  let after = [];
  for (;;) {
    const marks = key.map(() => '?').join(', ');
    const where = after.length > 0 ? ` WHERE (${key.join(', ')}) > (${marks})` : '';
    const sql = `SELECT ${columns} FROM ${table}${where} ORDER BY ${key.join(', ')} LIMIT ${limit}`;
    const res = await cf.queryD1(accountId, dbId, sql, after);
    const rows = res?.[0]?.results ?? [];
    if (rows.length > 0) {
      yield encoder.encode(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    }
    if (rows.length < limit) return;
    after = key.map((k) => rows.at(-1)[k]);
  }
}

async function* oneText(text) {
  yield new TextEncoder().encode(text);
}

async function* oneBytes(bytes) {
  yield bytes;
}

export async function exportInstance({ cf, accountId, dbId, bucketName, exportDir, repoRoot, homeDir = homedir(), now = Date.now() }) {
  const safeDir = assertOutsideRepo(exportDir, repoRoot, homeDir);
  mkdirSync(safeDir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const zipPath = join(safeDir, `lawh-export-${stamp}.zip`);
  const tmpPath = `${zipPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;

  let fileCount = 0;

  async function* entries() {
    const manifest = {
      format: 1,
      madeAt: now,
      tables: EXPORT_TABLES.map(([t]) => t),
      note: 'One JSON object per line in rows/*.ndjson. Search index (pages_fts) is omitted and rebuilt on import. Load rows before adding triggers.',
    };
    yield { name: 'lawh.json', chunks: oneText(`${JSON.stringify(manifest, null, 2)}\n`) };
    for (const [table, key, columns = '*'] of EXPORT_TABLES) {
      yield { name: `rows/${table}.ndjson`, chunks: queryRowsNdjson(cf, accountId, dbId, table, key, columns) };
    }
    let cursor = '';
    for (;;) {
      const res = await cf.queryD1(
        accountId,
        dbId,
        'SELECT sha256, r2_key FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT 500',
        [cursor],
      );
      const blobs = res?.[0]?.results ?? [];
      for (const { sha256, r2_key } of blobs) {
        try {
          const data = await cf.getR2Object(accountId, bucketName, r2_key);
          fileCount++;
          yield { name: `files/${sha256}`, chunks: oneBytes(data) };
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
      }
      if (blobs.length < 500) break;
      cursor = blobs.at(-1).sha256;
    }
  }

  let totalBytes = 0;
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  try {
    for await (const chunk of streamZip(entries())) {
      totalBytes += chunk.byteLength;
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.once('error', reject);
    });
    renameSync(tmpPath, zipPath);
  } catch (err) {
    out.destroy();
    throw err;
  }

  return { zipPath, tables: EXPORT_TABLES.map(([t]) => t), fileCount, bytes: totalBytes };
}
