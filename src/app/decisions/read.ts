import type { AppEnv } from '../../shared/env';

/** Decisions as agents and people read them. */

interface DecisionRow {
  id: string; page_id: string; project_id: string; project: string; key: string; revision: number; status: 'open' | 'answered' | 'stale' | 'withdrawn'; answer_seq: number; updated_at: number;
  question: string; context: string; options_json: string; answers_needed: number; page: string; page_title: string; page_lang: 'en' | 'ar'; page_status: string; name_en: string; name_ar: string;
}
interface AnswerRow {
  decision_id: string; seq: number; revision: number; question: string; option_id: string | null; option_label: string | null; notes: string; answered_at: number;
  member_id: string; name: string | null; needed: number; decides: number;
}
export interface Answer {
  seq: number; revision: number; question: string; optionId: string | null; optionLabel: string | null; notes: string; answeredAt: number;
  answeredBy: { id: string; name: string | null }; needed: number; decides: boolean;
}
export interface Option { id: string; label: string; detail?: string; cost?: string }
export interface Decision { row: DecisionRow; options: Option[]; answer: Answer | null; agreement: Answer[]; history: Answer[] | null }

const MAX_HISTORY = 500;

const answerJson = (a: AnswerRow): Answer => ({
  seq: a.seq, revision: a.revision, question: a.question, optionId: a.option_id, optionLabel: a.option_label, notes: a.notes, answeredAt: a.answered_at,
  answeredBy: { id: a.member_id, name: a.name }, needed: a.needed, decides: a.decides === 1,
});

// The question and the option are as they were worded when it was answered.
const ANSWER = `SELECT a.decision_id, a.seq, a.revision, r.question, a.option_id, (SELECT o.value ->> 'label' FROM json_each(r.options_json) o WHERE o.value ->> 'id' = a.option_id) option_label,
  a.notes, a.answered_at, a.member_id, m.name, a.needed, a.decides`;
const WORDED = 'CROSS JOIN decision_revisions r ON r.decision_id = a.decision_id AND r.revision = a.revision CROSS JOIN members m ON m.id = a.member_id';

/** In the order of `ids`. One that is gone, or on a deleted page, is left out. All of it is read at one moment. */
export async function readDecisions(env: AppEnv, ids: string[], history = false): Promise<Decision[]> {
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  const [rows, deciding, agreeing, earlier] = await env.DB.batch([
    env.DB.prepare(`SELECT d.id, d.page_id, d.project_id, p.slug project, p.name_en, p.name_ar, d.key, d.revision, d.status, d.answer_seq, d.updated_at, r.question, r.context, r.options_json, p.answers_needed,
        g.slug page, g.title page_title, g.lang page_lang, g.status page_status
      FROM json_each(?) j CROSS JOIN decisions d ON d.id = j.value CROSS JOIN pages g ON g.id = d.page_id AND g.deleted_at IS NULL CROSS JOIN projects p ON p.id = d.project_id
      CROSS JOIN decision_revisions r ON r.decision_id = d.id AND r.revision = d.revision`).bind(list),
    env.DB.prepare(`${ANSWER} FROM json_each(?) j CROSS JOIN decisions d ON d.id = j.value CROSS JOIN decision_answers a ON a.decision_id = d.id AND a.seq = d.decided_seq ${WORDED}`).bind(list),
    // Each person's newest answer to this wording, of those who may still answer.
    env.DB.prepare(`${ANSWER} FROM json_each(?) j CROSS JOIN decisions d ON d.id = j.value CROSS JOIN decision_answers a ON a.decision_id = d.id AND a.revision = d.revision ${WORDED}
      WHERE NOT EXISTS (SELECT 1 FROM decision_answers b WHERE b.decision_id = a.decision_id AND b.member_id = a.member_id AND b.seq > a.seq)
      AND (m.role = 'owner' OR EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = a.member_id AND x.project_id = d.project_id AND x.level >= 3))`).bind(list),
    ...(history ? [env.DB.prepare(`${ANSWER} FROM decision_answers a ${WORDED} WHERE a.decision_id = ? ORDER BY a.seq DESC LIMIT ${MAX_HISTORY}`).bind(ids[0]!)] : []),
  ]);
  const answers = (result: D1Result | undefined, id: string) => ((result?.results ?? []) as AnswerRow[]).filter((a) => a.decision_id === id).sort((a, b) => a.seq - b.seq).map(answerJson);
  const found = new Map((rows!.results as DecisionRow[]).map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = found.get(id);
    return row ? [{ row, options: JSON.parse(row.options_json) as Option[], answer: answers(deciding, id)[0] ?? null, agreement: answers(agreeing, id), history: history ? answers(earlier, id).reverse() : null }] : [];
  });
}

