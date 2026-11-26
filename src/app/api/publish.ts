import { hex } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { type Declared, declareStatements, readDeclared } from '../decisions/declare';
import { indexStatements } from '../search';
import { pruneVersions, versionsKept } from '../housekeeping';
import { entryText } from '../search/entry';
import { dispatchOutbox } from '../webhooks/deliver';
import { type Project, projectById, projectBySlug } from './auth';
import { integer, isObject, onlyKeys, readJson, text } from './body';
import { idempotent, type Idempotent, mustChange, replay, type Stored, writeOnce } from './idempotency';
import { eventStatement, type Meta, newPageId, pageJson, type PageRow, readMeta, tagStatements } from './pages';
import { checkPath, isHtml, mediaType } from './paths';
import type { Context } from './router';
import { secretScanner } from './scan';

const MAX_FILES = 500, MAX_FILE = 26_214_400, MAX_TOTAL = 104_857_600;
const UPLOAD_LIFE = 6 * 3_600_000;
const SHA = /^[0-9a-f]{64}$/;

interface File { path: string; sha256: string; bytes: number; type: string }
interface Manifest { entry: string; note: string; page: Meta; files: File[]; decisions?: Declared[] }
interface UploadRow { id: string; project_id: string; slug: string; key_id: string; base_version: number; manifest_json: string; expires_at: number }

function readManifest(body: Record<string, unknown>): { baseVersion: number; manifest: Manifest } {
  onlyKeys(body, ['baseVersion', 'entry', 'note', 'page', 'files', 'decisions']);
  const baseVersion = integer(body.baseVersion, 'baseVersion', 0, Number.MAX_SAFE_INTEGER - 1);
  if (!isObject(body.page)) throw invalid('page must be an object.');
  const page = readMeta(body.page);
  if (baseVersion === 0 && page.title === undefined) throw invalid('A new page needs page.title.');
  const decisions = body.decisions === undefined ? undefined : readDeclared(body.decisions);
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_FILES) throw invalid(`files must list 1 to ${MAX_FILES} files.`);
  const paths = new Set<string>(), sizes = new Map<string, number>();
  let total = 0;
  const files = body.files.map((item: unknown): File => {
    if (!isObject(item)) throw invalid('Each file must be an object.');
    onlyKeys(item, ['path', 'sha256', 'bytes']);
    const path = checkPath(item.path);
    if (typeof item.sha256 !== 'string' || !SHA.test(item.sha256)) throw invalid('sha256 must be 64 lowercase hex characters.', { path });
    const bytes = integer(item.bytes, 'bytes', 0, MAX_FILE);
    if (paths.has(path)) throw invalid('A path is listed twice.', { path });
    if ((sizes.get(item.sha256) ?? bytes) !== bytes) throw invalid('One sha256 is listed with two sizes.', { path });
    paths.add(path); sizes.set(item.sha256, bytes); total += bytes;
    return { path, sha256: item.sha256, bytes, type: mediaType(path) };
  });
  if (total > MAX_TOTAL) throw new ApiError('too_large', 'A version can hold at most 100 MB.');
  const entry = body.entry === undefined ? 'index.html' : checkPath(body.entry);
  if (!paths.has(entry) || !isHtml(entry)) throw invalid('entry must be an HTML file in files.');
  return { baseVersion, manifest: { entry, note: body.note === undefined ? '' : text(body.note, 'note', { max: 500 }), page, files, ...(decisions && { decisions }) } };
}

const isConflict = (error: unknown): boolean => /version conflict|UNIQUE constraint failed: (pages|page_versions)\./.test(String(error));

