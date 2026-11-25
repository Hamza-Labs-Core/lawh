import type { AppEnv } from '../../shared/env';
import { conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { type Project, projectBySlug, projectJson, usableProjects } from './auth';
import { onlyKeys, oneOf, readJson, text } from './body';
import { idempotent, replay, writeOnce } from './idempotency';
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

async function tagsOf(env: AppEnv, pageIds: string[]): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>(pageIds.map((id) => [id, []]));
  if (pageIds.length === 0) return tags;
  const { results } = await env.DB.prepare('SELECT page_id, tag FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY page_id, tag')
    .bind(JSON.stringify(pageIds)).all<{ page_id: string; tag: string }>();
  for (const row of results) tags.get(row.page_id)?.push(row.tag);
  return tags;
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

// ---- Cursors: [updated_at, id] of the last row.
const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export function pageLimit(url: URL): number {
  const raw = url.searchParams.get('limit') ?? '30';
  const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > 100) throw invalid('limit must be from 1 to 100.');
  return limit;
}

export function readCursor(url: URL, kinds: readonly ('number' | 'string')[]): (number | string)[] | null {
  const raw = url.searchParams.get('cursor');
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(atob(raw.replaceAll('-', '+').replaceAll('_', '/')));
    if (Array.isArray(value) && value.length === kinds.length && kinds.every((kind, i) => typeof value[i] === kind)) return value as (number | string)[];
  } catch { /* below */ }
  throw invalid('The cursor is not valid.');
}

async function listIn(env: AppEnv, project: Project | null, status: string | null, tag: string | null, after: [number, string], limit: number): Promise<PageRow[]> {
  const where: string[] = [], values: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => { where.push(sql); values.push(...v); };
  let from: string, order: string;
  if (tag === null) {
    from = 'pages p'; order = 'p.updated_at DESC, p.id DESC';
    if (project) add('p.project_id = ?', project.id);
    if (status) add('p.status = ?', status);
    add('(p.updated_at, p.id) < (?, ?)', ...after);
  } else {
    from = 'page_tags t CROSS JOIN pages p ON p.id = t.page_id'; order = 't.sort_at DESC, t.page_id DESC';
    if (project) add('t.project_id = ?', project.id);
    add('t.tag = ?', tag);
    add('(t.sort_at, t.page_id) < (?, ?)', ...after);
    if (status) add('p.status = ?', status);
  }
  const { results } = await env.DB.prepare(`SELECT p.* FROM ${from} WHERE ${where.join(' AND ')} AND p.deleted_at IS NULL ORDER BY ${order} LIMIT ?`)
    .bind(...values, limit).all<PageRow>();
  return results;
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
  const { env, url, caller } = ctx, query = url.searchParams;
  if (query.has('q')) throw invalid('Search is not available yet.');
  const limit = pageLimit(url);
  const status = query.get('status');
  if (status !== null) oneOf(status, 'status', ['draft', 'in_review', 'decided', 'archived'] as const);
  const tag = query.get('tag');
  const cursor = readCursor(url, ['number', 'string']);
  const after = (cursor ?? [Number.MAX_SAFE_INTEGER, '']) as [number, string];
  const slug = query.get('project');

  let projects: Project[], rows: PageRow[];
  if (slug !== null) {
    projects = [await projectBySlug(env, caller, slug)];
    rows = await listIn(env, projects[0]!, status, tag, after, limit + 1);
  } else {
    projects = await usableProjects(env, caller);
    rows = caller.allProjects
      ? await listIn(env, null, status, tag, after, limit + 1)
      : (await Promise.all(projects.map((p) => listIn(env, p, status, tag, after, limit + 1)))).flat()
        .sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
  }
  const more = rows.length > limit;
  rows = rows.slice(0, limit);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const tags = await tagsOf(env, rows.map((row) => row.id));
  const last = rows.at(-1);
  return Response.json({
    items: rows.flatMap((row) => { const p = byId.get(row.project_id); return p ? [pageJson(ctx, p, row, tags.get(row.id) ?? [])] : []; }),
    next: more && last ? encode([last.updated_at, last.id]) : null,
  });
}

export async function getPage(ctx: Context): Promise<Response> {
  const project = await projectBySlug(ctx.env, ctx.caller, ctx.params[0]!);
  const page = await findPage(ctx.env, project, ctx.params[1]!);
  const etag = `"${page.current_version}-${page.updated_at}"`;
  if (ctx.request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
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
    env.DB.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('page changed') END"),
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

interface VersionRow { id: string; n: number; note: string; bytes: number; file_count: number; agent: string; created_at: number }
const versionJson = (v: VersionRow) => ({ n: v.n, note: v.note, bytes: v.bytes, fileCount: v.file_count, publishedBy: v.agent, createdAt: v.created_at });
const VERSION = 'SELECT v.id, v.n, v.note, v.bytes, v.file_count, a.name agent, v.created_at FROM page_versions v JOIN agents a ON a.id = v.published_by';

export async function listVersions(ctx: Context): Promise<Response> {
  const project = await projectBySlug(ctx.env, ctx.caller, ctx.params[0]!);
  const page = await findPage(ctx.env, project, ctx.params[1]!);
  const limit = pageLimit(ctx.url);
  const before = readCursor(ctx.url, ['number'])?.[0] ?? Number.MAX_SAFE_INTEGER;
  const { results } = await ctx.env.DB.prepare(`${VERSION} WHERE v.page_id = ? AND v.n < ? ORDER BY v.n DESC LIMIT ?`).bind(page.id, before, limit + 1).all<VersionRow>();
  const items = results.slice(0, limit);
  return Response.json({ items: items.map(versionJson), next: results.length > limit ? encode([items.at(-1)!.n]) : null });
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
