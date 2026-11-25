import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { APP, enter, join, test } from './people';

const open = async (page: Page, member: string, slug = 'media') => {
  await join(member); await enter(page.context(), member); await page.goto(`${APP}/p/one/${slug}`);
  // The bridge has marked the pictures: it listens now.
  if (slug.startsWith('media') && slug !== 'media-spam' && slug !== 'media-focus') await expect(inside(page).locator('img').first()).toHaveAttribute('tabindex', '0');
};
const inside = (page: Page) => page.frameLocator('iframe.page-frame');
const viewer = (page: Page) => page.locator('dialog.viewer');
const label = (page: Page) => page.locator('.viewer-label');
const counter = (page: Page) => page.locator('.viewer-bar .muted');

/** Waits until the picture is drawn, and reads the color in the middle of the canvas, or at a place given in thirds. */
async function color(page: Page, at: [number, number] = [0.5, 0.5]): Promise<number[]> {
  await expect(page.locator('dialog.viewer[data-state=shown]')).toBeVisible();
  const frame = page.frames().find((f) => f.url().includes('/_lawh/viewer'))!;
  return frame.evaluate(async ([fx, fy]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('canvas')!;
    return Array.from(canvas.getContext('2d')!.getImageData(Math.round(canvas.width * fx!), Math.round(canvas.height * fy!), 1, 1).data);
  }, at);
}
/** The box of what is drawn, in canvas pixels. */
const drawn = (page: Page) => page.frames().find((f) => f.url().includes('/_lawh/viewer'))!.evaluate(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const canvas = document.querySelector('canvas')!, { data, width, height } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) if (data[(y * width + x) * 4 + 3]! > 0) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  return { width: right - left, height: bottom - top, left, top };
});

test('every kind of picture opens full size, with its name and place', async ({ page, member }) => {
  await open(page, member);
  const cases: [string, string, string, [number, number], number[]][] = [
    ['#photo', 'Two colors', '1 of 7', [0.45, 0.5], [255, 0, 0, 255]],
    ['#file', 'A drawing from a file', '2 of 7', [0.5, 0.5], [0, 170, 0, 255]],
    ['#chart', 'Monthly cost', '3 of 7', [0.45, 0.4], [0, 128, 0, 255]],
    ['#canvas', 'A canvas', '4 of 7', [0.5, 0.5], [128, 0, 128, 255]],
    ['#data', 'Data image', '5 of 7', [0.5, 0.5], [255, 165, 0, 255]],
    ['#pic', 'From a picture', '6 of 7', [0.55, 0.5], [0, 0, 255, 255]],
  ];
  for (const [id, name, place, at, expected] of cases) {
    await inside(page).locator(id).click();
    await expect(label(page)).toHaveText(name);
    await expect(counter(page)).toHaveText(place);
    const got = await color(page, at);
    got.forEach((value, i) => expect(Math.abs(value - expected[i]!), `${id} ${got.join()}`).toBeLessThanOrEqual(3));
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    // As quick as a person.
    await page.waitForTimeout(800);
  }
  await inside(page).locator('#broken').click();
  await expect(page.getByText('This picture can’t be shown full size.')).toBeVisible();
  expect((await drawn(page)).width).toBeLessThan(0);
});

test('what belongs to a link or a control keeps its meaning, and what is marked or tiny does not open', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#button svg').click();
  await inside(page).locator('#off').click();
  await inside(page).locator('#tiny').click();
  await page.waitForTimeout(500);
  await expect(viewer(page)).toHaveCount(0);
  await inside(page).locator('#link img').click();
  await expect(page.getByRole('dialog', { name: 'Open another site?' })).toBeVisible();
});

test('a drawing keeps the colors its page gives it', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#chart').click();
  expect(await color(page, [0.45, 0.4])).toEqual([0, 128, 0, 255]);
  // The page's own background is behind it.
  expect(await color(page, [0.6, 0.35])).toEqual([250, 250, 240, 255]);
});

