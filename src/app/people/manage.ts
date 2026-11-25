import { ApiError, conflict, notFound } from '../../shared/errors';
import { oneOf, onlyKeys, readJson } from '../api/body';
import { findPage, type PageRow } from '../api/pages';
import { PURGE_AFTER } from '../housekeeping';
import { STATUSES, encodeCursor, pageLimit, readCursor, tagsOf } from '../pages/list';
import { indexStatements, statusStatements, unindexStatements } from '../search';
import { entryTextOf } from '../search/entry';
import { levelOn, openProject, visibleProjects } from './access';
import type { SignedIn } from './router';
import { auditStatement } from './session';

/** What managers do with a page: its status, deleting it, and bringing it back. */

const MANAGER = 4;
const refuse = () => new ApiError('forbidden', 'Your level does not allow this.');

async function managed(ctx: SignedIn): Promise<PageRow> {
  const { project, level } = await openProject(ctx.env, ctx.person, ctx.params[0]!, 1), page = await findPage(ctx.env, project, ctx.params[1]!);
  if (level < MANAGER) throw refuse();
  return page;
}

export async function setStatus(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, page = await managed(ctx), { body } = await readJson(ctx.request);
  onlyKeys(body, ['status']);
  const status = oneOf(body.status, 'status', STATUSES), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE pages SET status = ?1, updated_at = MAX(updated_at + 1, ?2) WHERE id = ?3 AND status <> ?1 AND deleted_at IS NULL').bind(status, now, page.id),
    env.DB.prepare("INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id) SELECT ?, ?, 'page.status', ?, ?, 'person', ? WHERE changes() = 1")
      .bind(page.project_id, page.id, page.id, now, person.memberId),
    ...statusStatements(env, page.id),
  ]);
  return Response.json({ status });
}

/** Out of every list and the search at once; gone for good after 30 days. */
export async function deletePage(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, page = await managed(ctx);
  await env.DB.batch([
    env.DB.prepare('UPDATE pages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(Date.now(), page.id),
    ...unindexStatements(env, page.id),
    auditStatement(env, person.memberId, 'page.delete', page.id),
  ]);
  return new Response(null, { status: 204 });
}

/** Pages that can still be brought back, newest deletion first. */
export async function listDeleted(ctx: SignedIn): Promise<Response> {
  const { env, url, person } = ctx, limit = pageLimit(url), since = Date.now() - PURGE_AFTER;
  const from = (readCursor(url, ['number', 'string']) ?? [Number.MAX_SAFE_INTEGER, '']) as [number, string];
  const visible = await visibleProjects(env, person), byId = new Map(visible.map((p) => [p.id, p]));
  const query = (project: string | null) => env.DB.prepare(`SELECT * FROM pages WHERE ${project === null ? '' : 'project_id = ? AND '}deleted_at IS NOT NULL AND deleted_at >= ? AND (deleted_at, id) < (?, ?) ORDER BY deleted_at DESC, id DESC LIMIT ?`).bind(...(project === null ? [] : [project]), since, ...from, limit + 1);
  const queries = person.isOwner ? [query(null)] : visible.filter((p) => p.level >= MANAGER).map((p) => query(p.id));
  const found = queries.length === 0 ? [] : (await env.DB.batch<PageRow>(queries)).flatMap((r) => r.results);
  found.sort((a, b) => b.deleted_at! - a.deleted_at! || (a.id < b.id ? 1 : -1));
  const rows = found.slice(0, limit), last = rows.at(-1);
  return Response.json({
    items: rows.map((p) => ({ id: p.id, project: { slug: byId.get(p.project_id)!.slug, name: { en: byId.get(p.project_id)!.name_en, ar: byId.get(p.project_id)!.name_ar } }, slug: p.slug, title: p.title, lang: p.lang, deletedAt: p.deleted_at, purgedAfter: p.deleted_at! + PURGE_AFTER })),
    next: found.length > limit && last ? encodeCursor([last.deleted_at, last.id]) : null,
  });
}

export async function restorePage(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!;
  const page = await env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<PageRow>();
  const level = page ? await levelOn(env, person, page.project_id) : 0;
  if (!page || level < 1 || page.deleted_at === null) throw notFound();
  if (level < MANAGER) throw refuse();
  const now = Date.now();
  // The purge takes it from 30 days on, so from then it can't come back.
  if (page.deleted_at < now - PURGE_AFTER + 60_000) throw notFound();
  const tags = (await tagsOf(env, [page.id])).get(page.id) ?? [], text = await entryTextOf(env, page.id, page.current_version);
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE pages SET deleted_at = NULL, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND deleted_at = ?').bind(now, page.id, page.deleted_at),
      // Someone else restored it first.
      env.DB.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('restored') END"),
      ...indexStatements(env, page.id, { title: page.title, summary: page.summary, tags }, text),
      auditStatement(env, person.memberId, 'page.restore', page.id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw conflict('It was restored meanwhile.');
    throw error;
  }
  const project = await env.DB.prepare('SELECT slug FROM projects WHERE id = ?').bind(page.project_id).first<{ slug: string }>();
  return Response.json({ project: project!.slug, slug: page.slug });
}
