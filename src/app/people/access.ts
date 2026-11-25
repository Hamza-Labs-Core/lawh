import type { AppEnv } from '../../shared/env';
import { notFound } from '../../shared/errors';
import type { Project } from '../api/auth';
import type { Person } from './session';

/** 0 no access, 1 viewer, 2 commenter, 3 decider, 4 manager, 5 owner. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5;

/** A person's level on a project, read on every request: a change or a removal counts from the next one. */
export async function levelOn(env: AppEnv, person: Person, projectId: string): Promise<Level> {
  if (person.isOwner) return 5;
  const row = await env.DB.prepare('SELECT MAX(level) level FROM project_access WHERE member_id = ? AND project_id = ?').bind(person.memberId, projectId).first<{ level: Level | null }>();
  return row?.level ?? 0;
}

/** The project and the person's level on it. Below `least`, and for a project that isn't there, 404: names don't show. */
export async function openProject(env: AppEnv, person: Person, slug: string, least: Level): Promise<{ project: Project; level: Level }> {
  const project = await env.DB.prepare('SELECT id, slug, name_en, name_ar FROM projects WHERE slug = ?').bind(slug).first<Project>();
  const level = project ? await levelOn(env, person, project.id) : 0;
  if (!project || level < Math.max(least, 1)) throw notFound();
  return { project, level };
}

/** The projects a person sees, with their level: every project for the owner, at most 50 for anyone else. */
export async function visibleProjects(env: AppEnv, person: Person): Promise<(Project & { level: Level })[]> {
  const query = person.isOwner
    ? env.DB.prepare("SELECT p.id, p.slug, p.name_en, p.name_ar, 5 level FROM projects p WHERE p.slug > '' ORDER BY p.slug LIMIT 1000")
    : env.DB.prepare('SELECT p.id, p.slug, p.name_en, p.name_ar, x.level FROM project_access x JOIN projects p ON p.id = x.project_id WHERE x.member_id = ?').bind(person.memberId);
  const best = new Map<string, Project & { level: Level }>();
  // A project can come through two teams: the highest level counts.
  for (const row of (await query.all<Project & { level: Level }>()).results) if ((best.get(row.id)?.level ?? 0) < row.level) best.set(row.id, row);
  return [...best.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}
