import { expect } from '@playwright/test';
import { APP, enter, test } from './people';

test('manifest, icons, theme-color, and shell-only service worker work across browsers', async ({ page, member, ask }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const asked = await ask([{ question: 'Which storage?' }], { level: 3 });
  await enter(page.context(), member);
  await page.goto(`${APP}/`);

  // Manifest and icon links are present and theme-color follows dark/light mode.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icon.svg');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#12161a');

  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f6f4ef');
  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#12161a');

  // Manifest and every listed icon load cleanly.
  const manifest = await page.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest');
    return { status: res.status, type: res.headers.get('content-type'), data: await res.json() };
  });
  expect(manifest.status).toBe(200);
  expect(manifest.type).toContain('application/manifest+json');
  for (const icon of manifest.data.icons as { src: string; type: string }[]) {
    const iconRes = await page.request.get(`${APP}${icon.src}`);
    expect(iconRes.status(), icon.src).toBe(200);
    expect(iconRes.headers()['content-type'], icon.src).toContain(icon.type);
  }

  // Wait for the service worker to activate, then visit a page with decisions and comments.
  const swScript = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.scriptURL ?? null;
  });
  expect(swScript).toBe(`${APP}/sw.js`);

  await page.goto(`${APP}${asked.path}`);
  await expect(page.getByText('Which storage?')).toBeVisible();
  await page.goto(`${APP}/decisions`);
  await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible();

  // Cache Storage must hold ONLY the app shell assets — never API responses, page content, or /link.
  const cachedUrls = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) urls.push(new URL(req.url).pathname);
    }
    return { names, urls };
  });
  expect(cachedUrls.names.length).toBe(1);
  expect(cachedUrls.names[0]).toMatch(/^lawh-shell-[0-9a-f]{12}$/);
  expect(cachedUrls.urls).toContain('/');
  expect(cachedUrls.urls).toContain('/manifest.webmanifest');
  expect(cachedUrls.urls).toContain('/icon.svg');
  expect(cachedUrls.urls.some((u) => u.startsWith('/assets/main-'))).toBe(true);
  for (const url of cachedUrls.urls) {
    expect(url).not.toMatch(/^\/(?:app-api|v1|p|link|decisions|comments|settings)\b/);
  }
});
