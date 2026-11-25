import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { activation, APP, enter, join, setActive, test } from './people';

const open = async (page: Page, member: string, slug = 'media') => { await join(member); await enter(page.context(), member); await page.goto(`${APP}/p/one/${slug}`); };
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
    await page.waitForTimeout(500);
  }
  await inside(page).locator('#broken').click();
  await expect(page.getByText('This picture can’t be shown full size.')).toBeVisible();
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

test('a hostile page gets a picture shown at most, and no more', async ({ page, member }) => {
  const messages: string[] = [];
  await page.exposeFunction('note', (text: string) => messages.push(text));
  await page.addInitScript(() => { if (self === top) addEventListener('message', (e) => { if (e.data === 'ran') (window as unknown as { note: (t: string) => void }).note('ran'); }); });
  await activation(page, false);
  await open(page, member, 'media-spam');
  await expect(inside(page).getByText('sent', { exact: true })).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(viewer(page), 'nothing opens by itself').toHaveCount(0);
  // The person did something: now it may ask, like any page with pictures.
  await setActive(page, true);
  await expect(viewer(page)).toBeVisible();
  const first = await label(page).innerText();
  expect(await color(page)).toEqual([255, 0, 0, 255]);
  await page.waitForTimeout(500);
  expect(await label(page).innerText(), 'nothing unasked replaces it').toBe(first);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Pages' })).toBeVisible();
  expect(messages).toEqual([]);
  expect(await (await fetch('http://localhost:8799/hits/viewer-svg')).json()).toEqual([]);
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

for (const lang of ['en', 'ar'] as const) for (const width of [390, 1280]) {
  test(`the viewer fits and is accessible (${lang}, ${width})`, async ({ page, member, browserName }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript((l) => { if (self === top && location.protocol !== 'about:') localStorage.setItem('lawh-lang', l); }, lang);
    await open(page, member);
    await inside(page).locator('#chart').click();
    await color(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    for (const button of await page.locator('dialog.viewer button:visible').all()) { const box = (await button.boundingBox())!; expect(Math.min(box.width, box.height), await button.innerText()).toBeGreaterThanOrEqual(44); }
    expect((await new AxeBuilder({ page }).include('dialog.viewer').exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([]);
    if (process.env.LAWH_SHOTS && browserName === 'chromium') await page.screenshot({ path: `${process.env.LAWH_SHOTS}/viewer-${lang}-${width}.png` });
  });
}
