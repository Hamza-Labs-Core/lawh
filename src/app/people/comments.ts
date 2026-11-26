import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { MAX_BODY } from '../api/comments';
import { integer, isObject, onlyKeys, readJson, text } from '../api/body';
import { findPage } from '../api/pages';
import { type CommentRow, commentJson, DECIDER, findComment, openThreadsStatement, readThreads, repliesBefore, type Thread } from '../comments/read';
import { encodeCursor, pageLimit, readCursor } from '../pages/list';
import { levelOn, openProject, visibleProjects } from './access';
import { dispatchOutbox } from '../webhooks/deliver';
import { notifyLive } from '../api/live';
import type { SignedIn } from './router';

const COMMENTER = 2, MANAGER = 4;
const ID = /^cmt_[0-9A-Z]{26}$/;
const before = (url: URL): [number, string] => (readCursor(url, ['number', 'string']) ?? [Number.MAX_SAFE_INTEGER, '']) as [number, string];

const mine = (c: CommentRow, ctx: SignedIn): boolean => c.member_id === ctx.person.memberId;
const seen = (c: CommentRow, level: number, ctx: SignedIn) => ({ ...commentJson(c), mayDelete: level >= MANAGER || (level >= COMMENTER && mine(c, ctx)) });
const mayResolve = (first: CommentRow, level: number, ctx: SignedIn): boolean => level >= DECIDER || (level >= COMMENTER && mine(first, ctx));
const threadJson = ({ first, replies, more }: Thread, level: number, ctx: SignedIn) => ({
  ...seen(first, level, ctx), replies: replies.map((c) => seen(c, level, ctx)), moreReplies: more && replies[0] ? encodeCursor([replies[0].created_at, replies[0].id]) : null,
  mayReply: level >= COMMENTER, mayResolve: mayResolve(first, level, ctx),
});

