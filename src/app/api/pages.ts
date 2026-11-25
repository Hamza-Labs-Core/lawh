import type { AppEnv } from '../../shared/env';
import { conflict, invalid, notFound } from '../../shared/errors';
import { matchesEtag } from '../../shared/etag';
import { newId } from '../../shared/ids';
import { encodeCursor, listPageRows, pageLimit, readCursor, tagsOf } from '../pages/list';
import { type Project, projectBySlug, projectJson, usableProjects } from './auth';
import { onlyKeys, oneOf, readJson, text } from './body';
import { idempotent, mustChange, replay, writeOnce } from './idempotency';
import type { Context } from './router';

export interface PageRow {
  id: string; project_id: string; slug: string; title: string; summary: string; lang: string; status: string;
  current_version: number; created_at: number; updated_at: number; deleted_at: number | null;
}

export interface Meta { title?: string; summary?: string; lang?: 'en' | 'ar'; tags?: string[]; status?: 'draft' | 'in_review' | 'archived' }

export function readMeta(body: Record<string, unknown>): Meta {
  onlyKeys(body, ['title', 'summary', 'lang', 'tags', 'status']);
  const meta: Meta = {};
  if (body.title !== undefined) meta.title = text(body.title, 'title', { min: 1, max: 200 });
  if (body.summary !== undefined) meta.summary = text(body.summary, 'summary', { max: 1000 });
  if (body.lang !== undefined) meta.lang = oneOf(body.lang, 'lang', ['en', 'ar'] as const);
  if (body.status !== undefined) meta.status = oneOf(body.status, 'status', ['draft', 'in_review', 'archived'] as const);
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 20) throw invalid('tags must be a list of at most 20.');
    meta.tags = [...new Set(body.tags.map((tag) => text(tag, 'A tag', { min: 1, max: 40 }).trim().normalize('NFC')))];
  }
  return meta;
}

export const pageUrl = (ctx: Context, project: Project, slug: string): string => `${ctx.url.origin}/p/${project.slug}/${slug}`;

export const pageJson = (ctx: Context, project: Project, page: PageRow, tags: string[]) => ({
  id: page.id, project: project.slug, slug: page.slug, url: pageUrl(ctx, project, page.slug), title: page.title, summary: page.summary,
  lang: page.lang, tags, status: page.status, currentVersion: page.current_version, createdAt: page.created_at, updatedAt: page.updated_at,
});

/** A page by its address. A deleted page is not found. */
export async function findPage(env: AppEnv, project: Project, slug: string): Promise<PageRow> {
  const page = await env.DB.prepare('SELECT * FROM pages WHERE project_id = ? AND slug = ?').bind(project.id, slug).first<PageRow>();
  if (!page || page.deleted_at !== null) throw notFound();
  return page;
}

export async function filesOf(env: AppEnv, pageId: string, n: number) {
  const { results } = await env.DB.prepare(
    'SELECT f.path, f.sha256, f.bytes FROM page_versions v JOIN version_files f ON f.version_id = v.id WHERE v.page_id = ? AND v.n = ? ORDER BY f.path')
    .bind(pageId, n).all<{ path: string; sha256: string; bytes: number }>();
  return results;
}

export function tagStatements(env: AppEnv, pageId: string, projectId: string, tags: string[], at: number): D1PreparedStatement[] {
  return [
    env.DB.prepare('DELETE FROM page_tags WHERE page_id = ?').bind(pageId),
    env.DB.prepare('INSERT INTO page_tags(page_id, tag, project_id, sort_at) SELECT ?, value, ?, ? FROM json_each(?)').bind(pageId, projectId, at, JSON.stringify(tags)),
  ];
}

export function eventStatement(env: AppEnv, projectId: string, pageId: string, type: string, subjectId: string, agentId: string, at: number): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id) VALUES(?,?,?,?,?,'agent',?)")
    .bind(projectId, pageId, type, subjectId, at, agentId);
}

export async function listProjects(ctx: Context): Promise<Response> {
  const projects = await usableProjects(ctx.env, ctx.caller);
  return Response.json({ items: projects.map(projectJson) });
}

export async function me(ctx: Context): Promise<Response> {
  const { caller } = ctx;
  return Response.json({
    agentId: caller.agentId, name: caller.agentName, scopes: [...caller.scopes], allProjects: caller.allProjects,
    projects: (await usableProjects(ctx.env, caller)).map(projectJson), expiresAt: caller.expiresAt,
  });
}

export async function listPages(ctx: Context): Promise<Response> {
  const { env, url, caller } = ctx;
  if (url.searchParams.has('q')) throw invalid('Search is not available yet.');
  const slug = url.searchParams.get('project');
  const projects = slug !== null ? [await projectBySlug(env, caller, slug)] : caller.allProjects ? null : await usableProjects(env, caller);
  const { items, next } = await listPageRows(env, url, projects);
  return Response.json({ items: items.map(({ page, project, tags }) => pageJson(ctx, project, page, tags)), next });
}