export async function startPublish(ctx: Context): Promise<Response> {
  const { env, caller } = ctx, slug = ctx.params[1]!;
  const project = await projectBySlug(env, caller, ctx.params[0]!);
  const { body, text: raw } = await readJson(ctx.request);
  const idem = await idempotent(ctx.request, raw);
  const earlier = await replay(env, caller, idem);
  if (earlier) return Response.json(earlier.json, { status: earlier.status });
  const { baseVersion, manifest } = readManifest(body);

  const page = await env.DB.prepare('SELECT current_version, deleted_at FROM pages WHERE project_id = ? AND slug = ?').bind(project.id, slug)
    .first<{ current_version: number; deleted_at: number | null }>();
  if (page?.deleted_at != null) throw conflict('A deleted page has this address.');
  if ((page?.current_version ?? 0) !== baseVersion) throw conflict('baseVersion is not the current version.', { currentVersion: page?.current_version ?? 0 });

  // Only what this project already proved it holds may be reused.
  const hashes = [...new Set(manifest.files.map((f) => f.sha256))];
  const { results: held } = await env.DB.prepare(
    `SELECT b.sha256, b.bytes FROM json_each(?) j CROSS JOIN project_blobs pb ON pb.project_id = ? AND pb.sha256 = j.value JOIN blobs b ON b.sha256 = pb.sha256`)
    .bind(JSON.stringify(hashes), project.id).all<{ sha256: string; bytes: number }>();
  const sizes = new Map(manifest.files.map((f) => [f.sha256, f.bytes]));
  if (held.some((b) => sizes.get(b.sha256) !== b.bytes)) throw invalid('A file has the wrong size for its sha256.');
  const reused = JSON.stringify(held.map((b) => b.sha256)), have = new Set(held.map((b) => b.sha256));

  const now = Date.now(), uploadId = newId('upl', now), expiresAt = now + UPLOAD_LIFE;
  const reply = { status: 201, json: { uploadId, missing: hashes.filter((h) => !have.has(h)), expiresAt } };
  const stored = await writeOnce(env, caller, idem, reply, [
    env.DB.prepare('INSERT INTO uploads(id, project_id, slug, key_id, base_version, manifest_json, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(uploadId, project.id, slug, caller.keyId, baseVersion, JSON.stringify(manifest), now, expiresAt),
    // A blob cleaned up since the read above fails its foreign key, and with it the whole start.
    env.DB.prepare('INSERT INTO upload_blobs(upload_id, sha256) SELECT ?, value FROM json_each(?)').bind(uploadId, reused),
    env.DB.prepare('UPDATE blobs SET unreferenced_at = NULL WHERE sha256 IN (SELECT value FROM json_each(?)) AND unreferenced_at IS NOT NULL').bind(reused),
  ]).catch((error: unknown) => {
    if (String(error).includes('FOREIGN KEY')) throw conflict('A file was cleaned up meanwhile. Start again.');
    throw error;
  });
  return Response.json(stored.json, { status: stored.status });
}

/** The upload, if it is this key's, still open, and its person may still publish there. */
async function findUpload(ctx: Context): Promise<{ upload: UploadRow; project: Project; manifest: Manifest }> {
  const upload = await ctx.env.DB.prepare('SELECT * FROM uploads WHERE id = ?').bind(ctx.params[0]!).first<UploadRow>();
  if (!upload || upload.key_id !== ctx.caller.keyId || upload.expires_at <= Date.now()) throw notFound();
  return { upload, project: await projectById(ctx.env, ctx.caller, upload.project_id), manifest: JSON.parse(upload.manifest_json) as Manifest };
}

/** Best effort: the weekly job removes objects without a row. */
function dropObject(ctx: Context, key: string): void {
  ctx.ctx.waitUntil(ctx.env.FILES.delete(key).catch(() => undefined));
}

export async function putBlob(ctx: Context): Promise<Response> {
  const { env } = ctx, sha256 = ctx.params[1]!;
  const { upload, manifest } = await findUpload(ctx);
  const file = manifest.files.find((f) => f.sha256 === sha256);
  if (!file) throw invalid('This upload does not list that sha256.');
  const length = ctx.request.headers.get('Content-Length');
  if (length !== null && Number(length) !== file.bytes) throw invalid('The size is not the one listed.');

  const r2Key = `blobs/${sha256}/${newId('obj')}`;
  const known = await env.DB.prepare('SELECT bytes FROM blobs WHERE sha256 = ?').bind(sha256).first<{ bytes: number }>();
  // Every body is scanned and hashed, also when the blob exists: knowing a hash isn't having the file.
  const digest = new crypto.DigestStream('SHA-256'), hasher = digest.getWriter();
  // Both fail along with a body that is refused, where the pipe below already reports it.
  digest.digest.catch(() => undefined);
  hasher.closed.catch(() => undefined);
  let size = 0;
  const checked = (ctx.request.body ?? new Blob([]).stream()).pipeThrough(secretScanner()).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > file.bytes) throw invalid('The body is not the file listed.');
      await hasher.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await hasher.close();
      const hash = hex(await digest.digest);
      if (hash !== sha256 || size !== file.bytes || (known && known.bytes !== file.bytes)) throw invalid('The body is not the file listed.');
    },
  }));
  let stored = false;
  if (known) {
    await checked.pipeTo(new WritableStream());
  } else {
    // R2 needs the length, and checks the hash again. A stream that fails stores nothing.
    const fixed = new FixedLengthStream(file.bytes), stop = new AbortController();
    const results = await Promise.allSettled([
      checked.pipeTo(fixed.writable, { signal: stop.signal }),
      // When R2 fails nobody reads the stream, so the pipe is ended too.
      env.FILES.put(r2Key, fixed.readable, { sha256 }).then(() => { stored = true; }, (error: unknown) => {
        stop.abort(error);
        void fixed.readable.cancel(error).catch(() => undefined);
        throw error;
      }),
    ]);
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    if (failures.length > 0) {
      // Also when the put failed: it can have failed after storing.
      dropObject(ctx, r2Key);
      throw failures.find((reason) => reason instanceof ApiError) ?? failures[0];
    }
  }

  let winner: string | null = null;
  try {
    const statements = [
      ...(known ? [] : [env.DB.prepare('INSERT INTO blobs(sha256, r2_key, bytes, created_at) VALUES(?,?,?,?) ON CONFLICT(sha256) DO NOTHING').bind(sha256, r2Key, file.bytes, Date.now())]),
      env.DB.prepare('INSERT INTO upload_blobs(upload_id, sha256) VALUES(?,?) ON CONFLICT DO NOTHING').bind(upload.id, sha256),
      env.DB.prepare('INSERT INTO project_blobs(project_id, sha256) VALUES(?,?) ON CONFLICT DO NOTHING').bind(upload.project_id, sha256),
      env.DB.prepare('UPDATE blobs SET unreferenced_at = NULL WHERE sha256 = ?').bind(sha256),
      env.DB.prepare('SELECT r2_key FROM blobs WHERE sha256 = ?').bind(sha256),
    ];
    const results = await env.DB.batch<{ r2_key: string }>(statements);
    winner = results.at(-1)!.results[0]?.r2_key ?? null;
  } catch (error) {
    if (String(error).includes('FOREIGN KEY')) throw conflict('The file or the upload was cleaned up meanwhile. Send it again.');
    throw error;
  } finally {
    // Another upload of the same file won, or nothing was recorded: this object isn't the blob's.
    if (stored && winner !== r2Key) dropObject(ctx, r2Key);
  }
  return new Response(null, { status: 204 });
}

