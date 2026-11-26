import { invalid } from '../../shared/errors';
import { pageLimit } from '../pages/list';
import { projectBySlug } from './auth';
import type { Context } from './router';

export const EVENT_TYPES = [
  'page.published', 'page.status',
  'decision.answered', 'decision.vote', 'decision.stale',
  'comment.created', 'comment.resolved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

interface EventRow {
  seq: number;
  type: EventType;
  page_id: string | null;
  subject_id: string;
  created_at: number;
  actor_type: 'person' | 'agent' | 'system';
  actor_id: string | null;
}

/** Ordered event feed for one project, filtered to the scopes the key holds. */
export async function listEvents(ctx: Context): Promise<Response> {
  const { env, url, caller } = ctx;
  const slug = url.searchParams.get('project');
  if (!slug) throw invalid('project is required.');
  const project = await projectBySlug(env, caller, slug);
  const afterRaw = url.searchParams.get('after');
  let after: number | null = null;
  if (afterRaw !== null) {
    if (!/^(?:0|[1-9]\d{0,15})$/.test(afterRaw)) throw invalid('after must be a non-negative integer.');
    after = Number(afterRaw);
    if (!Number.isSafeInteger(after)) throw invalid('after must be a non-negative integer.');
  }
  const limit = pageLimit(url);

  const allowed: EventType[] = [];
  if (caller.scopes.has('pages:read')) allowed.push('page.published', 'page.status');
  if (caller.scopes.has('decisions:read')) allowed.push('decision.answered', 'decision.vote', 'decision.stale');
  if (caller.scopes.has('comments:read')) allowed.push('comment.created', 'comment.resolved');

  const top = await env.DB.prepare('SELECT MAX(seq) AS max FROM events WHERE project_id = ?').bind(project.id).first<{ max: number | null }>();
  const newest = top?.max ?? 0;
  if (after === null || allowed.length === 0 || newest <= after) {
    return Response.json({ items: [], next: Math.max(after ?? 0, newest) });
  }
  const marks = allowed.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT seq, type, page_id, subject_id, created_at, actor_type, actor_id FROM events
     WHERE project_id = ? AND seq > ? AND seq <= ? AND type IN (${marks}) ORDER BY seq LIMIT ?`,
  ).bind(project.id, after, newest, ...allowed, limit).all<EventRow>();
  const next = results.length === limit ? results.at(-1)!.seq : newest;
  return Response.json({
    items: results.map((r) => ({
      seq: r.seq,
      type: r.type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      pageId: r.page_id,
      subjectId: r.subject_id,
      createdAt: r.created_at,
    })),
    next,
  });
}
