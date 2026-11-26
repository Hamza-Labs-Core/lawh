import { conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { COMMENT, type CommentRow, commentJson, findComment } from '../comments/read';
import { encodeCursor, pageLimit, readCursor } from '../pages/list';
import { projectById, projectBySlug } from './auth';
import { onlyKeys, readJson, text } from './body';
import { idempotent, mustChange, replay, writeOnce } from './idempotency';
import { eventStatement } from './pages';
import type { Context } from './router';

export const MAX_BODY = 10_000;

/** First comment of each open thread in a project, oldest first. */
export async function listProjectThreads(ctx: Context): Promise<Response> {
  const { env, url } = ctx, slug = url.searchParams.get('project');
  if (!slug) throw invalid('project is required.');
  const project = await projectBySlug(env, ctx.caller, slug), limit = pageLimit(url);
  const after = (readCursor(url, ['number', 'string']) ?? [0, '']) as [number, string];
  const { results } = await env.DB.prepare(`${COMMENT} CROSS JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
    WHERE c.project_id = ? AND c.resolved_at IS NULL AND c.deleted_at IS NULL AND c.id = c.thread_id AND (c.created_at, c.id) > (?, ?)
    ORDER BY c.created_at, c.id LIMIT ?`).bind(project.id, ...after, limit + 1).all<CommentRow>();
  const rows = results.slice(0, limit), last = rows.at(-1);
  return Response.json({ items: rows.map(commentJson), next: results.length > limit && last ? encodeCursor([last.created_at, last.id]) : null });
}

/** In the order they were written. */
export async function listComments(ctx: Context): Promise<Response> {
  const { env, url } = ctx, limit = pageLimit(url), pageId = ctx.params[0]!;
  const page = await env.DB.prepare('SELECT project_id, deleted_at FROM pages WHERE id = ?').bind(pageId).first<{ project_id: string; deleted_at: number | null }>();
  if (!page || page.deleted_at !== null) throw notFound();
  await projectById(env, ctx.caller, page.project_id);
  const after = (readCursor(url, ['number', 'string']) ?? [0, '']) as [number, string];
  const { results } = await env.DB.prepare(`${COMMENT} WHERE c.page_id = ? AND c.deleted_at IS NULL AND (c.created_at, c.id) > (?, ?) ORDER BY c.created_at, c.id LIMIT ?`)
    .bind(pageId, ...after, limit + 1).all<CommentRow>();
  const rows = results.slice(0, limit), last = rows.at(-1);
  return Response.json({ items: rows.map(commentJson), next: results.length > limit && last ? encodeCursor([last.created_at, last.id]) : null });
}

/** Agents reply; only people start threads. */
export async function replyAsAgent(ctx: Context): Promise<Response> {
  const { env, caller } = ctx;
  const thread = await findComment(env, ctx.params[0]!);
  if (!thread || thread.thread_id !== thread.id) throw notFound();
  await projectById(env, caller, thread.project_id);
  const { body, text: raw } = await readJson(ctx.request);
  const idem = await idempotent(ctx.request, raw);
  const earlier = await replay(env, caller, idem);
  if (earlier) return Response.json(earlier.json, { status: earlier.status });
  onlyKeys(body, ['body']);
  const page = await env.DB.prepare('SELECT current_version FROM pages WHERE id = ?').bind(thread.page_id).first<{ current_version: number }>();
  const at = Date.now(), now = Math.max(at, thread.created_at + 1);
  const row: CommentRow = {
    id: newId('cmt', now), page_id: thread.page_id, project_id: thread.project_id, thread_id: thread.id, version_n: page!.current_version, section_id: null, section_title: null, quote: null,
    member_id: null, member_name: null, author_level: null, agent: caller.agentName, body: text(body.body, 'body', { min: 1, max: MAX_BODY }), created_at: now, resolved_at: null,
  };
  try {
    const stored = await writeOnce(env, caller, idem, { status: 201, json: commentJson(row) }, [
      // Recheck key (including live expiry), agent, member and project access inside the write transaction.
      env.DB.prepare(`INSERT INTO comments(id, page_id, project_id, thread_id, version_n, agent_id, body, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        FROM agent_keys k JOIN agents a ON a.id = k.agent_id JOIN members m ON m.id = a.member_id
        WHERE k.id = ?9 AND k.revoked_at IS NULL AND k.expires_at > MAX(?10, CAST(unixepoch('subsec') * 1000 AS INTEGER)) AND a.disabled_at IS NULL AND m.removed_at IS NULL
          AND ((m.role = 'owner' AND (k.all_projects = 1 OR EXISTS (SELECT 1 FROM agent_key_projects kp WHERE kp.key_id = k.id AND kp.project_id = ?3)))
            OR (EXISTS (SELECT 1 FROM agent_key_projects kp WHERE kp.key_id = k.id AND kp.project_id = ?3)
              AND EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = m.id AND x.project_id = ?3 AND x.level = 4)))`)
        .bind(row.id, row.page_id, row.project_id, row.thread_id, row.version_n, caller.agentId, row.body, now, caller.keyId, at),
      mustChange(env),
      eventStatement(env, row.project_id, row.page_id, 'comment.created', row.id, caller.agentId, now),
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM agent_keys WHERE id = ? AND revoked_at IS NULL AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)) THEN 1 ELSE json('expired') END")
        .bind(caller.keyId),
    ]);
    return Response.json(stored.json, { status: stored.status });
  } catch (error) {
    const text = String(error);
    if (text.includes('comment conflict')) throw conflict('The thread was deleted meanwhile.');
    if (text.includes('malformed JSON')) throw notFound();
    throw error;
  }
}
