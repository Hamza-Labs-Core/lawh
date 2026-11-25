import type { AppEnv } from '../../shared/env';
import { invalid } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isObject, onlyKeys, text } from '../api/body';

/** What a page asks. `options` is JSON text: as stored, and compared as text to tell whether the wording changed. */
export interface Declared { key: string; question: string; context: string; options: string }

const MAX_DECISIONS = 50;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) throw invalid(`${what} must be 1 to 40 letters, digits, dots, dashes or underscores, and start with a letter or digit.`);
  return value;
}

function readOption(value: unknown): { id: string; label: string; detail?: string; cost?: string } {
  if (!isObject(value)) throw invalid('Each option must be an object.');
  onlyKeys(value, ['id', 'label', 'detail', 'cost']);
  const detail = value.detail === undefined ? '' : text(value.detail, 'detail', { max: 2000 }), cost = value.cost === undefined ? '' : text(value.cost, 'cost', { max: 300 });
  return { id: name(value.id, 'An option id'), label: text(value.label, 'label', { min: 1, max: 200 }), ...(detail && { detail }), ...(cost && { cost }) };
}

export function readDeclared(value: unknown): Declared[] {
  if (!Array.isArray(value) || value.length > MAX_DECISIONS) throw invalid(`decisions must be a list of at most ${MAX_DECISIONS}.`);
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!isObject(item)) throw invalid('Each decision must be an object.');
    onlyKeys(item, ['key', 'question', 'context', 'options']);
    const key = name(item.key, 'A decision key');
    if (keys.has(key)) throw invalid('A decision key is listed twice.', { key });
    keys.add(key);
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 10) throw invalid('A decision needs 2 to 10 options.', { key });
    const options = item.options.map(readOption);
    if (new Set(options.map((o) => o.id)).size !== options.length) throw invalid('An option id is listed twice.', { key });
    return {
      key, question: text(item.question, 'question', { min: 1, max: 500 }), context: item.context === undefined ? '' : text(item.context, 'context', { max: 4000 }),
      options: JSON.stringify(options),
    };
  });
}

/**
 * A new version's questions, compared with what the page asks now. It all happens in the database, inside the commit:
 * an answer that comes at the same moment is either before it, and counted, or after it, and refused.
 */
export function declareStatements(
  env: AppEnv, declared: Declared[], { pageId, projectId, versionId, n, agentId, now }: { pageId: string; projectId: string; versionId: string; n: number; agentId: string; now: number },
): D1PreparedStatement[] {
  const list = JSON.stringify(declared.map((d) => ({ ...d, id: newId('dec', now) })));
  const prepare = (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values);
  const ASKED = "json_each(?) j CROSS JOIN decisions d ON d.page_id = ? AND d.key = j.value ->> 'key'";
  const changed = 'EXISTS (SELECT 1 FROM decision_revisions x WHERE x.decision_id = d.id AND x.revision = d.revision + 1)';
  return [
    prepare("UPDATE decisions SET status = 'withdrawn', updated_at = ? WHERE page_id = ? AND status <> 'withdrawn' AND key NOT IN (SELECT value ->> 'key' FROM json_each(?))", now, pageId, list),
    // Other wording: a new revision. From here to the update, its number is one above the decision's.
    prepare(`INSERT INTO decision_revisions(decision_id, revision, question, context, options_json, version_id, version_n, created_at)
      SELECT d.id, d.revision + 1, j.value ->> 'question', j.value ->> 'context', j.value ->> 'options', ?, ?, ?
      FROM ${ASKED} CROSS JOIN decision_revisions r ON r.decision_id = d.id AND r.revision = d.revision
      WHERE r.question <> j.value ->> 'question' OR r.context <> j.value ->> 'context' OR r.options_json <> j.value ->> 'options'`, versionId, n, now, list, pageId),
    prepare(`INSERT INTO events(project_id, page_id, type, subject_id, created_at, actor_type, actor_id)
      SELECT d.project_id, d.page_id, 'decision.stale', d.id, ?, 'agent', ? FROM ${ASKED} WHERE d.status = 'answered' AND ${changed}`, now, agentId, list, pageId),
    // One that comes back is answered again if its answer was to the same wording.
    prepare(`UPDATE decisions AS d SET position = j.key, revision = d.revision + ${changed},
        updated_at = CASE WHEN d.status = 'withdrawn' OR ${changed} THEN ? ELSE d.updated_at END,
        status = CASE
          WHEN d.status = 'withdrawn' THEN CASE WHEN EXISTS (SELECT 1 FROM decision_answers a CROSS JOIN decision_revisions r ON r.decision_id = a.decision_id AND r.revision = a.revision
            WHERE a.decision_id = d.id AND a.seq = d.decided_seq AND r.question = j.value ->> 'question' AND r.context = j.value ->> 'context' AND r.options_json = j.value ->> 'options') THEN 'answered' ELSE 'open' END
          WHEN d.status = 'answered' AND ${changed} THEN 'stale' ELSE d.status END
      FROM json_each(?) j WHERE d.page_id = ? AND d.key = j.value ->> 'key'`, now, list, pageId),
    prepare(`INSERT INTO decisions(id, page_id, project_id, key, position, created_at, updated_at)
      SELECT j.value ->> 'id', ?, ?, j.value ->> 'key', j.key, ?, ? FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.page_id = ? AND d.key = j.value ->> 'key')`, pageId, projectId, now, now, list, pageId),
    prepare(`INSERT INTO decision_revisions(decision_id, revision, question, context, options_json, version_id, version_n, created_at)
      SELECT d.id, 1, j.value ->> 'question', j.value ->> 'context', j.value ->> 'options', ?, ?, ?
      FROM ${ASKED} WHERE NOT EXISTS (SELECT 1 FROM decision_revisions r WHERE r.decision_id = d.id AND r.revision = 1)`, versionId, n, now, list, pageId),
  ];
}
