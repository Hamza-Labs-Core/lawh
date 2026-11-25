import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type BrowserContext, test as base } from '@playwright/test';

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

export async function leave(member: string): Promise<void> { await db(`UPDATE members SET removed_at=${Date.now()} WHERE id='${member}' AND removed_at IS NULL`); }

/** `member`: removed when the test ends, also when it fails. A page's own error fails its test. */
export const test = base.extend<{ member: string; noErrors: void }>({
  member: async ({}, use) => { const id = await makeMember(); await use(id); await leave(id); },
  noErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await use();
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }, { auto: true }],
});