export async function getPage(ctx: Context): Promise<Response> {
  const project = await projectBySlug(ctx.env, ctx.caller, ctx.params[0]!);
  const page = await findPage(ctx.env, project, ctx.params[1]!);
  const etag = `"${page.current_version}-${page.updated_at}"`;
  if (matchesEtag(ctx.request.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
  const [tags, files] = await Promise.all([tagsOf(ctx.env, [page.id]), filesOf(ctx.env, page.id, page.current_version)]);
  return Response.json({ ...pageJson(ctx, project, page, tags.get(page.id) ?? []), files }, { headers: { ETag: etag } });
}

export async function updatePage(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  const project = await projectBySlug(env, caller, ctx.params[0]!);
  const { body, text: raw } = await readJson(ctx.request);
  const idem = await idempotent(ctx.request, raw);
  const earlier = await replay(env, caller, idem);
  if (earlier) return Response.json(earlier.json, { status: earlier.status });
  const meta = readMeta(body);
  if (Object.keys(meta).length === 0) throw invalid('Nothing to change.');
  const page = await findPage(env, project, ctx.params[1]!);
  const tags = meta.tags ?? (await tagsOf(env, [page.id])).get(page.id) ?? [];
  const now = Math.max(Date.now(), page.updated_at + 1);
  const changed: PageRow = {
    ...page, title: meta.title ?? page.title, summary: meta.summary ?? page.summary, lang: meta.lang ?? page.lang,
    status: meta.status ?? page.status, updated_at: now,
  };
  const statements = [
    // Nothing matches when someone else changed or deleted the page meanwhile; the next statement then fails the batch.
    env.DB.prepare('UPDATE pages SET title=?, summary=?, lang=?, status=?, updated_at=? WHERE id=? AND updated_at=? AND deleted_at IS NULL')
      .bind(changed.title, changed.summary, changed.lang, changed.status, now, page.id, page.updated_at),
    mustChange(env),
    ...(meta.tags ? tagStatements(env, page.id, project.id, tags, now) : []),
    ...(changed.status !== page.status ? [eventStatement(env, project.id, page.id, 'page.status', page.id, caller.agentId, now)] : []),
  ];
  try {
    const stored = await writeOnce(env, caller, idem, { status: 200, json: pageJson(ctx, project, changed, [...tags].sort()) }, statements);
    return Response.json(stored.json, { status: stored.status });
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw conflict('The page changed meanwhile. Read it again.');
    throw error;
  }
}

export interface VersionRow { id: string; n: number; note: string; bytes: number; file_count: number; agent: string; created_at: number }
export const versionJson = (v: VersionRow) => ({ n: v.n, note: v.note, bytes: v.bytes, fileCount: v.file_count, publishedBy: v.agent, createdAt: v.created_at });
export const VERSION = 'SELECT v.id, v.n, v.note, v.bytes, v.file_count, a.name agent, v.created_at FROM page_versions v JOIN agents a ON a.id = v.published_by';

export async function versionList(env: AppEnv, url: URL, page: PageRow): Promise<{ items: ReturnType<typeof versionJson>[]; next: string | null }> {
  const limit = pageLimit(url), before = readCursor(url, ['number'])?.[0] ?? Number.MAX_SAFE_INTEGER;
  const { results } = await env.DB.prepare(`${VERSION} WHERE v.page_id = ? AND v.n < ? ORDER BY v.n DESC LIMIT ?`).bind(page.id, before, limit + 1).all<VersionRow>();
  const items = results.slice(0, limit);
  return { items: items.map(versionJson), next: results.length > limit ? encodeCursor([items.at(-1)!.n]) : null };
}

export async function listVersions(ctx: Context): Promise<Response> {
  const project = await projectBySlug(ctx.env, ctx.caller, ctx.params[0]!);
  return Response.json(await versionList(ctx.env, ctx.url, await findPage(ctx.env, project, ctx.params[1]!)));
}

async function findVersion(ctx: Context): Promise<{ page: PageRow; version: VersionRow }> {
  const project = await projectBySlug(ctx.env, ctx.caller, ctx.params[0]!);
  const page = await findPage(ctx.env, project, ctx.params[1]!);
  const version = await ctx.env.DB.prepare(`${VERSION} WHERE v.page_id = ? AND v.n = ?`).bind(page.id, Number(ctx.params[2])).first<VersionRow>();
  if (!version) throw notFound();
  return { page, version };
}

export async function getVersion(ctx: Context): Promise<Response> {
  const { page, version } = await findVersion(ctx);
  return Response.json({ ...versionJson(version), files: await filesOf(ctx.env, page.id, version.n) });
}

/** Always an attachment with a closed sandbox: a page's file never runs on the app host. */
export async function readFile(ctx: Context): Promise<Response> {
  const { version } = await findVersion(ctx);
  const path = ctx.url.searchParams.get('path') ?? '';
  const file = await ctx.env.DB.prepare('SELECT b.r2_key FROM version_files f JOIN blobs b ON b.sha256 = f.sha256 WHERE f.version_id = ? AND f.path = ?')
    .bind(version.id, path).first<{ r2_key: string }>();
  if (!file) throw notFound();
  const object = await ctx.env.FILES.get(file.r2_key);
  if (!object) throw new Error('R2 object missing');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1)!).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    },
  });
}

export const newPageId = (now: number): string => newId('pag', now);
