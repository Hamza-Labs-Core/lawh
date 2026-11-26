import { ApiError, conflict, invalid } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { integer, isObject, onlyKeys, readJson, text } from '../api/body';
import { answerers } from '../decisions/read';
import { openProject } from './access';
import type { SignedIn } from './router';
import { auditStatement } from './session';
import { ownerOnly, stillOwner } from './settings';

/** Projects are the owner's to make, name, and configure agreement on. */

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
      stillOwner(env, person.memberId),
      env.DB.prepare('INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES(?,?,?,?,?)').bind(id, slug, name.en, name.ar, Date.now()),
      auditStatement(env, person.memberId, 'project.add', id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    if (String(error).includes('UNIQUE constraint failed: projects.slug')) throw conflict('That address is taken.');
    throw error;
  }
  return Response.json({ slug, name, level: 5, answersNeeded: 1, answerers: 1 }, { status: 201 });
}

export async function renameProject(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, { project } = await openProject(env, person, ctx.params[0]!, 1);
  ownerOnly(ctx);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['name', 'answersNeeded']);
  if (body.name === undefined && body.answersNeeded === undefined) throw invalid('name or answersNeeded is needed.');
  const name = body.name !== undefined ? readName(body.name) : { en: project.name_en, ar: project.name_ar };
  const answersNeeded = body.answersNeeded !== undefined ? integer(body.answersNeeded, 'answersNeeded', 1, 5) : project.answers_needed;
  const audits: D1PreparedStatement[] = [];
  if (body.name !== undefined) audits.push(auditStatement(env, person.memberId, 'project.rename', project.id));
  if (body.answersNeeded !== undefined) audits.push(auditStatement(env, person.memberId, 'project.agreement', project.id));
  try {
    await env.DB.batch([
      stillOwner(env, person.memberId),
      env.DB.prepare('UPDATE projects SET name_en = ?, name_ar = ?, answers_needed = ? WHERE id = ?')
        .bind(name.en, name.ar, answersNeeded, project.id),
      ...audits,
    ]);
  } catch (error) {
    const msg = String(error);
    if (msg.includes('agreement needs teams')) throw conflict('Turn teams on before requiring more than one person to agree.');
    if (msg.includes('malformed JSON')) throw new ApiError('forbidden', 'Only the owner can do this.');
    throw error;
  }
  return Response.json({ slug: project.slug, name, level: 5, answersNeeded, answerers: await answerers(env, project.id) });
}
