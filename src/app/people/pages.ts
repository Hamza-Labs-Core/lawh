import { notFound } from '../../shared/errors';
import { projectJson } from '../api/auth';
import { findPage, type PageRow, VERSION, type VersionRow, versionJson, versionList } from '../api/pages';
import { contentUrl } from '../contentUrl';
import { listPageRows, tagsOf } from '../pages/list';
import { openProject, visibleProjects } from './access';
import type { SignedIn } from './router';

const pageJson = (project: { slug: string; name_en: string; name_ar: string }, page: PageRow, tags: string[]) => ({
  id: page.id, project: projectJson(project as never), slug: page.slug, title: page.title, summary: page.summary, lang: page.lang, tags, status: page.status,
  currentVersion: page.current_version, updatedAt: page.updated_at,
});

export async function listMyProjects(ctx: SignedIn): Promise<Response> {
  return Response.json({ items: (await visibleProjects(ctx.env, ctx.person)).map((p) => ({ ...projectJson(p), level: p.level })) });
}

export async function listMyPages(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx, slug = url.searchParams.get('project');
  const projects = slug !== null ? [(await openProject(env, person, slug, 1)).project] : person.isOwner ? null : await visibleProjects(env, person);
  const { items, next } = await listPageRows(env, url, projects);
  return Response.json({ items: items.map(({ page, project, tags }) => pageJson(project, page, tags)), next });
}

/** The tags in use, for the filter: those that start with `q`, 50 at most. Each is one index seek, however many pages have it. */
export async function listMyTags(ctx: SignedIn): Promise<Response> {
  const { env, person, url } = ctx, slug = url.searchParams.get('project'), q = (url.searchParams.get('q') ?? '').trim().normalize('NFC').slice(0, 40);
  const projects = slug !== null ? [(await openProject(env, person, slug, 1)).project] : await visibleProjects(env, person);
  const end = `${q}\u{10FFFF}`;
  const batches: D1PreparedStatement[] = projects.slice(0, 100).map((p) => env.DB.prepare(
    `WITH RECURSIVE t(tag) AS (
       SELECT MIN(tag) FROM page_tags WHERE project_id = ?1 AND tag >= ?2 AND tag < ?3
       UNION ALL SELECT (SELECT MIN(tag) FROM page_tags WHERE project_id = ?1 AND tag > t.tag AND tag < ?3) FROM t WHERE t.tag IS NOT NULL LIMIT 51)
     SELECT tag FROM t WHERE tag IS NOT NULL`).bind(p.id, q, end));
  const found = batches.length === 0 ? [] : (await env.DB.batch<{ tag: string }>(batches)).flatMap((r) => r.results.map((row) => row.tag));
  return Response.json({ items: [...new Set(found)].sort((a, b) => a.localeCompare(b)).slice(0, 50) });
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
    frame: await contentUrl(env, version.id, version.entry_path, mode, lang),
  });
}

export async function listMyVersions(ctx: SignedIn): Promise<Response> {
  const { project } = await openProject(ctx.env, ctx.person, ctx.params[0]!, 1);
  return Response.json(await versionList(ctx.env, ctx.url, await findPage(ctx.env, project, ctx.params[1]!)));
}