export async function commitPublish(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  const idem = await idempotent(ctx.request, '');
  const given = async (): Promise<Response | null> => {
    const earlier = await replay(env, caller, idem);
    if (!earlier) return null;
    // The upload is gone by now, so access is checked on the page it made.
    await projectBySlug(env, caller, String(earlier.json.project));
    return Response.json(earlier.json, { status: earlier.status });
  };
  const earlier = await given();
  if (earlier) return earlier;
  try {
    const stored = await commitNew(ctx, idem);
    ctx.ctx.waitUntil(keepVersions(ctx.env, String(stored.json.id), Number(stored.json.currentVersion)).catch(() => undefined));
    ctx.ctx.waitUntil(dispatchOutbox(ctx.env).catch(() => undefined));
    return Response.json(stored.json, { status: stored.status });
  } catch (error) {
    // The same request, sent twice at once, may have finished meanwhile: then its reply is the answer.
    const twin = await given();
    if (twin) return twin;
    throw error;
  }
}

/** Best effort: what is left is pruned at the next publish. */
async function keepVersions(env: AppEnv, pageId: string, currentVersion: number): Promise<void> {
  const keep = await versionsKept(env);
  if (keep !== null) await pruneVersions(env, pageId, currentVersion, keep);
}

async function commitNew(ctx: Context, idem: Idempotent): Promise<Stored> {
  const { upload, project, manifest } = await findUpload(ctx);
  const { results: sent } = await ctx.env.DB.prepare('SELECT sha256 FROM upload_blobs WHERE upload_id = ?').bind(upload.id).all<{ sha256: string }>();
  const have = new Set(sent.map((b) => b.sha256));
  const missing = [...new Set(manifest.files.map((f) => f.sha256))].filter((h) => !have.has(h));
  if (missing.length > 0) throw invalid('Some files were not sent.', { missing });

  const text = await entryText(ctx.env, manifest.files.find((f) => f.path === manifest.entry)!.sha256);
  for (let attempt = 1; ; attempt++) {
    try {
      return await commitOnce(ctx, upload, project, manifest, text, idem);
    } catch (error) {
      if (isConflict(error)) throw conflict('Someone published a newer version.');
      if (!String(error).includes('malformed JSON')) throw error;
      // The page's details changed, or the upload was cleaned up, between the read and the write. Read both again.
      await findUpload(ctx);
      if (attempt === 5) throw conflict('The page keeps changing. Try again.');
    }
  }
}

