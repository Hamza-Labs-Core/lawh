import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { activation, APP, db, enter, join, setActive, test } from './people';

const open = async (page: Page, member: string, path = '/') => { await join(member); await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const frame = (page: Page) => page.frameLocator('iframe.page-frame');

test('the list filters by status and tag, keeps its filters in the address, and Back undoes them', async ({ page, member }) => {
  await open(page, member);
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  await page.getByLabel('Status').selectOption('In review');
  await expect(page.getByRole('link', { name: /Photo storage options/ })).toBeVisible();
  await expect(page.locator('.grid li')).toHaveCount(1);
  expect(page.url()).toBe(`${APP}/?status=in_review`);
  const tag = page.getByRole('combobox', { name: 'Tag' });
  await tag.fill('we');
  await expect(page.locator('.options [role=option]')).toHaveText(['weather']);
  await tag.press('ArrowDown');
  await tag.press('Enter');
  await expect(page.getByText('No pages match these filters.')).toBeVisible();
  expect(page.url()).toBe(`${APP}/?status=in_review&tag=weather`);
  await page.reload();
  await expect(page.getByText('No pages match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove the tag filter: weather' }).click();
  await expect(page.locator('.grid li')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByText('No pages match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.grid li').nth(5)).toBeVisible();
  expect(page.url()).toBe(`${APP}/`);
});

test('the list shows more on request, without a repeat', async ({ page, member }) => {
  await open(page, member, '/?status=draft');
  await expect(page.locator('.grid li')).toHaveCount(30);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('.grid li').nth(45)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  const titles = await page.locator('.grid h2').allInnerTexts();
  expect(new Set(titles).size).toBe(titles.length);
});

test('someone in no project is told so, and a project of others is not there', async ({ page, member }) => {
  await enter(page.context(), member);
  await page.goto(APP);
  await expect(page.getByText('You’re in no project yet.')).toBeVisible();
  await page.goto(`${APP}/p/one/good`);
  await expect(page.getByText('This page isn’t here, or you can’t see it.')).toBeVisible();
  await page.getByRole('link', { name: 'Pages' }).click();
  await expect(page.getByText('You’re in no project yet.')).toBeVisible();
});

test('a page opens in its sandboxed frame, follows the theme and language, and Back returns to the same list', async ({ page, member }) => {
  await open(page, member, '/?status=in_review');
  await page.getByRole('link', { name: /Photo storage options/ }).click();
  await expect(page.getByRole('heading', { name: 'Photo storage options' })).toBeFocused();
  await expect(frame(page).getByRole('heading', { name: 'First section', level: 1 })).toBeVisible();
  expect(await page.locator('iframe').evaluate((f: HTMLIFrameElement) => [f.getAttribute('sandbox'), f.referrerPolicy, f.title])).toEqual(['allow-scripts', 'no-referrer', 'Page: Photo storage options']);
  await expect(frame(page).locator('html')).toHaveAttribute('data-lawh-mode', 'dark');
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(frame(page).locator('html')).toHaveAttribute('data-lawh-mode', 'light');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(frame(page).locator('html')).toHaveAttribute('data-lawh-lang', 'ar');
  await expect(page.getByRole('button', { name: 'الإصدار ١' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.grid li')).toHaveCount(1);
  expect(page.url()).toBe(`${APP}/?status=in_review`);
});

test('Back on a page opened by its address goes to the list', async ({ page, member }) => {
  await open(page, member, '/p/one/good');
  await expect(frame(page).getByRole('heading', { name: 'First section', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
});

test('old versions open, and say so', async ({ page, member }) => {
  await open(page, member, '/p/one/versions');
  await expect(frame(page).getByRole('heading', { name: 'Second version' })).toBeVisible();
  await page.getByRole('button', { name: 'Version 2' }).click();
  const dialog = page.getByRole('dialog', { name: 'Versions' });
  await expect(dialog.getByRole('link')).toHaveCount(2);
  await expect(dialog.getByText('Second thoughts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Version 2' })).toBeFocused();
  await page.getByRole('button', { name: 'Version 2' }).click();
  await dialog.getByRole('link', { name: /Version 1/ }).click();
  await expect(frame(page).getByRole('heading', { name: 'First version' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/p/one/versions?v=1`);
  await expect(page.getByRole('status').filter({ hasText: 'You’re reading version 1. The current one is 2.' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to the current version' }).click();
  await expect(frame(page).getByRole('heading', { name: 'Second version' })).toBeVisible();
});

test('a link out of a page asks first, with the whole address', async ({ page, member }) => {
  await open(page, member, '/p/one/good');
  await frame(page).locator('#out').click();
  const dialog = page.getByRole('dialog', { name: 'Open another site?' });
  await expect(dialog.getByText('https://example.com/a?b=c')).toBeVisible();
  const link = dialog.getByRole('link', { name: 'Open' });
  expect(await link.evaluate((a: HTMLAnchorElement) => [a.href, a.target, a.rel])).toEqual(['https://example.com/a?b=c', '_blank', 'noopener noreferrer']);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(`${APP}/p/one/good`);
});

test('a hostile page cannot do more than ask to open a link', async ({ page, member }) => {
  await open(page, member, '/p/one/forge');
  await expect(frame(page).getByText('sent', { exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Version 1' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/p/one/forge`);
});

test('a page that asks again and again cannot change the address shown, cover another dialog, or trap the tab', async ({ page, member }) => {
  await activation(page, false);
  await open(page, member, '/p/one/spam');
  const dialog = page.getByRole('dialog', { name: 'Open another site?' });
  await frame(page).getByRole('heading', { name: 'Spam' }).click();
  await page.waitForTimeout(1000);
  await expect(dialog, 'nothing opens before the person does something').toHaveCount(0);
  await setActive(page, true);
  await expect(dialog).toBeVisible();
  const address = await dialog.locator('.address').innerText();
  await page.waitForTimeout(600);
  expect(await dialog.locator('.address').innerText(), 'the address stays the one that was shown').toBe(address);
  expect(await dialog.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(address);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Version 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Versions' })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close' }).click();
  await frame(page).getByRole('heading', { name: 'Spam' }).click();
  await dialog.getByRole('button', { name: 'Stop this page from opening anything' }).click();
  await page.waitForTimeout(1000);
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
});

test('a person can open and cancel several links in a row', async ({ page, member }) => {
  await open(page, member, '/p/one/good');
  const dialog = page.getByRole('dialog', { name: 'Open another site?' });
  await page.context().route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: 'example' }));
  for (let i = 0; i < 6; i++) {
    await frame(page).locator('#out').click();
    const popup = page.context().waitForEvent('page');
    await dialog.getByRole('link', { name: 'Open' }).click();
    await (await popup).close();
    await expect(dialog).toHaveCount(0);
  }
  for (let i = 0; i < 4; i++) {
    await frame(page).locator('#out').click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    // As long as a person takes to aim again.
    await page.waitForTimeout(500);
  }
  await frame(page).locator('#out').click();
  await expect(dialog).toBeVisible();
});

test('a theme or language changed while the page loads reaches it', async ({ page, member }) => {
  await join(member); await enter(page.context(), member);
  let release = () => {}, asked = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { asked = resolve; });
  await page.route('**/app-api/projects/one/pages/good?*', async (route) => { asked(); const response = await route.fetch(); await held; await route.fulfill({ response }); });
  await page.goto(`${APP}/p/one/good`);
  await started;
  await page.getByRole('button', { name: 'Light' }).click();
  await page.getByRole('button', { name: 'العربية' }).click();
  release();
  await expect(frame(page).locator('html')).toHaveAttribute('data-lawh-mode', 'light');
  await expect(frame(page).locator('html')).toHaveAttribute('data-lawh-lang', 'ar');
});

test('choosing the version already shown closes the dialog and adds nothing to the history', async ({ page, member }) => {
  await open(page, member, '/p/one/versions');
  await expect(frame(page).getByRole('heading', { level: 1 })).toBeVisible();
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Version 2' }).click();
  await page.getByRole('dialog').getByRole('link', { name: /Version 2/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test('filters by project, with the tags of that project', async ({ page, member }) => {
  await join(member, 1, true); await enter(page.context(), member);
  await page.goto(APP);
  await page.getByLabel('Project').selectOption('Two');
  await expect(page.locator('.grid li')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /In the second project/ })).toBeVisible();
  const tag = page.getByRole('combobox', { name: 'Tag' });
  await tag.click();
  await expect(page.locator('.options [role=option]')).toHaveText(['second-only']);
  await page.locator('.options [role=option]').first().click();
  await expect(page.getByRole('button', { name: 'Remove the tag filter: second-only' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(tag).toBeFocused();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/app-api/tags?*project=one*', async (route) => { await held; await route.continue(); });
  await tag.click();
  await expect(page.locator('.options [role=option]')).toHaveText(['second-only']);
  await page.getByLabel('Project').selectOption('One');
  await tag.click();
  await page.waitForTimeout(400);
  await expect(page.locator('.options [role=option]:visible'), 'nothing of the other project meanwhile').toHaveCount(0);
  await expect(tag).toHaveAttribute('aria-expanded', 'false');
  release();
  await expect(page.locator('.options [role=option]').filter({ hasText: 'weather' })).toBeVisible();
  await expect(page.locator('.options [role=option]').filter({ hasText: 'second-only' })).toHaveCount(0);
});

test('a filter that is not available can be cleared', async ({ page, member }) => {
  await open(page, member, '/?project=nope');
  await expect(page.getByText('A filter in this address isn’t available.')).toBeVisible();
  await expect(page.getByLabel('Status')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.grid li')).toHaveCount(30);
  await page.goto(`${APP}/?status=bogus`);
  await expect(page.getByText('A filter in this address isn’t available.')).toBeVisible();
});

test('"Show more" of an old list does not touch the new one, and a failure goes away when it works', async ({ page, member }) => {
  await open(page, member, '/?status=draft');
  await expect(page.locator('.grid li')).toHaveCount(30);
  await page.route('**/app-api/pages?*cursor*', (route) => route.abort());
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await expect(page.locator('.grid li')).toHaveCount(30);
  await page.unroute('**/app-api/pages?*cursor*');
  // Twice at once, before the button is drawn as disabled: one page more.
  await page.getByRole('button', { name: 'Show more' }).evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
  await expect(page.locator('.grid li').nth(45)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const titles = await page.locator('.grid h2').allInnerTexts();
  expect(new Set(titles).size).toBe(titles.length);
  await page.reload();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/app-api/pages?*cursor*', async (route) => { await held; await route.abort(); });
  await page.getByRole('button', { name: 'Show more' }).click();
  await page.getByLabel('Status').selectOption('In review');
  await expect(page.locator('.grid li')).toHaveCount(1);
  release();
  await page.waitForTimeout(300);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.grid li')).toHaveCount(1);
});

test('a page keeps room on a small screen with a long title', async ({ page, member }) => {
  await db("INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) SELECT 'long','p1','long','" + 'Long title '.repeat(18) + "','a',1,1 WHERE NOT EXISTS (SELECT 1 FROM pages WHERE id='long')");
  await db("INSERT INTO page_versions SELECT 'ver_LLLLLLLLLLLLLLLLLLLLLLLLLL','long',1,'index.html','',1,1,'a',id,1 FROM agent_keys WHERE NOT EXISTS (SELECT 1 FROM page_versions WHERE page_id='long') LIMIT 1");
  await page.setViewportSize({ width: 320, height: 480 });
  await open(page, member, '/p/one/long');
  await expect(page.locator('iframe')).toBeVisible();
  expect((await page.locator('iframe').boundingBox())!.height).toBeGreaterThanOrEqual(280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

test('a session that ends goes to sign-in at the same address', async ({ page, member }) => {
  await open(page, member, '/p/one/good');
  await expect(frame(page).getByRole('heading', { name: 'First section', level: 1 })).toBeVisible();
  await db(`DELETE FROM sessions WHERE member_id='${member}'`);
  await page.getByRole('button', { name: 'Version 1' }).click();
  await expect(page.getByRole('button', { name: 'Approve from another device' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/p/one/good`);
});

test('projects that fail to load can be tried again, and nobody is told there are no pages meanwhile', async ({ page, member }) => {
  await enter(page.context(), member);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/app-api/projects', async (route) => { await held; await route.abort(); });
  await page.goto(APP);
  await page.waitForTimeout(500);
  await expect(page.locator('.empty')).toHaveCount(0);
  release();
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await expect(page.locator('.empty')).toHaveCount(0);
  await page.unroute('**/app-api/projects');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('You’re in no project yet.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('choosing and clearing a tag leaves no old list', async ({ page, member }) => {
  await open(page, member);
  const tag = page.getByRole('combobox', { name: 'Tag' });
  await tag.fill('we');
  await expect(page.locator('.options [role=option]')).toHaveText(['weather']);
  await page.route('**/app-api/tags?q=st*', () => { /* never answered */ });
  await tag.fill('st');
  await expect(page.locator('.options').getByText('weather'), 'what no longer matches is gone at once').toHaveCount(0);
  await page.unroute('**/app-api/tags?q=st*');
  await tag.fill('we');
  await expect(page.locator('.options [role=option]')).toHaveText(['weather']);
  await tag.press('ArrowDown');
  await tag.press('Enter');
  await page.route('**/app-api/tags?*', () => { /* never answered */ });
  await page.getByRole('button', { name: 'Remove the tag filter: weather' }).click();
  await tag.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.options [role=option]:visible')).toHaveCount(0);
  await tag.press('Enter');
  await expect(tag).toBeVisible();
});

test('a list that fails can be tried again', async ({ page, member }) => {
  await page.route('**/app-api/pages*', (route) => route.abort());
  await open(page, member);
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/app-api/pages*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.grid li')).toHaveCount(30);
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`the reading screens fit and are accessible (${lang}, ${mode}, ${width})`, async ({ page, member, browserName }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const shots = process.env.LAWH_SHOTS;
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(0);
      for (const button of await page.locator('button:visible, a:visible, input:visible, select:visible').all()) {
        const box = (await button.boundingBox())!;
        expect(Math.min(box.width, box.height), `${name}: ${(await button.textContent())?.slice(0, 40)}`).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`), name).toEqual([]);
      if (shots && browserName === 'chromium') await page.screenshot({ path: `${shots}/${name}-${lang}-${mode}-${width}.png` });
    };
    await open(page, member); await expect(page.locator('.grid li').first()).toBeVisible(); await check('library');
    await page.locator('input[role=combobox]').click(); await expect(page.locator('.options [role=option]').first()).toBeVisible(); await check('library-tags');
    await page.goto(`${APP}/?status=decided`); await expect(page.locator('.empty')).toBeVisible(); await check('library-empty');
    await page.goto(`${APP}/p/one/good`); await expect(frame(page).getByRole('heading', { level: 1 })).toBeVisible(); await check('page');
    await frame(page).locator('#out').click(); await expect(page.getByRole('dialog')).toBeVisible(); await check('leave');
    await page.goto(`${APP}/p/one/versions?v=1`); await expect(frame(page).getByRole('heading', { level: 1 })).toBeVisible(); await check('page-old');
    await page.locator('.reader-bar button').last().click(); await expect(page.locator('.versions li').first()).toBeVisible(); await check('versions');
    await page.goto(`${APP}/p/one/versions`); await expect(frame(page).getByRole('heading', { level: 1 })).toBeVisible(); await page.locator('.reader-bar button').last().click(); await expect(page.locator('.versions li').first()).toBeVisible(); await check('versions-current');
    await page.goto(`${APP}/account`); await expect(page.locator('main h1')).toBeVisible(); await check('account');
  });
}
