import { conflict, invalid } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isObject, onlyKeys, readJson, text } from '../api/body';
import { openProject } from './access';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly } from './settings';

/** Projects are the owner's to make and name. */

function readName(value: unknown): { en: string; ar: string } {
  if (!isObject(value)) throw invalid('name must be an object.');
  onlyKeys(value, ['en', 'ar']);
  return { en: text(value.en, 'name.en', { min: 1, max: 80 }).trim(), ar: text(value.ar, 'name.ar', { min: 1, max: 80 }).trim() };
}

export async function addProject(ctx: SignedIn): Promise<Response> {
  ownerOnly(ctx);
  const { env, person } = ctx, { body } = await readJson(ctx.request);
  onlyKeys(body, ['slug', 'name']);
  const name = readName(body.name), slug = body.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw invalid('slug must be 1 to 80 lowercase letters, digits or dashes, and start with a letter or digit.');
  const id = newId('prj');
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES(?,?,?,?,?)').bind(id, slug, name.en, name.ar, Date.now()),
      auditStatement(env, person.memberId, 'project.add', id),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: projects.slug')) throw conflict('That address is taken.');
    throw error;
  }
  return Response.json({ slug, name, level: 5 }, { status: 201 });
}

export async function renameProject(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { project } = await openProject(env, person, ctx.params[0]!, 1);
  ownerOnly(ctx);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['name']);
  const name = readName(body.name);
  await env.DB.batch([
    env.DB.prepare('UPDATE projects SET name_en = ?, name_ar = ? WHERE id = ?').bind(name.en, name.ar, project.id),
    auditStatement(env, person.memberId, 'project.rename', project.id),
  ]);
  return Response.json({ slug: project.slug, name, level: 5 });
}
