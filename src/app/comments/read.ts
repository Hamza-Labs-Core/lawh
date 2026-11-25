import type { AppEnv } from '../../shared/env';

/** Comments as agents and people read them. */

export interface CommentRow {
  id: string; page_id: string; project_id: string; thread_id: string; version_n: number; section_id: string | null; section_title: string | null; quote: string | null;
  member_id: string | null; member_name: string | null; author_level: number | null; agent: string | null; body: string; created_at: number; resolved_at: number | null;
}

export const DECIDER = 3;
export const COMMENT = `SELECT c.id, c.page_id, c.project_id, c.thread_id, c.version_n, c.section_id, c.section_title, c.quote, c.member_id, m.name member_name, c.author_level, a.name agent, c.body, c.created_at, c.resolved_at
  FROM comments c LEFT JOIN members m ON m.id = c.member_id LEFT JOIN agents a ON a.id = c.agent_id`;

export const commentJson = (c: CommentRow) => ({
  id: c.id, threadId: c.thread_id, authorType: c.member_id === null ? 'agent' as const : 'person' as const, person: c.member_id === null ? null : { id: c.member_id, name: c.member_name },
  // Who could decide here when they wrote it.
  fromDecider: c.author_level !== null && c.author_level >= DECIDER, agent: c.agent, versionN: c.version_n, sectionId: c.section_id, sectionTitle: c.section_title, quote: c.quote, body: c.body,
  createdAt: c.created_at, resolvedAt: c.resolved_at,
});

/** A comment that isn't deleted, on a page that isn't. */
export async function findComment(env: AppEnv, id: string): Promise<CommentRow | null> {
  return env.DB.prepare(`${COMMENT} CROSS JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL WHERE c.id = ? AND c.deleted_at IS NULL`).bind(id).first<CommentRow>();
}

export interface Thread { first: CommentRow; replies: CommentRow[]; more: boolean }
const REPLIES = 50;
type Place = [createdAt: number, id: string];

/** Newest first. */
const repliesStatement = (env: AppEnv, threadId: string, before: Place): D1PreparedStatement =>
  env.DB.prepare(`${COMMENT} WHERE c.thread_id = ? AND c.id <> c.thread_id AND c.deleted_at IS NULL AND (c.created_at, c.id) < (?, ?) ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
    .bind(threadId, ...before, REPLIES + 1);

/** A thread's replies before a place: the last 50 of them, in the order they were written. */
export async function repliesBefore(env: AppEnv, threadId: string, before: Place): Promise<{ replies: CommentRow[]; more: boolean }> {
  const { results } = await repliesStatement(env, threadId, before).all<CommentRow>();
  return { replies: results.slice(0, REPLIES).reverse(), more: results.length > REPLIES };
}

/** The threads, in the order of `ids`, each with its newest 50 replies. */
export async function readThreads(env: AppEnv, ids: string[]): Promise<Thread[]> {
  if (ids.length === 0) return [];
  const [first, ...replies] = await env.DB.batch<CommentRow>([
    env.DB.prepare(`${COMMENT.replace('FROM comments c', 'FROM json_each(?) j CROSS JOIN comments c ON c.id = j.value')} WHERE c.deleted_at IS NULL`).bind(JSON.stringify(ids)),
    ...ids.map((id) => repliesStatement(env, id, [Number.MAX_SAFE_INTEGER, ''])),
  ]);
  const found = new Map(first!.results.map((row) => [row.id, row]));
  return ids.flatMap((id, i) => {
    const row = found.get(id), rows = replies[i]!.results;
    return row ? [{ first: row, replies: rows.slice(0, REPLIES).reverse(), more: rows.length > REPLIES }] : [];
  });
}

/** Newest first. A project of null means every project. */
export function openThreadsStatement(env: AppEnv, project: string | null, before: Place, limit: number): D1PreparedStatement {
  return env.DB.prepare(`SELECT c.id, c.created_at FROM comments c CROSS JOIN pages p ON p.id = c.page_id AND p.deleted_at IS NULL
    WHERE ${project === null ? '' : 'c.project_id = ? AND '}c.resolved_at IS NULL AND c.deleted_at IS NULL AND c.id = c.thread_id AND (c.created_at, c.id) < (?, ?) ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
    .bind(...(project === null ? [] : [project]), ...before, limit);
}