async function commitOnce(ctx: Context, upload: UploadRow, project: Project, manifest: Manifest, text: string, idem: Idempotent): Promise<Stored> {
  const { env, caller } = ctx;
  const current = await env.DB.prepare('SELECT * FROM pages WHERE project_id = ? AND slug = ?').bind(project.id, upload.slug).first<PageRow>();
  if (current?.deleted_at != null || (current?.current_version ?? 0) !== upload.base_version) throw conflict('Someone published a newer version.', { currentVersion: current?.current_version ?? 0 });

  const now = Math.max(Date.now(), (current?.updated_at ?? 0) + 1), n = upload.base_version + 1, meta = manifest.page;
  const page: PageRow = {
    id: current?.id ?? newPageId(now), project_id: project.id, slug: upload.slug, title: meta.title ?? current?.title ?? '',
    summary: meta.summary ?? current?.summary ?? '', lang: meta.lang ?? current?.lang ?? 'en', status: meta.status ?? current?.status ?? 'draft',
    current_version: n, created_at: current?.created_at ?? now, updated_at: now, deleted_at: null,
  };
  // Tags only change together with updated_at, which the guard below checks.
  const oldTags = current ? (await env.DB.prepare('SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag').bind(current.id).all<{ tag: string }>()).results.map((t) => t.tag) : [];
  const tags = [...(meta.tags ?? oldTags)].sort();
  const versionId = newId('ver', now);
  return writeOnce(env, caller, idem, { status: 200, json: pageJson(ctx, project, page, tags) }, [
    env.DB.prepare('DELETE FROM upload_blobs WHERE upload_id = ?').bind(upload.id),
    env.DB.prepare('DELETE FROM uploads WHERE id = ? AND expires_at > ?').bind(upload.id, Date.now()),
    mustChange(env),
    ...(current
      ? [
        env.DB.prepare('UPDATE pages SET title=?, summary=?, lang=?, status=?, updated_at=? WHERE id=? AND updated_at=? AND deleted_at IS NULL')
          .bind(page.title, page.summary, page.lang, page.status, now, page.id, current.updated_at),
        mustChange(env),
      ]
      : [env.DB.prepare('INSERT INTO pages(id, project_id, slug, title, summary, lang, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(page.id, project.id, page.slug, page.title, page.summary, page.lang, page.status, caller.agentId, now, now)]),
    env.DB.prepare('INSERT INTO page_versions(id, page_id, n, entry_path, note, bytes, file_count, published_by, key_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(versionId, page.id, n, manifest.entry, manifest.note, manifest.files.reduce((sum, f) => sum + f.bytes, 0), manifest.files.length, caller.agentId, caller.keyId, now),
    env.DB.prepare(`INSERT INTO version_files(version_id, path, sha256, media_type, bytes)
      SELECT ?, j.value ->> 'path', j.value ->> 'sha256', j.value ->> 'type', j.value ->> 'bytes' FROM json_each(?) j`).bind(versionId, JSON.stringify(manifest.files)),
    ...(meta.tags ? tagStatements(env, page.id, project.id, tags, now) : []),
    ...(manifest.decisions ? declareStatements(env, manifest.decisions, { pageId: page.id, projectId: project.id, versionId, n, agentId: caller.agentId, now }) : []),
    ...indexStatements(env, page.id, { title: page.title, summary: page.summary, tags }, text),
    eventStatement(env, project.id, page.id, 'page.published', page.id, caller.agentId, now),
    ...(current && current.status !== page.status ? [eventStatement(env, project.id, page.id, 'page.status', page.id, caller.agentId, now)] : []),
  ]);
}

const DAY = 86_400_000, BATCH = 100;

/** Hourly: old idempotency rows, expired uploads, and files nothing has used for a day. */
export async function cleanUp(env: AppEnv, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM idempotency WHERE (key_id, idem_key) IN (SELECT key_id, idem_key FROM idempotency WHERE expires_at < ? LIMIT 5000)').bind(now).run();
  const { results: uploads } = await env.DB.prepare('SELECT id FROM uploads WHERE expires_at < ? LIMIT ?').bind(now, BATCH).all<{ id: string }>();
  for (const { id } of uploads) {
    // Marked from the rows as they are in this transaction, so a file sent at this moment is marked too.
    await env.DB.batch([
      env.DB.prepare(`UPDATE blobs SET unreferenced_at = ? WHERE sha256 IN (SELECT sha256 FROM upload_blobs WHERE upload_id = ?) AND unreferenced_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM version_files f WHERE f.sha256 = blobs.sha256)
        AND NOT EXISTS (SELECT 1 FROM upload_blobs u WHERE u.sha256 = blobs.sha256 AND u.upload_id <> ?)`).bind(now, id, id),
      env.DB.prepare('DELETE FROM upload_blobs WHERE upload_id = ?').bind(id),
      env.DB.prepare('DELETE FROM uploads WHERE id = ?').bind(id),
    ]);
  }
  const { results: old } = await env.DB.prepare('SELECT sha256 FROM blobs WHERE unreferenced_at < ? AND unreferenced_at IS NOT NULL LIMIT ?').bind(now - DAY, BATCH).all<{ sha256: string }>();
  for (const { sha256 } of old) {
    // The row goes first, and only while nothing uses it; then the object, whose key is never used again.
    const [gone] = await env.DB.batch<{ r2_key: string }>([
      env.DB.prepare(`DELETE FROM blobs WHERE sha256 = ? AND unreferenced_at < ? AND NOT EXISTS (SELECT 1 FROM version_files f WHERE f.sha256 = blobs.sha256)
        AND NOT EXISTS (SELECT 1 FROM upload_blobs u WHERE u.sha256 = blobs.sha256) RETURNING r2_key`).bind(sha256, now - DAY),
      // Still there means it is used: out of this queue.
      env.DB.prepare('UPDATE blobs SET unreferenced_at = NULL WHERE sha256 = ? AND unreferenced_at < ?').bind(sha256, now - DAY),
    ]);
    const key = gone?.results[0]?.r2_key;
    if (key) await env.FILES.delete(key);
  }
}
