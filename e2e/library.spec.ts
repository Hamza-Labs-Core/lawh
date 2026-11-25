import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { APP, db, enter, join, test } from './people';

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
  await page.waitForTimeout(1500);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Version 1' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/p/one/forge`);
});

test('a session that ends goes to sign-in at the same address', async ({ page, member }) => {
  await open(page, member, '/p/one/good');
  await expect(frame(page).getByRole('heading', { name: 'First section', level: 1 })).toBeVisible();
  await db(`DELETE FROM sessions WHERE member_id='${member}'`);
  await page.getByRole('button', { name: 'Version 1' }).click();
  await expect(page.getByRole('button', { name: 'Approve from another device' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/p/one/good`);
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
    await page.goto(`${APP}/account`); await expect(page.locator('main h1')).toBeVisible(); await check('account');
  });
}