/** A page's threads, newest first. */
export async function listThreads(ctx: SignedIn): Promise<Response> {
  const { env, url } = ctx, limit = pageLimit(url), { project, level } = await openProject(env, ctx.person, ctx.params[0]!, 1), page = await findPage(env, project, ctx.params[1]!);
  const { results } = await env.DB.prepare('SELECT id, created_at FROM comments WHERE page_id = ? AND id = thread_id AND deleted_at IS NULL AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(page.id, ...before(url), limit + 1).all<{ id: string; created_at: number }>();
  const rows = results.slice(0, limit), last = rows.at(-1);
  return Response.json({
    items: (await readThreads(env, rows.map((r) => r.id))).map((t) => threadJson(t, level, ctx)), next: results.length > limit && last ? encodeCursor([last.created_at, last.id]) : null, mayComment: level >= COMMENTER,
  });
}

/** Open threads over all the person's projects, newest first, each with its page. */
export async function listMyThreads(ctx: SignedIn): Promise<Response> {
  const { env, url } = ctx, limit = pageLimit(url), from = before(url);
  const visible = await visibleProjects(env, ctx.person), projects = ctx.person.isOwner ? [null] : visible.map((p) => p.id);
  const found = projects.length === 0 ? [] : (await env.DB.batch<{ id: string; created_at: number }>(projects.map((p) => openThreadsStatement(env, p, from, limit + 1)))).flatMap((r) => r.results);
  found.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  const rows = found.slice(0, limit), last = rows.at(-1), threads = await readThreads(env, rows.map((r) => r.id));
  const { results } = threads.length === 0 ? { results: [] } : await env.DB.prepare('SELECT id, slug, title, lang FROM pages WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([...new Set(threads.map((t) => t.first.page_id))]))
    .all<{ id: string; slug: string; title: string; lang: string }>();
  const pages = new Map(results.map((p) => [p.id, p])), byId = new Map(visible.map((p) => [p.id, p]));
  return Response.json({
    items: threads.flatMap((t) => {
      const page = pages.get(t.first.page_id), project = byId.get(t.first.project_id);
      return page && project ? [{ ...threadJson(t, project.level, ctx), project: project.slug, projectName: { en: project.name_en, ar: project.name_ar }, page: { slug: page.slug, title: page.title, lang: page.lang } }] : [];
    }),
    next: found.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
  });
}

/** The comment and the person's level on its project: 404 for who can't see it, 403 for who may not do this. */
async function find(ctx: SignedIn, least: number): Promise<{ comment: CommentRow; level: number }> {
  const comment = await findComment(ctx.env, ctx.params[0]!), level = comment ? await levelOn(ctx.env, ctx.person, comment.project_id) : 0;
  if (!comment || level < 1) throw notFound();
  if (level < least) throw new ApiError('forbidden', 'Your level does not allow this.');
  return { comment, level };
}
const isThread = (c: CommentRow): boolean => c.id === c.thread_id;

export async function listReplies(ctx: SignedIn): Promise<Response> {
  const { comment, level } = await find(ctx, 1);
  if (!isThread(comment)) throw notFound();
  const { replies, more } = await repliesBefore(ctx.env, comment.id, before(ctx.url));
  return Response.json({ items: replies.map((c) => seen(c, level, ctx)), next: more && replies[0] ? encodeCursor([replies[0].created_at, replies[0].id]) : null });
}

interface New { id: string; pageId: string; projectId: string; threadId: string; versionN: number; section: { id: string; title: string; quote: string } | null; body: string; at: number }

/** The browser makes the id, so a comment that is sent again after a lost reply is written once. */
async function write(ctx: SignedIn, comment: New): Promise<void> {
  const { env, person } = ctx;
  try {
    await env.DB.batch([
      // The level is read in the same statement; the triggers compare it, and refuse one who may not write.
      env.DB.prepare(`INSERT INTO comments(id, page_id, project_id, thread_id, version_n, section_id, section_title, quote, member_id, author_level, body, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CASE WHEN EXISTS (SELECT 1 FROM members o WHERE o.id = ?9 AND o.role = 'owner') THEN 5
          ELSE (SELECT MAX(x.level) FROM project_access x WHERE x.member_id = ?9 AND x.project_id = ?3) END, ?10, ?11`)
        .bind(comment.id, comment.pageId, comment.projectId, comment.threadId, comment.versionN, comment.section?.id ?? null, comment.section?.title ?? null, comment.section?.quote ?? null, person.memberId, comment.body, comment.at),
      env.DB.prepare("INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id) VALUES(?,?,'comment.created',?,?,'person',?)")
        .bind(comment.projectId, comment.pageId, comment.id, comment.at, person.memberId),
    ]);
    ctx.ctx.waitUntil(dispatchOutbox(env).catch(() => undefined));
    ctx.ctx.waitUntil(notifyLive(env, comment.projectId).catch(() => undefined));
  } catch (error) {
    const text = String(error);
    if (text.includes('UNIQUE constraint failed: comments.id')) {
      const same = await findComment(env, comment.id);
      // Replies only send id and body; new threads also pin versionN and section.
      const sameAnchor = comment.id !== comment.threadId || (same?.version_n === comment.versionN && same.section_id === (comment.section?.id ?? null) && same.section_title === (comment.section?.title ?? null) && same.quote === (comment.section?.quote ?? null));
      if (same && mine(same, ctx) && same.thread_id === comment.threadId && same.page_id === comment.pageId && same.body === comment.body && sameAnchor) return;
      throw conflict('That id is taken.');
    }
    if (text.includes('comment conflict')) throw conflict('The page or the thread was deleted meanwhile.');
    if (/comment not allowed|CHECK constraint failed/.test(text)) throw new ApiError('forbidden', 'Your level does not allow this.');
    throw error;
  }
}

function readNew(body: Record<string, unknown>): { id: string; text: string } {
  if (typeof body.id !== 'string' || !ID.test(body.id)) throw invalid('id must be a comment id.');
  return { id: body.id, text: text(body.body, 'body', { min: 1, max: MAX_BODY }).trim() };
}

async function answer(ctx: SignedIn, threadId: string): Promise<Response> {
  const [thread] = await readThreads(ctx.env, [threadId]);
  const level = thread ? await levelOn(ctx.env, ctx.person, thread.first.project_id) : 0;
  if (!thread || level < 1) throw notFound();
  return Response.json(threadJson(thread, level, ctx));
}

/** A thread on the page, or on one of its sections: what the page itself calls it is kept as text. */
export async function addComment(ctx: SignedIn): Promise<Response> {
  const { env } = ctx, { project, level } = await openProject(env, ctx.person, ctx.params[0]!, 1), page = await findPage(env, project, ctx.params[1]!);
  if (level < COMMENTER) throw new ApiError('forbidden', 'Your level does not allow this.');
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['id', 'body', 'versionN', 'section']);
  const { id, text: written } = readNew(body), versionN = integer(body.versionN, 'versionN', 1, page.current_version);
  let section: New['section'] = null;
  if (body.section !== undefined && body.section !== null) {
    if (!isObject(body.section)) throw invalid('section must be an object.');
    onlyKeys(body.section, ['id', 'title', 'quote']);
    section = { id: text(body.section.id, 'section.id', { min: 1, max: 200 }), title: text(body.section.title, 'section.title', { min: 1, max: 200 }), quote: text(body.section.quote ?? '', 'section.quote', { max: 300 }) };
  }
  if (!(await env.DB.prepare('SELECT 1 FROM page_versions WHERE page_id = ? AND n = ?').bind(page.id, versionN).first())) throw invalid('That version is not there.');
  await write(ctx, { id, pageId: page.id, projectId: project.id, threadId: id, versionN, section, body: written, at: Date.now() });
  return answer(ctx, id);
}

export async function reply(ctx: SignedIn): Promise<Response> {
  const { comment } = await find(ctx, COMMENTER);
  if (!isThread(comment)) throw notFound();
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['id', 'body']);
  const { id, text: written } = readNew(body);
  if (id === comment.id) throw conflict('That id is taken.');
  const page = await ctx.env.DB.prepare('SELECT current_version FROM pages WHERE id = ?').bind(comment.page_id).first<{ current_version: number }>();
  await write(ctx, { id, pageId: comment.page_id, projectId: comment.project_id, threadId: comment.id, versionN: page!.current_version, section: null, body: written, at: Math.max(Date.now(), comment.created_at + 1) });
  return answer(ctx, comment.id);
}

