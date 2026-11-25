import { expect, type Page } from '@playwright/test';
import { APP, enter, join, test } from './people';

const open = async (page: Page, member: string, path = '/') => { await join(member, 1, true); await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const field = (page: Page) => page.getByRole('combobox', { name: 'Search' });
const options = (page: Page) => page.locator('.search .options [role=option]');

test('matching pages show while typing, and one is opened with the keyboard', async ({ page, member }) => {
  await open(page, member);
  await field(page).pressSequentially('photo sto', { delay: 30 });
  await expect(options(page)).toHaveCount(1);
  await expect(options(page)).toContainText('Photo storage options');
  await field(page).press('ArrowDown');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  await field(page).press('Enter');
  await expect(page).toHaveURL(`${APP}/p/one/good`);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
});

test('Enter shows every match in the list, with the other filters, and the address keeps it', async ({ page, member }) => {
  await open(page, member);
  await field(page).fill('section');
  await field(page).press('Enter');
  await expect(page).toHaveURL(`${APP}/?q=section`);
  await expect(page.locator('.grid li').filter({ hasText: 'Photo storage options' })).toHaveCount(1);
  await expect(page.locator('.options:visible')).toHaveCount(0);
  await page.getByLabel('Status').selectOption('In review');
  await expect(page).toHaveURL(`${APP}/?q=section&status=in_review`);
  await expect(page.locator('.grid li')).toHaveCount(1);
  await page.reload();
  await expect(field(page)).toHaveValue('section');
  await expect(page.locator('.grid li')).toHaveCount(1);
  await page.getByLabel('Status').selectOption('Draft');
  await page.goBack();
  await field(page).fill('');
  await expect(page).toHaveURL(`${APP}/?status=in_review`);
  await page.goBack();
  await expect(field(page)).toHaveValue('section');
});

test('Arabic is found however it is written', async ({ page, member }) => {
  await open(page, member);
  for (const q of ['مقارنه', 'مُقارَنة', 'الطقس', 'مرحبا']) {
    await field(page).fill(q);
    await expect(options(page).first(), q).toContainText(q === 'مرحبا' ? 'Photo storage options' : 'مقارنة مزوّدي الطقس');
  }
});

test('no match is told, Escape closes the list, and a click opens a page', async ({ page, member }) => {
  await open(page, member);
  await field(page).fill('zzzz');
  await expect(options(page)).toHaveText(['No pages match these filters.']);
  await field(page).press('Escape');
  await expect(options(page).first()).toBeHidden();
  await expect(field(page)).toHaveValue('zzzz');
  await field(page).press('Enter');
  await expect(page.locator('.empty')).toContainText('No pages match these filters.');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(field(page)).toHaveValue('');
  await field(page).fill('photo');
  await options(page).first().click();
  await expect(page).toHaveURL(`${APP}/p/one/good`);
});

test('a late answer for an earlier text is not shown', async ({ page, member }) => {
  await open(page, member);
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => { release = done; });
  await page.route('**/app-api/pages?q=pho&**', async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }).catch(() => undefined); });
  await field(page).fill('pho');
  await page.waitForTimeout(400);
  await field(page).fill('zzzz');
  await expect(options(page)).toHaveText(['No pages match these filters.']);
  release();
  await page.waitForTimeout(300);
  await expect(options(page)).toHaveText(['No pages match these filters.']);
});

test('what others have is not found', async ({ page, member }) => {
  await join(member); await enter(page.context(), member); await page.goto(`${APP}/?q=zebra`);
  await expect(page.locator('.empty')).toBeVisible();
  await join(member, 1, true);
  await page.reload();
  await expect(page.locator('.grid li')).toHaveText([/In the second project/]);
});
