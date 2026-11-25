import type { AppEnv } from '../../shared/env';
import { normalize, token, words } from './text';

/** The search index: one row a page, with a higher number after each change, so its order is newest first. */

// The page's project, status and tags, from the database itself, so it is right whatever happened in the same moment.
const SCOPE = `(SELECT 'p' || lower(hex(p.project_id)) || ' s' || lower(hex(p.status)) || COALESCE((SELECT group_concat(' t' || lower(hex(t.tag)), '') FROM page_tags t WHERE t.page_id = p.id), '') FROM pages p WHERE p.id = ?1)`;
const ROW = '(SELECT rowid FROM pages_fts_map WHERE page_id = ?1)';
const NEXT = '(SELECT MAX(rowid) + 1 FROM pages_fts_map)';

export interface Indexed { title: string; summary: string; tags: string[] }

/** After the page and its tags were written: the whole row. */
export function indexStatements(env: AppEnv, pageId: string, { title, summary, tags }: Indexed, body: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(`DELETE FROM pages_fts WHERE rowid = ${ROW}`).bind(pageId),
    env.DB.prepare('INSERT OR REPLACE INTO pages_fts_map(page_id) VALUES(?1)').bind(pageId),
    env.DB.prepare(`INSERT INTO pages_fts(rowid, scope, title, summary, tags, body) VALUES(${ROW}, ${SCOPE}, ?2, ?3, ?4, ?5)`)
      .bind(pageId, normalize(title), normalize(summary), normalize(tags.join(' ')), normalize(body)),
  ];
}

const move = (env: AppEnv, pageId: string): D1PreparedStatement =>
  // Only when the row before it was moved.
  env.DB.prepare(`UPDATE pages_fts_map SET rowid = ${NEXT} WHERE page_id = ?1 AND NOT EXISTS (SELECT 1 FROM pages_fts f WHERE f.rowid = pages_fts_map.rowid) AND EXISTS (SELECT 1 FROM pages_fts f WHERE f.rowid = ${NEXT})`).bind(pageId);

/** New details of a page whose files stay. */
export function detailStatements(env: AppEnv, pageId: string, { title, summary, tags }: Indexed): D1PreparedStatement[] {
  return [
    env.DB.prepare(`UPDATE pages_fts SET rowid = ${NEXT}, scope = ${SCOPE}, title = ?2, summary = ?3, tags = ?4 WHERE rowid = ${ROW}`).bind(pageId, normalize(title), normalize(summary), normalize(tags.join(' '))),
    move(env, pageId),
  ];
}

/** A new status, if the statement before these changed a row. */
export function statusStatements(env: AppEnv, pageId: string): D1PreparedStatement[] {
  return [env.DB.prepare(`UPDATE pages_fts SET rowid = ${NEXT}, scope = ${SCOPE} WHERE rowid = ${ROW} AND changes() = 1`).bind(pageId), move(env, pageId)];
}

export interface Filters { projects: string[] | null; status: string | null; tag: string | null }

/** What the index is asked; null when it can match nothing. The filters apply inside it, before any limit. */
export function matchOf(q: string, { projects, status, tag }: Filters): string | null {
  const text = words(q);
  if (text === null || projects?.length === 0) return null;
  return [
    ...(projects ? [`scope:(${projects.map((p) => token('p', p)).join(' OR ')})`] : []), ...(status === null ? [] : [`scope:${token('s', status)}`]), ...(tag === null ? [] : [`scope:${token('t', tag)}`]),
    `{title summary tags body}:(${text})`,
  ].join(' AND ');
}
