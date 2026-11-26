import type { AppEnv } from '../shared/env';

/** What the hourly job removes for good: deleted pages and comments after 30 days, and versions past what the copy keeps. */

export const PURGE_AFTER = 30 * 86_400_000;
const DAY = 86_400_000, SWEEP = 1000;
const VERSIONS = 20, PAGES = 20, WALK = 200;

/** Fails the batch unless the page is deleted long enough: it may have been restored since it was found. */
const stillDue = (env: AppEnv, pageId: string, cutoff: number): D1PreparedStatement =>
  env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM pages WHERE id = ? AND deleted_at < ?) THEN 1 ELSE json('restored') END").bind(pageId, cutoff);

/** Its files are looked at by the file clean-up, which keeps what another version still uses. */
const dropVersion = (env: AppEnv, id: string, now: number): D1PreparedStatement[] => [
  env.DB.prepare('UPDATE blobs SET unreferenced_at = ? WHERE sha256 IN (SELECT sha256 FROM version_files WHERE version_id = ?) AND unreferenced_at IS NULL').bind(now, id),
  env.DB.prepare('DELETE FROM version_files WHERE version_id = ?').bind(id),
  env.DB.prepare('DELETE FROM page_versions WHERE id = ?').bind(id),
];

async function purgePage(env: AppEnv, pageId: string, cutoff: number, now: number): Promise<void> {
  // A few versions at a time: a page can have very many files.
  for (let i = 0; i < 10; i++) {
    const { results } = await env.DB.prepare('SELECT id FROM page_versions WHERE page_id = ? ORDER BY n LIMIT 5').bind(pageId).all<{ id: string }>();
    if (results.length === 0) break;
    await env.DB.batch([stillDue(env, pageId, cutoff), ...results.flatMap((v) => dropVersion(env, v.id, now))]);
  }
  if (await env.DB.prepare('SELECT 1 FROM page_versions WHERE page_id = ? LIMIT 1').bind(pageId).first()) return; // The rest next hour.
  const own = '(SELECT id FROM decisions WHERE page_id = ?)';
  await env.DB.batch([
    stillDue(env, pageId, cutoff),
    env.DB.prepare('DELETE FROM pages_fts WHERE rowid = (SELECT rowid FROM pages_fts_map WHERE page_id = ?)').bind(pageId),
    env.DB.prepare('DELETE FROM pages_fts_map WHERE page_id = ?').bind(pageId),
    env.DB.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(pageId),
    env.DB.prepare('DELETE FROM comments WHERE page_id = ?').bind(pageId),
    env.DB.prepare(`DELETE FROM decision_answers WHERE decision_id IN ${own}`).bind(pageId),
    env.DB.prepare(`DELETE FROM decision_revisions WHERE decision_id IN ${own}`).bind(pageId),
    env.DB.prepare('DELETE FROM decisions WHERE page_id = ?').bind(pageId),
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId),
  ]);
}

export async function purge(env: AppEnv, now = Date.now()): Promise<void> {
  const cutoff = now - PURGE_AFTER;
  await env.DB.prepare('DELETE FROM comments WHERE id IN (SELECT id FROM comments WHERE deleted_at < ? AND deleted_at IS NOT NULL LIMIT 500)').bind(cutoff).run();
  await env.DB.prepare('UPDATE members SET name = NULL WHERE id IN (SELECT id FROM members WHERE removed_at < ? AND removed_at IS NOT NULL AND name IS NOT NULL LIMIT 500)').bind(cutoff).run();
  const { results } = await env.DB.prepare('SELECT id FROM pages WHERE deleted_at < ? AND deleted_at IS NOT NULL LIMIT ?').bind(cutoff, PAGES).all<{ id: string }>();
  for (const { id } of results) {
    // One that is restored at this moment, or fails, doesn't keep the others.
    await purgePage(env, id, cutoff, now).catch((error: unknown) => { if (!String(error).includes('malformed JSON')) console.error('A page was not purged'); });
  }
}

/** How many versions a page keeps; null keeps all. */
export async function versionsKept(env: AppEnv): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'retention'").first<{ value_json: string }>();
  const keep: unknown = row ? JSON.parse(row.value_json) : null;
  return typeof keep === 'number' && Number.isInteger(keep) && keep >= 1 ? keep : null;
}

