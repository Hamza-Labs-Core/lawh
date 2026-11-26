import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { APP, db, enter, enterOwner, removeAgents, test } from './people';

const open = async (page: Page, member: string, path: string) => { await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const wide = (page: Page) => page.setViewportSize({ width: 1280, height: 800 });

test('a key is made in the browser, shown once, works, and is revoked after a second press', async ({ page, member, ask, browserName }) => {
  await wide(page);
  await ask([], { level: 4 });
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  try {
    await open(page, member, '/settings/agents');
    await expect(page.getByText('No agents yet.')).toBeVisible();
    const newKey = page.getByRole('button', { name: 'New key for CI or a container' });
    await newKey.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(newKey).toBeFocused();
    await newKey.click();
    const make = page.getByRole('button', { name: 'Make the key' });
    await expect(make).toBeDisabled();
    await page.getByLabel('Agent', { exact: true }).fill('ci');
    await page.getByLabel('Where it is for (optional)').fill('Build server');
    await page.getByLabel('Garden app').check();
    await page.getByLabel('Publish pages').uncheck();
    const sent = page.waitForRequest('**/app-api/agent-keys');
    await make.click();
    const body = (await sent).postDataJSON() as Record<string, unknown>;
    const key = await page.locator('.address').innerText();
    expect(key).toMatch(/^lawh_key_[0-9A-Z]{26}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(body), 'the server never gets the secret').not.toContain(key.slice(-43));
    expect((await fetch(`${APP}/v1/me`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json() as Promise<{ scopes: string[] }>)).scopes).not.toContain('pages:write');
    await page.getByRole('button', { name: 'Copy' }).click();
    if (browserName === 'chromium') { await expect(page.getByText('Copied.')).toBeVisible(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key); }
    await page.getByRole('button', { name: 'Done, hide it' }).click();
    await expect(page.getByText(key)).toHaveCount(0);
    await expect(newKey).toBeFocused();
    const card = page.locator('.card').filter({ hasText: 'Build server' });
    await expect(card).toContainText('Garden app');
    await expect(card).toContainText('Read pages, Read decisions, Read comments, Reply to comments');
    await card.getByRole('button', { name: 'Revoke' }).click();
    await card.getByRole('button', { name: 'Cancel' }).click();
    await card.getByRole('button', { name: 'Revoke' }).click();
    await card.getByRole('button', { name: 'Revoke for good' }).click();
    await expect(card.getByText('Revoked')).toBeVisible();
    expect((await fetch(`${APP}/v1/me`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(401);
    await card.getByRole('button', { name: 'Turn this agent off' }).click();
    await expect(card.getByRole('button', { name: 'Turn this agent on' })).toBeVisible();
  } finally { await removeAgents(member); }
});

test('a failed key says why and keeps the form', async ({ page, member, ask }) => {
  await wide(page);
  await ask([], { level: 4 });
  await open(page, member, '/settings/agents');
  await page.getByRole('button', { name: 'New key for CI or a container' }).click();
  await page.getByLabel('Agent', { exact: true }).fill('late');
  await page.getByLabel('Garden app').check();
  await db(`UPDATE team_members SET level=3, set_by='o' WHERE member_id='${member}'`);
  await page.getByRole('button', { name: 'Make the key' }).click();
  await expect(page.getByRole('alert')).toHaveText('Your level doesn’t allow this.');
  await expect(page.getByLabel('Agent', { exact: true })).toHaveValue('late');
});

test('who sees which settings', async ({ page, member, ask }) => {
  await wide(page);
  await ask([], { level: 3 });
  await open(page, member, '/settings');
  await expect(page.locator('.chips a')).toHaveText(['Account']);
  await page.goto(`${APP}/settings/data`);
  await expect(page.getByRole('heading', { name: 'Signed in as Mona' })).toBeVisible();
  await db(`UPDATE team_members SET level=4, set_by='o' WHERE member_id='${member}'`);
  await page.reload();
  await expect(page.locator('.chips a')).toHaveText(['Account', 'Agents and keys', 'Deleted pages']);
});

test('a manager changes a page’s status, deletes it after a second press, and brings it back', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }], { level: 4 });
  await open(page, member, asked.path);
  await page.getByRole('button', { name: 'Page: In review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Page' });
  await dialog.getByRole('button', { name: 'Archived' }).click();
  await expect(dialog.getByRole('button', { name: 'Archived' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Page: Archived' })).toBeFocused();
  await page.getByRole('button', { name: 'Page: Archived' }).click();
  await dialog.getByRole('button', { name: 'Delete this page' }).click();
  await dialog.getByRole('button', { name: 'Delete: it can be restored for 30 days' }).click();
  await expect(page).toHaveURL(`${APP}/`);
  await expect(page.getByText('No pages here yet.')).toBeVisible();
  await page.goto(`${APP}/settings/deleted`);
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Restored: Photo storage options')).toBeVisible();
  await expect(page.getByText('No deleted pages.')).toBeVisible();
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(`${APP}${asked.path}`);
  await expect(page.getByRole('button', { name: 'Page: Archived' })).toBeVisible();
});

test('below manager, a page has no such controls', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { level: 3 });
  await open(page, member, asked.path);
  await expect(page.locator('.reader-bar .status')).toHaveText('In review');
  await expect(page.locator('.reader-bar').getByRole('button', { name: /^Page/ })).toHaveCount(0);
});

test('a device is signed out from another, and the last passkey stays', async ({ page, member, browser }) => {
  await wide(page);
  await open(page, member, '/settings');
  const token = randomBytes(32).toString('base64url'), hash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
  await db(`INSERT INTO sessions(token_sha256,member_id,label,created_at,last_seen_at,expires_at,passkey_id) SELECT '${hash}','${member}','Old phone',1,${Date.now()},${Date.now() + 600_000},credential_id FROM passkeys WHERE member_id='${member}'`);
  await page.reload();
  const row = page.locator('.rows li').filter({ hasText: 'Old phone' });
  await row.getByRole('button', { name: 'Sign out there' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('This device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  const other = await browser.newContext();
  try {
    await other.addCookies([{ name: 'lawh-local', value: token, url: APP, httpOnly: true, sameSite: 'Lax' }]);
    expect((await other.request.get(`${APP}/app-api/me`)).status()).toBe(401);
  } finally { await other.close(); }
});

test('the owner adds and renames a project', async ({ page }) => {
  await wide(page);
  const slug = `new-${randomBytes(5).toString('hex')}`;
  await enterOwner(page.context());
  try {
    await page.goto(`${APP}/settings/projects`);
    await page.getByRole('button', { name: 'New project' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Address')).toBeFocused();
    await page.getByLabel('Address').fill('One');
    await page.getByLabel('Name in English').fill('Garden app');
    await page.getByLabel('Name in Arabic').fill('تطبيق الحديقة');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toHaveText('That address is taken.');
    await page.getByLabel('Address').fill(slug);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    const card = page.locator('.card').filter({ hasText: slug });
    await card.getByRole('button', { name: 'Rename' }).click();
    const name = page.locator('form').getByLabel('Name in English');
    await name.fill('Yard');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.card').filter({ hasText: slug })).toContainText('Yard');
  } finally { await db(`DELETE FROM projects WHERE slug='${slug}'`); }
});

test('the owner sets how many versions are kept, warned before any go, and downloads everything', async ({ page }) => {
  await wide(page);
  await enterOwner(page.context());
  // The setting is the whole copy's, so it isn't changed here.
  let keep: number | null = null;
  await page.route('**/app-api/settings', (route) => route.fulfill({ json: { retention: keep } }));
  await page.route('**/app-api/settings/retention', (route) => { keep = (route.request().postDataJSON() as { keep: number | null }).keep; return route.fulfill({ json: { retention: keep } }); });
  await page.goto(`${APP}/settings/data`);
  const select = page.getByLabel('How many versions each page keeps'), save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await select.selectOption('20');
  await expect(page.getByText(/removed for good/)).toBeVisible();
  await save.click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(keep).toBe(20);
  await select.selectOption('50');
  await expect(page.getByText(/removed for good/)).toHaveCount(0);
  await select.selectOption('All');
  await save.click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(keep).toBeNull();
  const rows = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download the rows' }).click();
  expect((await rows).suggestedFilename()).toBe('lawh-rows.zip');
  await page.getByRole('button', { name: 'List the files' }).click();
  const files = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download', exact: true }).first().click();
  const path = await (await files).path();
  expect((await import('node:child_process')).execFileSync('unzip', ['-tq', path]).toString()).toContain('No errors detected');
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`the settings screens fit and are accessible (${lang}, ${mode}, ${width})`, async ({ page, member, ask, browserName }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const ar = lang === 'ar', shots = process.env.LAWH_SHOTS;
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(0);
      for (const target of await page.locator('button:visible, a:visible, input:not([type=checkbox]):visible, select:visible, .check:visible').all()) {
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height), `${name}: ${(await target.textContent())?.slice(0, 40)}`).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`), name).toEqual([]);
      if (shots && browserName === 'chromium') await page.screenshot({ path: `${shots}/${name}-${lang}-${mode}-${width}.png` });
    };
    const asked = await ask([], { level: 4, title: ar ? 'خيارات تخزين الصور' : 'Photo storage options', lang });
    try {
      const agent = `agt_${randomBytes(13).toString('hex').toUpperCase()}`, key = (i: number) => `key_${randomBytes(12).toString('hex').toUpperCase()}0${i}`, k = [key(1), key(2)];
      await db(`INSERT INTO agents(id,member_id,name,created_at) VALUES('${agent}','${member}','claude-laptop',1)`,
        ...k.map((id, i) => `INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at,label) VALUES('${id}','${agent}','h','["pages:read","pages:write","decisions:read"]',${i},${Date.now() + 90 * 86_400_000},'${i ? 'laptop' : 'home-server'}')`),
        ...k.map((id) => `INSERT INTO agent_key_projects VALUES('${id}','${asked.project}')`), `UPDATE agent_keys SET revoked_at=${Date.now()} WHERE id='${k[0]!}'`);
      await open(page, member, '/settings'); await expect(page.locator('.rows li').first()).toBeVisible(); await check('settings-account');
      await page.goto(`${APP}/settings/agents`); await expect(page.locator('.rows li')).toHaveCount(2); await check('settings-agents');
      await page.locator('.primary').first().click(); await expect(page.locator('.check')).toHaveCount(6); await check('settings-key');
      await page.locator('form input').first().fill('ci'); await page.locator('.check').first().click(); await page.locator('form .primary').click(); await expect(page.locator('.address')).toBeVisible();
      await page.locator('.address').evaluate((p) => { p.textContent = 'lawh_key_00000000000000000000000000_example'; }); await check('settings-key-made');
      await page.goto(`${APP}${asked.path}`); await page.locator('.reader-bar [aria-haspopup=dialog]').first().click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.locator('dialog .plain').first().click(); await check('page-manage');
      await db(`UPDATE pages SET deleted_at=${Date.now()} WHERE id='${asked.pageId}'`);
      await page.goto(`${APP}/settings/deleted`); await expect(page.locator('.rows li')).toHaveCount(1); await check('settings-deleted');
      await page.context().clearCookies(); await enterOwner(page.context());
      await page.goto(`${APP}/settings/data`); await expect(page.locator('select')).toBeVisible(); await page.locator('select').selectOption('10'); await check('settings-data');
      await page.goto(`${APP}/settings/projects`); await expect(page.locator('.card').first()).toBeVisible(); await page.locator('.primary.fit').click(); await check('settings-projects');
    } finally { await removeAgents(member); }
  });
}