/** Live comment on a live page, where the person still has `least` on the project (or owns it as a commenter). */
const allowed = (least: number) => `EXISTS (SELECT 1 FROM pages p WHERE p.id = comments.page_id AND p.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM members m WHERE m.id = ?1 AND m.removed_at IS NULL AND (
    m.role = 'owner'
    OR EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = m.id AND x.project_id = comments.project_id AND x.level >= ${least})
    OR (comments.member_id = m.id AND EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = m.id AND x.project_id = comments.project_id AND x.level >= ${COMMENTER}))))`;

export async function setResolved(ctx: SignedIn): Promise<Response> {
  const { comment, level } = await find(ctx, COMMENTER);
  if (!isThread(comment)) throw notFound();
  if (!mayResolve(comment, level, ctx)) throw new ApiError('forbidden', 'Your level does not allow this.');
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['resolved']);
  if (typeof body.resolved !== 'boolean') throw invalid('resolved must be true or false.');
  const now = Date.now(), check = allowed(DECIDER);
  try {
    await ctx.env.DB.batch([
      // Verify live page, live thread, and current permission inside the write transaction.
      ctx.env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM comments WHERE id = ?2 AND deleted_at IS NULL AND ${check}) THEN 1 ELSE json('not allowed') END`)
        .bind(ctx.person.memberId, comment.id),
      ctx.env.DB.prepare(`UPDATE comments SET resolved_at = ?3 WHERE id = ?2 AND deleted_at IS NULL AND resolved_at IS ${body.resolved ? '' : 'NOT '}NULL AND ${check}`)
        .bind(ctx.person.memberId, comment.id, body.resolved ? now : null),
      // Told once, and only when it became resolved.
      ctx.env.DB.prepare(`INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id) SELECT ?, ?, 'comment.resolved', ?, ?, 'person', ? WHERE changes() = 1 AND ${body.resolved ? 1 : 0}`)
        .bind(comment.project_id, comment.page_id, comment.id, now, ctx.person.memberId),
    ]);
  } catch (error) {
    if (!String(error).includes('malformed JSON')) throw error;
    const latest = await find(ctx, COMMENTER);
    if (!mayResolve(latest.comment, latest.level, ctx)) throw new ApiError('forbidden', 'Your level does not allow this.');
    throw conflict('The page or the thread changed meanwhile.');
  }
  if (body.resolved) {
    ctx.ctx.waitUntil(dispatchOutbox(ctx.env).catch(() => undefined));
    ctx.ctx.waitUntil(notifyLive(ctx.env, comment.project_id).catch(() => undefined));
  }
  return answer(ctx, comment.id);
}

/** Deleting a thread's first comment deletes its replies. */
export async function deleteComment(ctx: SignedIn): Promise<Response> {
  const { comment, level } = await find(ctx, COMMENTER);
  if (level < MANAGER && !mine(comment, ctx)) throw new ApiError('forbidden', 'Your level does not allow this.');
  const check = allowed(MANAGER);
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM comments WHERE id = ?2 AND deleted_at IS NULL AND ${check}) THEN 1 ELSE json('not allowed') END`)
        .bind(ctx.person.memberId, comment.id),
      ctx.env.DB.prepare(`UPDATE comments SET deleted_at = ? WHERE ${isThread(comment) ? 'thread_id' : 'id'} = ? AND deleted_at IS NULL`).bind(Date.now(), comment.id),
    ]);
  } catch (error) {
    if (!String(error).includes('malformed JSON')) throw error;
    const latest = await find(ctx, COMMENTER);
    if (latest.level < MANAGER && !mine(latest.comment, ctx)) throw new ApiError('forbidden', 'Your level does not allow this.');
    throw conflict('The page or the comment changed meanwhile.');
  }
  return new Response(null, { status: 204 });
}