/** Fails the batch unless retention still requires dropping this version (the setting may have changed meanwhile). */
const stillPastRetention = (env: AppEnv, versionId: string): D1PreparedStatement =>
  env.DB.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM settings s JOIN page_versions v ON v.id = ? JOIN pages p ON p.id = v.page_id
    WHERE s.key = 'retention' AND json_type(s.value_json) = 'integer' AND CAST(s.value_json AS INTEGER) >= 1
      AND v.n <= p.current_version - CAST(s.value_json AS INTEGER)
  ) THEN 1 ELSE json('kept') END`).bind(versionId);

/** Removes versions past the number kept. The current one always stays. Returns false if the setting changed meanwhile. */
export async function pruneVersions(env: AppEnv, pageId: string, currentVersion: number, keep: number, now = Date.now()): Promise<boolean> {
  if (currentVersion <= keep) return true;
  const { results } = await env.DB.prepare('SELECT id FROM page_versions WHERE page_id = ? AND n <= ? ORDER BY n LIMIT ?').bind(pageId, currentVersion - keep, VERSIONS).all<{ id: string }>();
  for (const { id } of results) {
    try {
      await env.DB.batch([stillPastRetention(env, id), ...dropVersion(env, id, now)]);
    } catch (error) {
      if (String(error).includes('malformed JSON')) return false;
      throw error;
    }
  }
  return true;
}

/** After the setting changed: every page once, some each hour. Pages published since are pruned at their publish. */
export async function prune(env: AppEnv, now = Date.now()): Promise<void> {
  const keep = await versionsKept(env), row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'retention_walk'").first<{ value_json: string }>();
  if (keep === null || !row) return;
  const from = JSON.parse(row.value_json) as string;
  const { results } = await env.DB.prepare('SELECT id, current_version FROM pages WHERE id > ? ORDER BY id LIMIT ?').bind(from, WALK).all<{ id: string; current_version: number }>();
  let last = from, whole = true;
  for (const page of results) {
    if (!(await pruneVersions(env, page.id, page.current_version, keep, now))) return;
    if (await env.DB.prepare('SELECT 1 FROM page_versions WHERE page_id = ? AND n <= ? LIMIT 1').bind(page.id, page.current_version - keep).first()) { whole = false; break; } // Its rest next hour.
    last = page.id;
  }
  // Only if the setting wasn't changed meanwhile, which starts over.
  if (whole && results.length < WALK) await env.DB.prepare("DELETE FROM settings WHERE key = 'retention_walk' AND value_json = ?").bind(row.value_json).run();
  else await env.DB.prepare("UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'retention_walk' AND value_json = ?").bind(JSON.stringify(last), now, row.value_json).run();
}

/** Once a week: objects that no row names, left by an upload that failed between the two. Some each hour, until all were looked at. */
export async function sweep(env: AppEnv, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare("SELECT value_json, updated_at FROM settings WHERE key = 'sweep'").first<{ value_json: string; updated_at: number }>();
  const cursor = row ? JSON.parse(row.value_json) as string | null : null;
  // A cursor is a sweep under way; none is the end of the last one.
  if (row && cursor === null && row.updated_at > now - 7 * DAY) return;
  const listed = await env.FILES.list({ prefix: 'blobs/', limit: SWEEP, ...(cursor !== null && { cursor }) });
  // A new object can still be waiting for its row.
  const old = listed.objects.filter((o) => o.uploaded.getTime() < now - DAY).map((o) => o.key);
  if (old.length > 0) {
    const { results } = await env.DB.prepare('SELECT b.r2_key FROM json_each(?) j CROSS JOIN blobs b ON b.r2_key = j.value').bind(JSON.stringify(old)).all<{ r2_key: string }>();
    const known = new Set(results.map((r) => r.r2_key)), gone = old.filter((key) => !known.has(key));
    if (gone.length > 0) await env.FILES.delete(gone);
  }
  await env.DB.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES('sweep', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
    .bind(JSON.stringify(listed.truncated ? listed.cursor : null), now).run();
}
