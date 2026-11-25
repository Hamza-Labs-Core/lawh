import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { integer, oneOf, onlyKeys, readJson, text } from '../api/body';
import { findPage } from '../api/pages';
import { answeredStatement, answerers, countInboxStatement, type Decision, decisionJson, inboxStatement, readDecisions } from '../decisions/read';
import { encodeCursor, pageLimit, readCursor } from '../pages/list';
import { statusStatements } from '../search';
import { levelOn, openProject, visibleProjects } from './access';
import type { SignedIn } from './router';

const DECIDER = 3, MAX_COUNT = 99;

/** What a person sees: also the last answer's number, which an answer must name, and the page it is on. */
const seen = (decision: Decision, level: number) => ({
  ...decisionJson(decision), answerSeq: decision.row.answer_seq, mayAnswer: level >= DECIDER, updatedAt: decision.row.updated_at,
  page: { slug: decision.row.page, title: decision.row.page_title, lang: decision.row.page_lang, status: decision.row.page_status },
  projectName: { en: decision.row.name_en, ar: decision.row.name_ar },
});

/** A page's questions in its order, then the withdrawn ones that were answered. */
export async function listPageDecisions(ctx: SignedIn): Promise<Response> {
  const { env } = ctx, { project, level } = await openProject(env, ctx.person, ctx.params[0]!, 1), page = await findPage(env, project, ctx.params[1]!);
  const ids = async (where: string, limit: number) => (await env.DB.prepare(`SELECT id FROM decisions WHERE page_id = ? AND ${where} ORDER BY position LIMIT ?`).bind(page.id, limit).all<{ id: string }>()).results.map((r) => r.id);
  const decisions = await readDecisions(env, [...await ids("status <> 'withdrawn'", 50), ...await ids("status = 'withdrawn' AND answer_seq > 0", 50)]);
  return Response.json({
    items: decisions.map((d) => seen(d, level)), answerers: decisions.some((d) => d.row.answers_needed > 1) ? await answerers(env, project.id) : null,
  });
}

/** The decision, if the person sees its project. Below `least`, 403: they know it is there. */
async function find(ctx: SignedIn, least: number, history: boolean): Promise<{ decision: Decision; level: number }> {
  const [decision] = await readDecisions(ctx.env, [ctx.params[0]!], history);
  const level = decision ? await levelOn(ctx.env, ctx.person, decision.row.project_id) : 0;
  if (!decision || level < 1) throw notFound();
  if (level < least) throw new ApiError('forbidden', 'Only deciders answer.');
  return { decision, level };
}

export async function readDecision(ctx: SignedIn): Promise<Response> {
  const { decision, level } = await find(ctx, 1, true);
  return Response.json({ ...seen(decision, level), answerers: decision.row.answers_needed > 1 ? await answerers(ctx.env, decision.row.project_id) : null });
}

/** The projects whose decisions a person answers: null means all. */
const answerable = async (ctx: SignedIn): Promise<(string | null)[]> =>
  ctx.person.isOwner ? [null] : (await visibleProjects(ctx.env, ctx.person)).filter((p) => p.level >= DECIDER).map((p) => p.id);

/** Only those the person may answer, over all their projects. */
export async function listMyDecisions(ctx: SignedIn): Promise<Response> {
  const { env, url, person } = ctx, limit = pageLimit(url), show = oneOf(url.searchParams.get('show') ?? 'open', 'show', ['open', 'waiting', 'answered'] as const);
  const newestFirst = show === 'answered';
  const from = (readCursor(url, ['number', 'string']) ?? [newestFirst ? Number.MAX_SAFE_INTEGER : 0, '']) as [number, string];
  const queries = (await answerable(ctx)).map((p) => (newestFirst ? answeredStatement(env, p, from, limit + 1) : inboxStatement(env, p, person.memberId, show === 'waiting', from, limit + 1)));
  const found = queries.length === 0 ? [] : (await env.DB.batch<{ id: string; updated_at: number }>(queries)).flatMap((r) => r.results);
  found.sort((a, b) => (newestFirst ? -1 : 1) * (a.updated_at - b.updated_at || (a.id < b.id ? -1 : 1)));
  const rows = found.slice(0, limit), last = rows.at(-1);
  const decisions = await readDecisions(env, rows.map((r) => r.id));
  // Each project that needs agreement once, to say when fewer people can answer than must agree.
  const needing = [...new Set(decisions.filter((d) => d.row.answers_needed > 1).map((d) => d.row.project_id))];
  const counts = new Map(await Promise.all(needing.map(async (p): Promise<[string, number]> => [p, await answerers(env, p)])));
  return Response.json({
    items: decisions.map((d) => ({ ...seen(d, DECIDER), answerers: counts.get(d.row.project_id) ?? null })), next: found.length > limit && last ? encodeCursor([last.updated_at, last.id]) : null,
  });
}