export const decisionJson = ({ row, options, answer, agreement, history }: Decision) => ({
  id: row.id, pageId: row.page_id, project: row.project, key: row.key, revision: row.revision, status: row.status, question: row.question, context: row.context, options,
  answer, answersNeeded: row.answers_needed, agreement, ...(history && { history }),
});

type Place = [updatedAt: number, id: string];
const IN_PAGE = 'CROSS JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL';

/** Oldest change first. A project of null means every project. */
export function listStatement(env: AppEnv, project: string | null, status: string | null, after: Place, limit: number): D1PreparedStatement {
  const where = [...(project === null ? [] : ['d.project_id = ?']), ...(status === null ? [] : ['d.status = ?']), '(d.updated_at, d.id) > (?, ?)'];
  return env.DB.prepare(`SELECT d.id, d.updated_at FROM decisions d ${IN_PAGE} WHERE ${where.join(' AND ')} ORDER BY d.updated_at, d.id LIMIT ?`)
    .bind(...(project === null ? [] : [project]), ...(status === null ? [] : [status]), ...after, limit);
}

/** Whether someone answered this wording and others are still needed. */
const WAITS = `(EXISTS (SELECT 1 FROM projects n WHERE n.id = d.project_id AND n.answers_needed > 1)
  AND EXISTS (SELECT 1 FROM decision_answers a WHERE a.decision_id = d.id AND a.member_id = ? AND a.revision = d.revision))`;

/** Open and stale ones for one person: those to answer, or those that wait for others. Oldest first. */
export function inboxStatement(env: AppEnv, project: string | null, memberId: string, waiting: boolean, after: Place, limit: number): D1PreparedStatement {
  // The index is named, because the planner would otherwise sort.
  const [index, where] = project === null ? ['decisions_inbox', ''] : ['decisions_project_inbox', 'd.project_id = ? AND '];
  return env.DB.prepare(`SELECT d.id, d.updated_at FROM decisions d INDEXED BY ${index} ${IN_PAGE}
    WHERE ${where}d.status IN ('open','stale') AND (d.updated_at, d.id) > (?, ?) AND ${waiting ? '' : 'NOT '}${WAITS} ORDER BY d.updated_at, d.id LIMIT ?`)
    .bind(...(project === null ? [] : [project]), ...after, memberId, limit);
}

/** Answered ones, newest first. */
export function answeredStatement(env: AppEnv, project: string | null, before: Place, limit: number): D1PreparedStatement {
  return env.DB.prepare(`SELECT d.id, d.updated_at FROM decisions d ${IN_PAGE} WHERE ${project === null ? '' : 'd.project_id = ? AND '}d.status = 'answered' AND (d.updated_at, d.id) < (?, ?)
    ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`).bind(...(project === null ? [] : [project]), ...before, limit);
}

/** How many people may answer on a project: each once, however many teams they are in, and the owner. */
export async function answerers(env: AppEnv, projectId: string): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT tm.member_id FROM team_projects tp CROSS JOIN team_members tm ON tm.team_id = tp.team_id AND tm.level >= 3
    CROSS JOIN members m ON m.id = tm.member_id AND m.joined_at IS NOT NULL AND m.removed_at IS NULL WHERE tp.project_id = ?`).bind(projectId).all<{ member_id: string }>();
  return new Set(results.map((r) => r.member_id)).size + 1;
}
