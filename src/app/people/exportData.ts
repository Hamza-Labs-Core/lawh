import type { AppEnv } from '../../shared/env';
import { invalid } from '../../shared/errors';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly } from './settings';
import { type Entry, zip } from './zip';

/**
 * Everything the copy holds, for its owner: one ZIP of rows, and ZIPs of files. Sign-ins, links, sessions and the
 * secrets of keys and webhooks aren't in it: they are of no use in another copy. Nor is the search index, which is
 * made again.
 */

/** Tables in an order that can be loaded again, with the key each is read by. */
const TABLES: [table: string, key: string[], columns?: string][] = [
  ['projects', ['id']], ['members', ['id']], ['teams', ['id']], ['team_members', ['team_id', 'member_id']], ['team_projects', ['team_id', 'project_id']], ['agents', ['id']],
  ['agent_keys', ['id'], 'id, agent_id, scopes_json, all_projects, created_at, expires_at, last_used_at, revoked_at, label'], ['agent_key_projects', ['key_id', 'project_id']],
  ['pages', ['id']], ['page_tags', ['page_id', 'tag']], ['page_versions', ['id']], ['blobs', ['sha256'], 'sha256, bytes, created_at'], ['version_files', ['version_id', 'path']], ['project_blobs', ['project_id', 'sha256']],
  ['decisions', ['id']], ['decision_revisions', ['decision_id', 'revision']], ['decision_answers', ['decision_id', 'seq']], ['comments', ['id']], ['events', ['seq']],
  ['webhooks', ['id'], 'id, project_id, url, event_types_json, enabled, created_by, created_at'], ['settings', ['key']], ['audit', ['seq']],
];
const ROWS = 500, FILES = 500, PART_BYTES = 512 * 1024 * 1024;

async function* rowsOf(env: AppEnv, table: string, key: string[], columns: string): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder(), marks = key.map(() => '?').join(', ');
  let after: unknown[] = [];
  for (;;) {
    const query = env.DB.prepare(`SELECT ${columns} FROM ${table}${after.length > 0 ? ` WHERE (${key.join(', ')}) > (${marks})` : ''} ORDER BY ${key.join(', ')} LIMIT ${ROWS}`);
    const { results } = await query.bind(...after).all<Record<string, unknown>>();
    if (results.length > 0) yield encoder.encode(results.map((row) => `${JSON.stringify(row)}\n`).join(''));
    if (results.length < ROWS) return;
    after = key.map((k) => results.at(-1)![k]);
  }
}

async function* one(text: string): AsyncGenerator<Uint8Array> { yield new TextEncoder().encode(text); }

async function* rowEntries(env: AppEnv): AsyncGenerator<Entry> {
  yield { name: 'lawh.json', body: one(`${JSON.stringify({ format: 1, madeAt: Date.now(), tables: TABLES.map(([table]) => table), note: 'One JSON object a line in each rows file. Files are in their own ZIPs, named by SHA-256; version_files says which path each has.' }, null, 2)}\n`) };
  for (const [table, key, columns = '*'] of TABLES) yield { name: `rows/${table}.ndjson`, body: rowsOf(env, table, key, columns) };
}

async function* fileEntries(env: AppEnv, after: string, last: string): AsyncGenerator<Entry> {
  let cursor = after;
  for (;;) {
    const { results } = await env.DB.prepare('SELECT sha256, r2_key FROM blobs WHERE sha256 > ? AND sha256 <= ? ORDER BY sha256 LIMIT ?').bind(cursor, last, FILES).all<{ sha256: string; r2_key: string }>();
    for (const { sha256, r2_key } of results) {
      const object = await env.FILES.get(r2_key);
      // Cleaned up since the list was read.
      if (object) yield { name: `files/${sha256}`, body: object.body };
    }
    if (results.length < FILES) return;
    cursor = results.at(-1)!.sha256;
  }
}

function download(name: string, entries: AsyncIterable<Entry>): Response {
  const parts = zip(entries);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) { const next = await parts.next(); if (next.done) controller.close(); else controller.enqueue(next.value); },
    async cancel() { await parts.return(undefined); },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` } });
}

export async function exportRows(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  await auditStatement(ctx.env, ctx.person.memberId, 'export', null).run();
  return download('lawh-rows.zip', rowEntries(ctx.env));
}

/** The files in parts: at most 500 files and about 512 MB in each, in the order of their hashes. */
export async function exportPlan(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const parts: { after: string; last: string; files: number; bytes: number }[] = [];
  let after = '', start = '', files = 0, bytes = 0;
  for (;;) {
    const { results } = await ctx.env.DB.prepare('SELECT sha256, bytes FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT 5000').bind(after).all<{ sha256: string; bytes: number }>();
    for (const blob of results) {
      if (files > 0 && (files >= FILES || bytes + blob.bytes > PART_BYTES)) { parts.push({ after: start, last: after, files, bytes }); start = after; files = 0; bytes = 0; }
      after = blob.sha256; files++; bytes += blob.bytes;
    }
    if (results.length < 5000) break;
  }
  if (files > 0) parts.push({ after: start, last: after, files, bytes });
  return Response.json({ parts });
}

export async function exportFiles(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const after = ctx.url.searchParams.get('after') ?? '', last = ctx.url.searchParams.get('last') ?? '', part = ctx.url.searchParams.get('part') ?? '1';
  if (!/^(?:[0-9a-f]{64})?$/.test(after) || !/^[0-9a-f]{64}$/.test(last) || !/^[1-9]\d{0,6}$/.test(part)) throw invalid('That part is not there.');
  return download(`lawh-files-${part}.zip`, fileEntries(ctx.env, after, last));
}
