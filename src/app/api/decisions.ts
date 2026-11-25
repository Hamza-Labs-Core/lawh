import { notFound } from '../../shared/errors';
import { decisionJson, listStatement, readDecisions } from '../decisions/read';
import { encodeCursor, pageLimit, readCursor } from '../pages/list';
import { projectById, projectBySlug, usableProjects } from './auth';
import { oneOf } from './body';
import type { Context } from './router';

const STATUSES = ['open', 'answered', 'stale', 'withdrawn'] as const;

/** By page, in the order of their keys; otherwise by the time of their last change, oldest first. */
export async function listDecisions(ctx: Context): Promise<Response> {
  const { env, url, caller } = ctx, query = url.searchParams, limit = pageLimit(url);
  const status = query.get('status') === null ? null : oneOf(query.get('status'), 'status', STATUSES), slug = query.get('project'), pageId = query.get('page');
  const project = slug === null ? null : await projectBySlug(env, caller, slug);
  if (pageId !== null) {
    const page = await env.DB.prepare('SELECT project_id, deleted_at FROM pages WHERE id = ?').bind(pageId).first<{ project_id: string; deleted_at: number | null }>();
    if (!page || page.deleted_at !== null || (project && project.id !== page.project_id)) throw notFound();
    await projectById(env, caller, page.project_id);
    const after = readCursor(url, ['string'])?.[0] ?? '';
    const { results } = await env.DB.prepare(`SELECT id, key FROM decisions WHERE page_id = ? AND key > ?${status === null ? '' : ' AND status = ?'} ORDER BY key LIMIT ?`)
      .bind(pageId, after, ...(status === null ? [] : [status]), limit + 1).all<{ id: string; key: string }>();
    const rows = results.slice(0, limit);
    return Response.json({ items: (await readDecisions(env, rows.map((r) => r.id))).map(decisionJson), next: results.length > limit ? encodeCursor([rows.at(-1)!.key]) : null });
  }
  const after = (readCursor(url, ['number', 'string']) ?? [0, '']) as [number, string];
  const projects = project ? [project.id] : caller.allProjects ? [null] : (await usableProjects(env, caller)).map((p) => p.id);
  const found = projects.length === 0 ? [] : (await env.DB.batch<{ id: string; updated_at: number }>(projects.map((p) => listStatement(env, p, status, after, limit + 1)))).flatMap((r) => r.results);
  found.sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : 1));
  const rows = found.slice(0, limit), last = rows.at(-1);
  return Response.json({ items: (await readDecisions(env, rows.map((r) => r.id))).map(decisionJson), next: found.length > limit && last ? encodeCursor([last.updated_at, last.id]) : null });
}

export async function getDecision(ctx: Context): Promise<Response> {
  const [decision] = await readDecisions(ctx.env, [ctx.params[0]!], true);
  if (!decision) throw notFound();
  await projectById(ctx.env, ctx.caller, decision.row.project_id);
  return Response.json(decisionJson(decision));
}
