import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { APP, enterOwner, test } from './people';

test.describe('S20 Settings → Data Live pings switch', () => {
  test('owner toggles live pings on and off (en, ar RTL, axe)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await enterOwner(page.context());

    let liveOn = false;
    await page.route('**/app-api/settings', async (route) => {
      await route.fulfill({ json: { retention: null, webhooks: false, webhookHosts: [], live: liveOn } });
    });
    await page.route('**/app-api/switches/live', async (route) => {
      const body = route.request().postDataJSON() as { on: boolean };
      liveOn = body.on;
      await route.fulfill({ json: { live: liveOn } });
    });

    await page.goto(`${APP}/settings/data`);
    await expect(page.getByRole('heading', { name: 'Live pings' })).toBeVisible();
    await expect(page.getByText('Live pings are off.')).toBeVisible();
    await page.getByRole('button', { name: 'Turn live pings on' }).click();
    await expect(page.getByText('Live pings are on.')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'التنبيهات الفورية' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole('button', { name: 'English' }).click();
    await page.getByRole('button', { name: 'Turn live pings off' }).click();
    await expect(page.getByText('Live pings are off.')).toBeVisible();
  });
});
