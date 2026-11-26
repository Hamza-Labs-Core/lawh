import type { AppEnv } from '../../shared/env';
import { invalid } from '../../shared/errors';
import { type Project, projectsById } from '../api/auth';
import type { PageRow } from '../api/pages';
import { oneOf } from '../api/body';
import { matchOf } from '../search';

/** Lists for agents and for people: the same rows, over the projects the caller may see. */

export async function tagsOf(env: AppEnv, pageIds: string[]): Promise<Map<string, string[]>> {
  const tags = new Map<string, string[]>(pageIds.map((id) => [id, []]));
  if (pageIds.length === 0) return tags;
  const { results } = await env.DB.prepare('SELECT page_id, tag FROM page_tags WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY page_id, tag')
    .bind(JSON.stringify(pageIds)).all<{ page_id: string; tag: string }>();
  for (const row of results) tags.get(row.page_id)?.push(row.tag);
  return tags;
}

// ---- Cursors: [updated_at, id] of the last row.
export const encodeCursor = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

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

function listIn(env: AppEnv, project: Project | null, status: string | null, tag: string | null, after: [number, string], limit: number): D1PreparedStatement {
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
  return env.DB.prepare(`SELECT p.* FROM ${from} WHERE ${where.join(' AND ')} AND p.deleted_at IS NULL ORDER BY ${order} LIMIT ?`).bind(...values, limit);
}

export const STATUSES = ['draft', 'in_review', 'decided', 'archived'] as const;

export interface PageList { items: { page: PageRow; project: Project; tags: string[] }[]; next: string | null }

/** Pages by project, status, tag and text (`q`), newest first. `projects` null means every project. */
export async function listPageRows(env: AppEnv, url: URL, projects: Project[] | null): Promise<PageList> {
  const query = url.searchParams, limit = pageLimit(url), status = query.get('status');
  if (status !== null) oneOf(status, 'status', STATUSES);
  const tag = query.get('tag')?.trim().normalize('NFC') ?? null;
  const q = query.get('q');
  if (q !== null) {
    if ([...q].length > 100) throw invalid('q must be text of at most 100 characters.');
    const before = readCursor(url, ['number'])?.[0] ?? null;
    const match = matchOf(q, { projects: projects && projects.map((p) => p.id), status, tag });
    const found = match === null ? [] : (await env.DB.prepare(`SELECT p.*, f.rowid fts_rowid FROM pages_fts f CROSS JOIN pages_fts_map m ON m.rowid = f.rowid CROSS JOIN pages p ON p.id = m.page_id AND p.deleted_at IS NULL
      WHERE pages_fts MATCH ?${before !== null ? ' AND f.rowid < ?' : ''} ORDER BY f.rowid DESC LIMIT ?`)
      .bind(match, ...(before !== null ? [before] : []), limit + 1).all<PageRow & { fts_rowid: number }>()).results;
    const more = found.length > limit, rows = found.slice(0, limit), last = rows.at(-1);
    return list(env, rows, projects, more && last ? encodeCursor([last.fts_rowid]) : null);
  }
  const after = (readCursor(url, ['number', 'string']) ?? [Number.MAX_SAFE_INTEGER, '']) as [number, string];
  const queries = (projects ?? [null]).map((project) => listIn(env, project, status, tag, after, limit + 1));
  let rows = queries.length === 0 ? [] : (await env.DB.batch<PageRow>(queries)).flatMap((r) => r.results);
  if (queries.length > 1) rows.sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
  const more = rows.length > limit;
  rows = rows.slice(0, limit);
  const last = rows.at(-1);
  return list(env, rows, projects, more && last ? encodeCursor([last.updated_at, last.id]) : null);
}

async function list(env: AppEnv, rows: PageRow[], projects: Project[] | null, next: string | null): Promise<PageList> {
  const byId = new Map((projects ?? await projectsById(env, rows.map((row) => row.project_id))).map((p) => [p.id, p]));
  const tags = await tagsOf(env, rows.map((row) => row.id));
  return {
    items: rows.map((page) => ({ page, project: byId.get(page.project_id)!, tags: tags.get(page.id) ?? [] })),
    next,
  };
}
