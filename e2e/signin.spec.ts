import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { APP, enter, leave, makeLink, makeMember, test } from './people';

test('a wrong link says so', async ({ page }) => {
  await page.goto(`${APP}/link#nope`);
  await expect(page.getByText('This link doesn’t work.')).toBeVisible();
});

test('another device signs in with a code', async ({ page, browser, member }) => {
  const other = await browser.newContext(), device = await other.newPage();
  try {
    await enter(page.context(), member);
    await device.goto(APP);
    await device.getByRole('button', { name: 'Approve from another device' }).click();
    const code = await device.locator('p.code').innerText();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    await page.goto(`${APP}/approve`);
    await page.getByLabel('Type the code the other device shows.').fill('BBBB-BBBB');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('That code doesn’t work.');
    await page.getByLabel('Type the code the other device shows.').fill(code.toLowerCase());
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: /^Sign in .+ as you\?$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Sign in/ }), 'the new step takes the focus').toBeFocused();
    if (process.env.LAWH_SHOTS) await page.screenshot({ path: `${process.env.LAWH_SHOTS}/approve-2-en-dark-${test.info().project.name}.png` });
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status')).toHaveText('Approved. The other device is signing in.');
    await expect(device.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Approve from another device' })).toBeVisible();
    await device.reload();
    await expect(device.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
  } finally { await other.close(); }
});

test('a code that runs out says so, also without a connection', async ({ page }) => {
  await page.clock.install();
  await page.goto(`${APP}/device`);
  await expect(page.locator('p.code')).toBeVisible();
  await page.route('**/app-api/device/claim', (route) => route.abort());
  for (let i = 0; i < 12; i++) { await page.clock.runFor(30_000); await page.waitForTimeout(50); }
  await expect(page.getByText('The code is too old.')).toBeVisible();
  await page.unroute('**/app-api/device/claim');
  await page.getByRole('button', { name: 'New code' }).click();
  await expect(page.locator('p.code')).toBeVisible();
});

test('an approval that fails for a moment can be tried again, and one without a session goes to sign-in', async ({ page, member }) => {
  await enter(page.context(), member);
  await page.goto(`${APP}/approve`);
  await page.route('**/app-api/device/look', (route) => route.fulfill({ contentType: 'application/json', body: '{"id":"dev_x","label":"Firefox","createdAt":1}' }));
  await page.getByLabel('Type the code the other device shows.').fill('BBBB-BBBB');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.route('**/app-api/device/approve', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert')).toHaveText('That did not work. Try again.');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.unroute('**/app-api/device/approve');
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Approve from another device' })).toBeVisible();
});

test('a screen change takes the focus to its heading, and Back works', async ({ page }) => {
  await page.goto(APP);
  await page.getByRole('button', { name: 'Approve from another device' }).click();
  await expect(page.getByRole('heading', { name: 'Approve from another device' })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Lawh' })).toBeFocused();
});

test('language and theme are kept, and Arabic is right to left', async ({ page }) => {
  await page.goto(APP);
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByRole('button', { name: 'فاتح' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  await page.getByRole('button', { name: 'الموافقة من جهاز آخر' }).click();
  await expect(page.getByText('يعمل لمدة ٥ دقائق.')).toBeVisible();
  await expect(page).toHaveTitle('لوح');
});

test('says so when there is no connection', async ({ page }) => {
  await page.route('**/app-api/me', (route) => route.abort());
  await page.goto(APP);
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/app-api/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Approve from another device' })).toBeVisible();
});

test('a link that cannot be checked right now is not called bad', async ({ page }) => {
  for (const [status, text] of [[429, 'Too many tries. Wait a minute.'], [500, 'That did not work. Try again.']] as const) {
    let asked = 0;
    await page.route('**/app-api/link/options', (route) => { asked++; return route.fulfill({ status, contentType: 'application/json', body: '{"code":"x"}' }); });
    await page.goto('about:blank');
    await page.goto(`${APP}/link#nope`);
    await expect(page.getByRole('alert')).toHaveText(text);
    await page.waitForLoadState('networkidle');
    expect(asked, 'asked once').toBe(1);
    await page.unroute('**/app-api/link/options');
  }
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('This link doesn’t work.')).toBeVisible();
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`every screen fits and is accessible (${lang}, ${mode}, ${width})`, async ({ page, member, browserName }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(([l, m]) => { if (location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const shots = process.env.LAWH_SHOTS;
    const check = async (name: string) => {
      await expect(page.locator('main h1, main p').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(0);
      for (const button of await page.locator('button:visible, a:visible, input:visible').all()) {
        const box = (await button.boundingBox())!;
        expect(Math.min(box.width, box.height), `${name}: ${await button.innerText()}`).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`), name).toEqual([]);
      if (shots && browserName === 'chromium') await page.screenshot({ path: `${shots}/${name}-${lang}-${mode}-${width}.png` });
    };
    await page.goto(APP); await check('sign-in');
    await page.locator('button.wide').click(); await expect(page.locator('p.code')).toBeVisible(); await check('device');
    await page.goto(`${APP}/link#nope`); await expect(page.locator('main p')).toBeVisible(); await check('bad-link');
    await page.goto('about:blank');
    await page.goto(`${APP}/link#${await makeLink(member)}`); await expect(page.locator('main .primary')).toBeVisible(); await check('link');
    const fresh = await makeMember();
    await enter(page.context(), fresh);
    await page.goto(APP); await expect(page.locator('main h1')).toBeVisible(); await check('home');
    await page.goto(`${APP}/approve`); await expect(page.locator('#code')).toBeVisible(); await check('approve');
    await leave(fresh);
  });
}
