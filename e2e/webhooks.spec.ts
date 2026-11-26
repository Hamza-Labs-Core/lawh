import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { APP, enter, enterOwner, test } from './people';

const open = async (page: Page, member: string, path: string) => { await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const wide = (page: Page) => page.setViewportSize({ width: 1280, height: 800 });

test('the owner turns webhooks on, allows a host, and a manager adds, resends, and deletes one', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { level: 4 });
  // Switches are copy-wide, so keep them local to this test instead of mutating shared E2E settings.
  let webhooksOn = false;
  let hosts: string[] = [];
  let items: { id: string; project: { slug: string; name: { en: string; ar: string } }; url: string; eventTypes: string[]; enabled: boolean; createdBy: string; createdAt: number }[] = [];
  let failed: { webhookId: string; eventSeq: number; url: string; project: { slug: string; name: { en: string; ar: string } }; eventType: string; attempts: number; lastCode: number | null; updatedAt: number; eventAt: number }[] = [];

  await page.route('**/app-api/me', async (route) => {
    const response = await route.fetch();
    const data = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...data, webhooks: webhooksOn } });
  });
  await page.route('**/app-api/settings', (route) => route.fulfill({ json: { retention: null, webhooks: webhooksOn, webhookHosts: hosts } }));
  await page.route('**/app-api/switches/webhooks', (route) => {
    webhooksOn = (route.request().postDataJSON() as { on: boolean }).on;
    return route.fulfill({ json: { webhooks: webhooksOn } });
  });
  await page.route('**/app-api/settings/webhook-hosts', (route) => {
    hosts = (route.request().postDataJSON() as { hosts: string[] }).hosts;
    return route.fulfill({ json: { webhookHosts: hosts } });
  });
  await page.route('**/app-api/webhooks', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { hosts, items, failed } });
    const body = route.request().postDataJSON() as { project: string; url: string; eventTypes: string[] };
    const created = {
      id: 'whk_01TEST00000000000000000001',
      project: { slug: body.project, name: { en: 'Garden app', ar: 'تطبيق الحديقة' } },
      url: body.url,
      eventTypes: body.eventTypes,
      enabled: true,
      createdBy: 'Mona',
      createdAt: Date.now(),
    };
    items = [created];
    return route.fulfill({ status: 201, json: { ...created, secret: `whsec_${'A'.repeat(43)}` } });
  });
  await page.route('**/app-api/webhooks/whk_01TEST00000000000000000001', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { enabled?: boolean; eventTypes?: string[] };
      items = items.map((w) => ({ ...w, enabled: body.enabled ?? w.enabled, eventTypes: body.eventTypes ?? w.eventTypes }));
      return route.fulfill({ json: { id: items[0]!.id, enabled: items[0]!.enabled, eventTypes: items[0]!.eventTypes } });
    }
    if (route.request().method() === 'DELETE') {
      items = [];
      failed = [];
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await page.route('**/app-api/webhooks/whk_01TEST00000000000000000001/deliveries/900001/resend', (route) => {
    failed = [];
    return route.fulfill({ status: 202, body: '' });
  });

  await enterOwner(page.context());
  await page.goto(`${APP}/settings/data`);
  const card = page.locator('.card').filter({ hasText: 'Webhooks' });
  await card.getByRole('button', { name: 'Turn webhooks on' }).click();
  await expect(card.getByText('Webhooks are on.')).toBeVisible();
  await card.getByLabel('Allowed hosts (one per line)').fill('hooks.example.com');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved.')).toBeVisible();
  await expect(page.locator('.chips a')).toContainText(['Webhooks']);

  await page.context().clearCookies();
  await open(page, member, '/settings/webhooks');
  const newBtn = page.getByRole('button', { name: 'New webhook' });
  await newBtn.click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(newBtn).toBeFocused();

  await newBtn.click();
  await page.getByLabel('HTTPS address').fill('https://hooks.example.com/lawh');
  await page.getByRole('button', { name: 'Save' }).click();
  const secret = await page.locator('.card').filter({ hasText: 'Signing secret' }).locator('.address').innerText();
  expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: 'Done, hide it' }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(newBtn).toBeFocused();

  const hookCard = page.locator('.card').filter({ hasText: 'https://hooks.example.com/lawh' });
  await expect(hookCard).toContainText('Active');
  await hookCard.getByRole('button', { name: 'Pause' }).click();
  await expect(hookCard).toContainText('Paused');
  await hookCard.getByRole('button', { name: 'Resume' }).click();
  await expect(hookCard).toContainText('Active');

  failed = [{
    webhookId: items[0]!.id,
    eventSeq: 900001,
    url: items[0]!.url,
    project: { slug: asked.slug, name: { en: 'Garden app', ar: 'تطبيق الحديقة' } },
    eventType: 'page.published',
    attempts: 5,
    lastCode: 502,
    updatedAt: Date.now(),
    eventAt: Date.now(),
  }];
  await page.reload();
  const failedSection = page.locator('.card').filter({ hasText: 'Failed deliveries' });
  await expect(failedSection).toContainText('HTTP 502');
  await failedSection.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByText('Failed deliveries')).toHaveCount(0);
  await expect(page.getByText('Queued to send again.')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);

  await hookCard.getByRole('button', { name: 'Delete' }).click();
  await hookCard.getByRole('button', { name: 'Delete for good' }).click();
  await expect(page.getByText('No webhooks yet.')).toBeVisible();
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [320, 390, 1280]) {
  test(`the webhooks screen fits and is accessible (${lang}, ${mode}, ${width})`, async ({ page, member, ask }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const asked = await ask([], { level: 4, lang });
    const now = Date.now();
    await page.route('**/app-api/me', async (route) => {
      const response = await route.fetch();
      const data = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...data, webhooks: true } });
    });
    await page.route('**/app-api/webhooks', (route) => route.fulfill({
      json: {
        hosts: ['hooks.example.com'],
        items: [{
          id: 'whk_01TEST00000000000000000002',
          project: { slug: asked.slug, name: { en: 'Garden app', ar: 'تطبيق الحديقة' } },
          url: 'https://hooks.example.com/lawh',
          eventTypes: ['page.published', 'comment.created'],
          enabled: true,
          createdBy: 'Mona',
          createdAt: now,
        }],
        failed: [{
          webhookId: 'whk_01TEST00000000000000000002',
          eventSeq: 12,
          url: 'https://hooks.example.com/lawh',
          project: { slug: asked.slug, name: { en: 'Garden app', ar: 'تطبيق الحديقة' } },
          eventType: 'page.published',
          attempts: 5,
          lastCode: 502,
          updatedAt: now,
          eventAt: now,
        }],
      },
    }));
    await open(page, member, '/settings/webhooks');
    await expect(page.locator('.address').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    for (const target of await page.locator('button:visible, a:visible, input:not([type=checkbox]):visible, select:visible, .check:visible').all()) {
      const box = (await target.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
    expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
  });
}