test('arrows move between pictures and stop at the ends, keys zoom, and the focus returns to the picture', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#file').click();
  await expect(counter(page)).toHaveText('2 of 7');
  await page.keyboard.press('ArrowRight');
  await expect(label(page)).toHaveText('Monthly cost');
  await page.keyboard.press('ArrowLeft'); await expect(counter(page)).toHaveText('2 of 7');
  await page.keyboard.press('ArrowLeft'); await expect(counter(page)).toHaveText('1 of 7');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  await expect(counter(page)).toHaveText('1 of 7');
  await expect(page.getByRole('button', { name: 'Previous picture' })).toBeHidden();
  await page.getByRole('button', { name: 'Next picture' }).click();
  await expect(counter(page)).toHaveText('2 of 7');
  await color(page);
  const before = await drawn(page);
  await page.keyboard.press('+');
  await expect.poll(async () => (await drawn(page)).width).toBeGreaterThan(before.width * 1.2);
  await page.keyboard.press('-'); await page.keyboard.press('-');
  await expect.poll(async () => (await drawn(page)).width).toBeLessThan(before.width);
  await page.getByRole('button', { name: 'Fit' }).click();
  await expect.poll(async () => Math.abs((await drawn(page)).width - before.width)).toBeLessThanOrEqual(4);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(viewer(page)).toHaveCount(0);
  await expect.poll(() => page.frames().find((f) => f.url().includes('/index.html'))!.evaluate(() => document.activeElement?.id)).toBe('file');
});

test('keys work inside the picture too: arrows, zoom and Escape', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  const frame = page.frameLocator('.viewer-frame');
  await frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  const before = await drawn(page);
  await page.keyboard.press('=');
  await expect.poll(async () => (await drawn(page)).width).toBeGreaterThan(before.width);
  await page.keyboard.press('0');
  await expect.poll(async () => Math.abs((await drawn(page)).width - before.width)).toBeLessThanOrEqual(4);
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toHaveText('2 of 7');
  await frame.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
});

test('wheel zooms at the pointer, dragging moves, and two taps fit', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  const box = (await page.locator('.viewer-frame').boundingBox())!, cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const before = await drawn(page);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await drawn(page)).width).toBeGreaterThan(before.width);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(cx, cy);
  await expect.poll(async () => Math.abs((await drawn(page)).width - before.width)).toBeLessThanOrEqual(4);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(400);
  const left = await color(page, [0.48, 0.5]);
  expect(left).toEqual([255, 0, 0, 255]);
  await page.mouse.down(); await page.mouse.move(cx - 120, cy, { steps: 6 }); await page.mouse.up();
  expect(await color(page, [0.48, 0.5])).toEqual([0, 0, 255, 255]);
});

test('the keyboard opens a picture, and Arabic mirrors the arrows', async ({ page, member }) => {
  await page.addInitScript(() => { if (self === top && location.protocol !== 'about:') localStorage.setItem('lawh-lang', 'ar'); });
  await open(page, member);
  await inside(page).locator('#file').press('Enter');
  await expect(counter(page)).toHaveText('٢ من ٧');
  await page.keyboard.press('ArrowLeft');
  await expect(counter(page)).toHaveText('٣ من ٧');
  await page.keyboard.press('ArrowRight');
  await expect(counter(page)).toHaveText('٢ من ٧');
  const next = (await page.getByRole('button', { name: 'الصورة التالية' }).boundingBox())!, previous = (await page.getByRole('button', { name: 'الصورة السابقة' }).boundingBox())!;
  expect(next.x).toBeLessThan(previous.x);
});

