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

  const sets: string[] = [];
  const binds: unknown[] = [];
  const guards: D1PreparedStatement[] = [stillOwner(env, person.memberId)];
  const audits: D1PreparedStatement[] = [];

  if (body.name !== undefined) {
    const name = readName(body.name);
    sets.push('name_en = ?', 'name_ar = ?');
    binds.push(name.en, name.ar);
    audits.push(auditStatement(env, person.memberId, 'project.rename', project.id));
  }
  if (body.answersNeeded !== undefined) {
    const needed = integer(body.answersNeeded, 'answersNeeded', 1, 5);
    // Any explicit agreement change requires the `teams` switch to be on, even when setting to 1.
    guards.push(env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'teams' AND value_json = 'true') THEN 1 ELSE json('teams_off') END"));
    sets.push('answers_needed = ?');
    binds.push(needed);
    audits.push(auditStatement(env, person.memberId, 'project.agreement', project.id));
  }

  let updated: { name_en: string; name_ar: string; answers_needed: number } | undefined;
  try {
    const results = await env.DB.batch([
      ...guards,
      env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? RETURNING name_en, name_ar, answers_needed`)
        .bind(...binds, project.id),
      ...audits,
    ]);
    updated = (results[guards.length]!.results as { name_en: string; name_ar: string; answers_needed: number }[])[0];
  } catch (error) {
    const msg = String(error);
    if (msg.includes('agreement needs teams')) throw conflict('Turn teams on before changing required agreement.');
    if (msg.includes('malformed JSON')) {
      const still = await env.DB.prepare("SELECT 1 FROM members WHERE id = ? AND role = 'owner' AND removed_at IS NULL").bind(person.memberId).first();
      if (!still) throw new ApiError('forbidden', 'Only the owner can do this.');
      throw conflict('Turn teams on before changing required agreement.');
    }
    throw error;
  }
  const finalName = updated ? { en: updated.name_en, ar: updated.name_ar } : { en: project.name_en, ar: project.name_ar };
  const finalNeeded = updated ? updated.answers_needed : project.answers_needed;
  return Response.json({ slug: project.slug, name: finalName, level: 5, answersNeeded: finalNeeded, answerers: await answerers(env, project.id) });
}
