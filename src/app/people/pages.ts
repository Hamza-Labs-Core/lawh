import { notFound } from '../../shared/errors';
import { projectJson } from '../api/auth';
import { findPage, type PageRow, VERSION, type VersionRow, versionJson, versionList } from '../api/pages';
import { contentUrl, viewerUrl } from '../contentUrl';
import { listPageRows, tagsOf } from '../pages/list';
import { openProject, visibleProjects } from './access';
import type { SignedIn } from './router';

const pageJson = (project: { slug: string; name_en: string; name_ar: string }, page: PageRow, tags: string[]) => ({
  id: page.id, project: projectJson(project as never), slug: page.slug, title: page.title, summary: page.summary, lang: page.lang, tags, status: page.status,
  currentVersion: page.current_version, updatedAt: page.updated_at,
});

export async function listMyProjects(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  const projectsStmt = person.isOwner
    ? env.DB.prepare("SELECT p.id, p.slug, p.name_en, p.name_ar, p.answers_needed, 5 level FROM projects p WHERE p.slug > '' ORDER BY p.slug LIMIT 1000")
    : env.DB.prepare('SELECT p.id, p.slug, p.name_en, p.name_ar, p.answers_needed, x.level FROM project_access x JOIN projects p ON p.id = x.project_id WHERE x.member_id = ?').bind(person.memberId);
  const decidersStmt = person.isOwner
    ? env.DB.prepare(
      `SELECT tp.project_id, tm.member_id
       FROM projects p
       CROSS JOIN team_projects tp ON tp.project_id = p.id
       CROSS JOIN team_members tm ON tm.team_id = tp.team_id AND tm.level >= 3
       CROSS JOIN members m ON m.id = tm.member_id AND m.joined_at IS NOT NULL AND m.removed_at IS NULL
       WHERE p.slug > ''
         AND p.slug <= COALESCE((SELECT slug FROM projects WHERE slug > '' ORDER BY slug LIMIT 1 OFFSET 999), '~')
         AND EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true')`,
    )
    : env.DB.prepare(
      `SELECT tp.project_id, tm.member_id
       FROM project_access x
       CROSS JOIN team_projects tp ON tp.project_id = x.project_id
       CROSS JOIN team_members tm ON tm.team_id = tp.team_id AND tm.level >= 3
       CROSS JOIN members m ON m.id = tm.member_id AND m.joined_at IS NOT NULL AND m.removed_at IS NULL
       WHERE x.member_id = ?
         AND EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true')`,
    ).bind(person.memberId);

  const [projRes, decRes] = await env.DB.batch([projectsStmt, decidersStmt]);
  type Row = { id: string; slug: string; name_en: string; name_ar: string; answers_needed: number; level: number };
  const best = new Map<string, Row>();
  for (const row of projRes!.results as Row[]) {
    if ((best.get(row.id)?.level ?? 0) < row.level) best.set(row.id, row);
  }
  const byProject = new Map<string, Set<string>>();
  for (const row of decRes!.results as { project_id: string; member_id: string }[]) {
    let set = byProject.get(row.project_id);
    if (!set) { set = new Set(); byProject.set(row.project_id, set); }
    set.add(row.member_id);
  }
  const projects = [...best.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return Response.json({
    items: projects.map((p) => ({
      ...projectJson(p as never),
      level: p.level,
      answersNeeded: p.answers_needed,
      answerers: (byProject.get(p.id)?.size ?? 0) + 1,
    })),
  });
}

export async function listMyPages(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx, slug = url.searchParams.get('project');
  const projects = slug !== null ? [(await openProject(env, person, slug, 1)).project] : person.isOwner ? null : await visibleProjects(env, person);
  const { items, next } = await listPageRows(env, url, projects);
  return Response.json({ items: items.map(({ page, project, tags }) => pageJson(project, page, tags)), next });
}

/** The first text, in the database's order, that doesn't start with `prefix`; null when there is none. */
function afterPrefix(prefix: string): string | null {
  const points = [...prefix].map((c) => c.codePointAt(0)!);
  while (points.length > 0) {
    const last = points.pop()!;
    // Past the surrogates, which aren't characters.
    if (last < 0x10FFFF) return String.fromCodePoint(...points, last === 0xD7FF ? 0xE000 : last + 1);
  }
  return null;
}

/** By code point, as the database sorts; JavaScript's own order differs past U+FFFF. */
function byCodePoint(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
  return x.length - y.length;
}

/** The tags in use on pages that aren't deleted, for the filter: those that start with `q`, 50 at most. Each is found by an index seek, however many pages have it; deleted pages are stepped over until their purge. */
export async function listMyTags(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx, slug = url.searchParams.get('project');
  const q = [...(url.searchParams.get('q') ?? '').trim().normalize('NFC')].slice(0, 40).join('').toWellFormed(), end = afterPrefix(q);
  const query = (project: string | null): D1PreparedStatement => {
    const next = (from: string) => `(SELECT pt.tag FROM page_tags pt CROSS JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL
      WHERE ${project === null ? '' : 'pt.project_id = ?3 AND '}pt.tag ${from}${end === null ? '' : ' AND pt.tag < ?2'} ORDER BY pt.tag LIMIT 1)`;
    return env.DB.prepare(`WITH RECURSIVE t(tag) AS (SELECT ${next('>= ?1')} UNION ALL SELECT ${next('> t.tag')} FROM t WHERE t.tag IS NOT NULL LIMIT 51) SELECT tag FROM t WHERE tag IS NOT NULL AND ?2 IS ?2`)
      .bind(q, end, ...(project === null ? [] : [project]));
  };
  // The owner's is one query over every project; anyone else's is one for each of at most 50.
  const projects = slug !== null ? [(await openProject(env, person, slug, 1)).project.id] : person.isOwner ? [null] : (await visibleProjects(env, person)).map((p) => p.id);
  const found = projects.length === 0 ? [] : (await env.DB.batch<{ tag: string }>(projects.map(query))).flatMap((r) => r.results.map((row) => row.tag));
  return Response.json({ items: [...new Set(found)].sort(byCodePoint).slice(0, 50) });
}

/** A page to read: its details, the version asked for, and the address for its sandboxed frame. */
export async function readPage(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx;
  const { project, level } = await openProject(env, person, ctx.params[0]!, 1);
  const page = await findPage(env, project, ctx.params[1]!);
  const asked = url.searchParams.get('v') ?? String(page.current_version);
  if (!/^[1-9][0-9]{0,9}$/.test(asked)) throw notFound();
  const version = await env.DB.prepare(`${VERSION.replace('v.created_at', 'v.created_at, v.entry_path')} WHERE v.page_id = ? AND v.n = ?`).bind(page.id, Number(asked)).first<VersionRow & { entry_path: string }>();
  if (!version) throw notFound();
  const mode = url.searchParams.get('mode') === 'light' ? 'light' : 'dark', lang = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
  return Response.json({
    ...pageJson(project, page, (await tagsOf(env, [page.id])).get(page.id) ?? []), level, version: versionJson(version),
    frame: await contentUrl(env, version.id, version.entry_path, mode, lang), viewer: await viewerUrl(env, version.id),
  });
}

export async function listMyVersions(ctx: SignedIn): Promise<Response> {
  const { project } = await openProject(ctx.env, ctx.person, ctx.params[0]!, 1);
  return Response.json(await versionList(ctx.env, ctx.url, await findPage(ctx.env, project, ctx.params[1]!)));
}