test('a hostile page opens nothing by itself, and one that keeps coming back can be stopped', async ({ page, member }) => {
  test.setTimeout(60_000);
  const messages: string[] = [];
  await page.exposeFunction('note', (text: string) => messages.push(text));
  await page.addInitScript(() => { if (self === top) addEventListener('message', (e) => { if (e.data === 'ran') (window as unknown as { note: (t: string) => void }).note('ran'); }); });
  // Through the list, as a person comes: that click is in the app, and doesn't count for the page.
  await join(member); await enter(page.context(), member); await page.goto(APP);
  await page.getByRole('link', { name: /media-spam/ }).click();
  await expect(inside(page).getByText('sent', { exact: true })).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(viewer(page)).toHaveCount(0);
  await inside(page).getByRole('heading').click();
  const stop = page.getByRole('button', { name: 'Stop this page from opening anything' });
  for (let i = 0; i < 6 && !(await stop.isVisible()); i++) {
    await expect(viewer(page)).toBeVisible();
    expect(await color(page)).toEqual([255, 0, 0, 255]);
    const first = await label(page).innerText();
    await page.waitForTimeout(900);
    expect(await label(page).innerText(), 'nothing unasked replaces it').toBe(first);
    if (await stop.isVisible()) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
  }
  await stop.click();
  await page.waitForTimeout(2500);
  await expect(viewer(page)).toHaveCount(0);
  await inside(page).getByRole('heading').click();
  await page.waitForTimeout(1500);
  await expect(viewer(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  expect(messages).toEqual([]);
  expect(await (await fetch('http://localhost:8799/hits/viewer-svg')).json()).toEqual([]);
});

test('a picture in a layout wrapper opens', async ({ page, member }) => {
  await open(page, member, 'media-more');
  await inside(page).locator('#in-layout').click();
  await expect(label(page)).toHaveText('In a layout');
});

test('a page without colors is shown on the color the app has behind it', async ({ page, member }) => {
  await page.addInitScript(() => { if (self === top && location.protocol !== 'about:') localStorage.setItem('lawh-mode', 'light'); });
  await open(page, member, 'plain');
  await inside(page).locator('svg').click();
  expect(await color(page)).toEqual([246, 244, 239, 255]);
});

test('a person who looks at many pictures is not asked to stop the page, also when pressing arrows fast', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  // At once, so the answers come when a later one is wanted.
  await viewer(page).evaluate((dialog) => { for (let i = 0; i < 6; i++) dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  await expect(counter(page)).toHaveText('7 of 7');
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  await inside(page).locator('#file').click();
  await expect(viewer(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop this page from opening anything' })).toHaveCount(0);
});

test('a page that claims the focus and waits cannot keep the Stop button away', async ({ page, member }) => {
  test.setTimeout(90_000);
  await join(member); await enter(page.context(), member); await page.goto(APP);
  await page.getByRole('link', { name: /media-focus/ }).click();
  await page.waitForTimeout(800);
  await inside(page).locator('#go').click();
  const stop = page.getByRole('button', { name: 'Stop this page from opening anything' });
  for (let i = 0; i < 5; i++) {
    await expect(viewer(page)).toBeVisible({ timeout: 12_000 });
    if (await stop.isVisible()) break;
    // The keyboard is the dialog's, also when the page took it (WebKit lets it).
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
  }
  await stop.click();
  await page.waitForTimeout(6000);
  await expect(viewer(page)).toHaveCount(0);
});

test('a drawing keeps its transforms, clips, size, symbols and gradients, on the color behind it', async ({ page, member }) => {
  test.setTimeout(60_000);
  await open(page, member, 'media-more');
  const near = (got: number[], expected: number[], what: string) => got.forEach((value, i) => expect(Math.abs(value - expected[i]!), `${what}: ${got.join()}`).toBeLessThanOrEqual(4));
  const cases: [string, [number, number], number[]][] = [
    ['#modern', [0.5, 0.5], [255, 0, 0, 255]], ['#layers', [0.5, 0.5], [128, 128, 128, 255]],
    ['#moved', [0.6, 0.5], [0, 128, 0, 255]], ['#moved', [0.4, 0.5], [255, 255, 255, 255]],
    ['#clipped', [0.6, 0.5], [0, 128, 0, 255]], ['#clipped', [0.4, 0.5], [255, 255, 255, 255]],
    ['#scaled', [0.6, 0.5], [0, 128, 0, 255]], ['#scaled', [0.4, 0.5], [255, 255, 255, 255]],
    ['#use', [0.4, 0.5], [0, 0, 255, 255]], ['#use', [0.6, 0.5], [255, 0, 255, 255]],
    ['#ext', [0.6, 0.5], [0, 128, 0, 255]], ['#own', [0.5, 0.5], [0, 255, 0, 255]], ['#many', [0.5, 0.5], [0, 0, 255, 255]],
  ];
  for (const [id, at, expected] of cases) {
    await inside(page).locator(id).click({ position: { x: 20, y: 20 } });
    near(await color(page, at), expected, id);
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await page.waitForTimeout(800);
  }
});

test('pictures keep the page’s own cursor, hidden ones are left alone, and one without a name has one in the viewer', async ({ page, member }) => {
  await open(page, member, 'media-more');
  expect(await inside(page).locator('#pan').evaluate((el) => [getComputedStyle(el).cursor, el.getAttribute('tabindex')])).toEqual(['move', '0']);
  expect(await inside(page).locator('#plain').evaluate((el) => getComputedStyle(el).cursor)).toBe('zoom-in');
  expect(await inside(page).locator('#layered').evaluate((el) => [getComputedStyle(el).cursor, el.getAttribute('tabindex')])).toEqual(['help', '0']);
  expect(await inside(page).locator('#hidden-icon').getAttribute('tabindex')).toBeNull();
  await inside(page).locator('#hidden-icon').click();
  await page.waitForTimeout(300);
  await expect(viewer(page)).toHaveCount(0);
  await inside(page).locator('#plain').click();
  await color(page);
  await expect(page.frameLocator('.viewer-frame').getByRole('img', { name: 'Picture' })).toBeVisible();
});

test('moving to a picture that cannot be shown leaves nothing of the one before', async ({ page, member }) => {
  await open(page, member, 'media-more');
  await inside(page).locator('#pan').click();
  await color(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText('This picture can’t be shown full size.')).toBeVisible();
  expect((await drawn(page)).width).toBeLessThan(0);
  await page.keyboard.press('ArrowRight');
  expect(await color(page)).toEqual([0, 0, 255, 255]);
});

test('moving fast ends on the last picture asked for', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft'); }
  await page.waitForTimeout(500);
  expect(await counter(page).innerText()).toBe('1 of 7');
  expect(await color(page, [0.45, 0.5])).toEqual([255, 0, 0, 255]);
});

test('a slow drag is no tap', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  const box = (await page.locator('.viewer-frame').boundingBox())!, cx = box.x + box.width / 2, cy = box.y + box.height / 2, before = await drawn(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down(); await page.mouse.move(cx + 40, cy, { steps: 40 }); await page.mouse.up();
  await page.mouse.click(cx + 40, cy);
  await page.waitForTimeout(400);
  expect(Math.abs((await drawn(page)).width - before.width)).toBeLessThanOrEqual(4);
});

test('the viewer takes what to show from the app only, and sends nothing but keys', async ({ page, member }) => {
  await open(page, member);
  await inside(page).locator('#photo').click();
  await color(page);
  // The page's frame posts to the viewer, as a hostile page could.
  await page.frames().find((f) => f.url().includes('/index.html'))!.evaluate(() => {
    for (let i = 0; i < parent.frames.length; i++) parent.frames[i]!.postMessage({ type: 'lawh:view', kind: 'svg', width: 100, height: 100, label: 'x', background: 'rgb(0,0,0)', text: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="lime"/></svg>' }, '*');
  });
  await page.waitForTimeout(300);
  expect(await color(page, [0.45, 0.5])).toEqual([255, 0, 0, 255]);
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`the viewer fits and is accessible (${lang}, ${mode}, ${width})`, async ({ page, member, browserName }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self === top && location.protocol !== 'about:') { localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); } }, [lang, mode]);
    await open(page, member);
    await inside(page).locator('#chart').click();
    await color(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    for (const button of await page.locator('dialog.viewer button:visible').all()) { const box = (await button.boundingBox())!; expect(Math.min(box.width, box.height), await button.innerText()).toBeGreaterThanOrEqual(44); }
    expect((await new AxeBuilder({ page }).include('dialog.viewer').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([]);
    if (process.env.LAWH_SHOTS && browserName === 'chromium') await page.screenshot({ path: `${process.env.LAWH_SHOTS}/viewer-${lang}-${mode}-${width}.png` });
  });
}