/** How many wait for the person's answer, counted up to 99. */
export async function countMyDecisions(ctx: SignedIn): Promise<Response> {
  const projects = ctx.person.isOwner ? null : (await visibleProjects(ctx.env, ctx.person)).filter((p) => p.level >= DECIDER).map((p) => p.id);
  if (projects !== null && projects.length === 0) return Response.json({ count: 0, more: false });
  const n = (await countInboxStatement(ctx.env, projects, ctx.person.memberId, MAX_COUNT + 1).all()).results.length;
  return Response.json({ count: Math.min(n, MAX_COUNT), more: n > MAX_COUNT });
}

/**
 * An answer names the wording and the last answer the person saw. If either changed meanwhile, the database refuses
 * it, and the person sees the newest before answering again.
 */
export async function answerDecision(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  const { decision: { row, options } } = await find(ctx, DECIDER, false);
  onlyKeys(body, ['revision', 'seq', 'optionId', 'notes']);
  const revision = integer(body.revision, 'revision', 1, Number.MAX_SAFE_INTEGER), seq = integer(body.seq, 'seq', 0, Number.MAX_SAFE_INTEGER - 1);
  const notes = body.notes === undefined ? '' : text(body.notes, 'notes', { max: 4000 }).trim(), option = body.optionId ?? null;
  if (revision !== row.revision || seq !== row.answer_seq || row.status === 'withdrawn') throw conflict('The question or its answer changed.');
  if (option !== null && !options.some((o) => o.id === option)) throw invalid('That is not one of the options.');
  if (option === null && notes === '') throw invalid('Choose an option or write notes.');
  if (option === null && row.answers_needed > 1) throw invalid('This project needs an option.');
  const now = Math.max(Date.now(), row.updated_at + 1), next = seq + 1;
  const decided = 'EXISTS (SELECT 1 FROM decision_answers WHERE decision_id = ? AND seq = ? AND decides = 1)';
  try {
    await env.DB.batch([
      // How many must agree, and whether enough do with this one, as the triggers check it.
      env.DB.prepare(`INSERT INTO decision_answers(decision_id, seq, revision, option_id, notes, answered_at, member_id, needed, decides)
        SELECT d.id, ?1, ?2, ?3, ?4, ?5, ?6, p.answers_needed, p.answers_needed <= 1 + (SELECT COUNT(*) FROM decision_answers a
          WHERE a.decision_id = d.id AND a.revision = ?2 AND a.option_id = ?3 AND a.member_id <> ?6
          AND NOT EXISTS (SELECT 1 FROM decision_answers b WHERE b.decision_id = a.decision_id AND b.member_id = a.member_id AND b.seq > a.seq)
          AND (EXISTS (SELECT 1 FROM members o WHERE o.id = a.member_id AND o.role = 'owner')
            OR EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = a.member_id AND x.project_id = d.project_id AND x.level >= 3)))
        FROM decisions d CROSS JOIN projects p ON p.id = d.project_id WHERE d.id = ?7`).bind(next, revision, option, notes, now, person.memberId, row.id),
      env.DB.prepare(`INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id)
        SELECT ?, ?, CASE WHEN ${decided} THEN 'decision.answered' ELSE 'decision.vote' END, ?, ?, 'person', ?`).bind(row.project_id, row.page_id, row.id, next, row.id, now, person.memberId),
      // The page's last open question: it is decided.
      env.DB.prepare(`UPDATE pages SET status = 'decided', updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND status = 'in_review' AND deleted_at IS NULL AND ${decided}
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.page_id = pages.id AND d.status IN ('open','stale'))`).bind(now, row.page_id, row.id, next),
      env.DB.prepare("INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id) SELECT ?, ?, 'page.status', ?, ?, 'person', ? WHERE changes() = 1")
        .bind(row.project_id, row.page_id, row.page_id, now, person.memberId),
      ...statusStatements(env, row.page_id),
    ]);
  } catch (error) {
    // Between the read and the write: someone else answered, the page was published again or deleted, or the person's level changed.
    if (/answer conflict|UNIQUE constraint failed: decision_answers/.test(String(error))) throw conflict('The question or its answer changed.');
    if (String(error).includes('answer not allowed')) throw new ApiError('forbidden', 'Only deciders answer.');
    throw error;
  }
  const { decision, level } = await find(ctx, 1, true);
  return Response.json({ ...seen(decision, level), answerers: decision.row.answers_needed > 1 ? await answerers(env, decision.row.project_id) : null });
}
