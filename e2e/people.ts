import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type BrowserContext, type Page, test as base } from '@playwright/test';

export const APP = 'http://localhost:8797';

export async function db(...statements: string[]): Promise<Record<string, unknown>[][]> {
  const response = await fetch(`${APP}/`, { method: 'POST', headers: { 'X-Lawh-E2E': 'database' }, body: JSON.stringify(statements) });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<Record<string, unknown>[][]>;
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A member of their own for each test, so tests don't touch each other. */
export async function makeMember(name = 'Mona'): Promise<string> {
  const id = `mem_${randomUUID()}`;
  await db(`INSERT INTO members(id,name,created_by,created_at) VALUES('${id}','${name}','o',1)`, `UPDATE members SET joined_at=1 WHERE id='${id}'`);
  return id;
}

/** Puts a member in a team of their own, with project `one` (and `two`). */
export async function join(member: string, level = 1, both = false): Promise<void> {
  const team = `team_${randomUUID()}`;
  await db(`INSERT INTO teams(id,name,created_at) VALUES('${team}','${team}',1)`, `INSERT INTO team_projects(team_id,project_id) VALUES('${team}','p1')${both ? `,('${team}','p2')` : ''}`,
    `INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('${team}','${member}',${level},'o',1)`);
}

export async function makeLink(member: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db(`INSERT INTO access_links(token_sha256,kind,member_id,created_by,created_at,expires_at) VALUES('${hash(token)}','reset','${member}','o',1,${Date.now() + 600_000})`);
  return token;
}

/** Signs a browser in without a passkey, for tests of what comes after. */
export async function enter(context: BrowserContext, member: string): Promise<void> {
  const link = hash(await makeLink(member)), token = randomBytes(32).toString('base64url');
  await db(`INSERT INTO passkeys(credential_id,member_id,public_key,sign_count,label,created_at,link_id) VALUES('${randomUUID()}','${member}',x'00',0,'x',1,'${link}')`,
    `INSERT INTO sessions(token_sha256,member_id,label,created_at,last_seen_at,expires_at,passkey_id) SELECT '${hash(token)}','${member}','x',${Date.now()},${Date.now()},${Date.now() + 600_000},credential_id FROM passkeys WHERE member_id='${member}'`);
  await context.addCookies([{ name: 'lawh-local', value: token, url: APP, httpOnly: true, sameSite: 'Lax' }]);
}

/** Says whether the person just did something. Playwright's own calls count as that, so the browser's answer can't be used. */
export async function activation(page: Page, active: boolean): Promise<void> {
  await page.addInitScript((value) => { if (self === top) { (window as unknown as { active: boolean }).active = value; Object.defineProperty(navigator, 'userActivation', { get: () => ({ isActive: (window as unknown as { active: boolean }).active }) }); } }, active);
}
export const setActive = (page: Page, value: boolean) => page.evaluate((v) => { (window as unknown as { active: boolean }).active = v; }, value);

export async function leave(member: string): Promise<void> { await db(`UPDATE members SET removed_at=${Date.now()} WHERE id='${member}' AND removed_at IS NULL`); }

export interface Ask { key?: string; question: string; context?: string; options?: { id: string; label: string; detail?: string; cost?: string }[]; status?: string }
export interface Asked { project: string; slug: string; pageId: string; ids: string[]; path: string }
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ulid = () => randomBytes(13).toString('hex').toUpperCase();
export const OPTIONS = [{ id: 'a', label: 'Object storage', detail: 'One region.', cost: 'About $2 a month' }, { id: 'b', label: 'Database blobs', cost: 'About $30 a month' }, { id: 'c', label: 'Keep files on the device' }];

/** A project of its own, which the member is on, and a page in review that asks. */
async function makeAsked(member: string, asks: Ask[], { level = 3, needed = 1, title = 'Photo storage options', lang = 'en', like = 'plain' } = {}): Promise<Asked> {
  const project = `prj_${ulid()}`, slug = `ask-${randomBytes(6).toString('hex')}`, pageId = `pag_${ulid()}`, version = `ver_${ulid()}`, team = `team_${randomUUID()}`, ids = asks.map(() => `dec_${ulid()}`), now = Date.now();
  await db(`INSERT INTO projects(id,slug,name_en,name_ar,created_at,answers_needed) VALUES('${project}','${slug}','Garden app','تطبيق الحديقة',1,${needed})`,
    `INSERT INTO teams(id,name,created_at) VALUES('${team}','${team}',1)`, `INSERT INTO team_projects(team_id,project_id) VALUES('${team}','${project}')`,
    `INSERT INTO team_members(team_id,member_id,level,set_by,set_at) VALUES('${team}','${member}',${level},'o',1)`,
    `INSERT INTO pages(id,project_id,slug,title,lang,status,created_by,created_at,updated_at) VALUES('${pageId}','${project}','page',${text(title)},'${lang}','in_review','a',1,1)`,
    `INSERT INTO page_versions SELECT '${version}','${pageId}',1,v.entry_path,'',v.bytes,v.file_count,v.published_by,v.key_id,1 FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug='${like}' AND p.project_id='p1' AND v.n=1`,
    `INSERT INTO version_files SELECT '${version}',f.path,f.sha256,f.media_type,f.bytes FROM version_files f JOIN page_versions v ON v.id=f.version_id JOIN pages p ON p.id=v.page_id WHERE p.slug='${like}' AND p.project_id='p1' AND v.n=1`,
    ...asks.flatMap((ask, i) => [
      `INSERT INTO decisions(id,page_id,project_id,key,position,status,created_at,updated_at) VALUES('${ids[i]!}','${pageId}','${project}','k${i}',${i},'${ask.status ?? 'open'}',1,${now + i})`,
      `INSERT INTO decision_revisions(decision_id,revision,question,context,options_json,version_n,created_at) VALUES('${ids[i]!}',1,${text(ask.question)},${text(ask.context ?? '')},${text(JSON.stringify(ask.options ?? OPTIONS))},1,1)`]));
  return { project, slug, pageId, ids, path: `/p/${slug}/page` };
}
/** Puts someone else on the project too. */
export async function joinAsked(asked: Asked, member: string, level = 3): Promise<void> {
  await db(`INSERT INTO team_members(team_id,member_id,level,set_by,set_at) SELECT team_id,'${member}',${level},'o',1 FROM team_projects WHERE project_id='${asked.project}'`);
}
async function removeAsked({ project, pageId }: Asked): Promise<void> {
  // Answers go only with a page deleted long ago.
  const own = `(SELECT id FROM decisions WHERE page_id='${pageId}')`;
  await db(`DELETE FROM comments WHERE page_id='${pageId}'`, `UPDATE pages SET deleted_at=1 WHERE id='${pageId}'`, `DELETE FROM decision_answers WHERE decision_id IN ${own}`, `DELETE FROM decision_revisions WHERE decision_id IN ${own}`, `DELETE FROM decisions WHERE page_id='${pageId}'`,
    `DELETE FROM version_files WHERE version_id IN (SELECT id FROM page_versions WHERE page_id='${pageId}')`, `DELETE FROM page_versions WHERE page_id='${pageId}'`, `DELETE FROM pages WHERE id='${pageId}'`,
    `DELETE FROM events WHERE project_id='${project}'`, `DELETE FROM teams WHERE id IN (SELECT team_id FROM team_projects WHERE project_id='${project}')`, `DELETE FROM projects WHERE id='${project}'`);
}

/** `member`: removed when the test ends, also when it fails. A page's own error fails its test. */
export const test = base.extend<{ member: string; noErrors: void; ask: (asks: Ask[], options?: Parameters<typeof makeAsked>[2]) => Promise<Asked> }>({
  member: async ({}, use) => { const id = await makeMember(); await use(id); await leave(id); },
  ask: async ({ member }, use) => {
    const made: Asked[] = [];
    await use(async (asks, options) => { const asked = await makeAsked(member, asks, options); made.push(asked); return asked; });
    for (const asked of made) await removeAsked(asked);
  },
  noErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await use();
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }, { auto: true }],
});
