import { expect, test as base, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';

const APP = 'http://localhost:8797', CONTENT = 'http://127.0.0.1:8797', TRAP = 'http://localhost:8799';
/** Written again here, so that the tests don't trust the code they test. */
function token(key: string, versionId: string): string {
  const payload = `${versionId}.${(Math.floor(Date.now() / 3_600_000) + 4).toString(36)}`;
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

interface Message { type: string; result?: unknown; [key: string]: unknown }

const test = base.extend<{ harness: Harness }, { ready: { pages: Record<string, string>; contentKey: string }; csp: string }>({
  ready: [async ({}, use) => use(await (await fetch(`${TRAP}/ready`)).json()), { scope: 'worker' }],
  csp: [async ({}, use) => use((await fetch(`${APP}/`)).headers.get('Content-Security-Policy')!), { scope: 'worker' }],
  harness: async ({ page, ready, csp }, use) => use(new Harness(page, ready, csp)),
});

/** The app's page around a published page: the app host's real CSP, and the frame as the app makes it. */
class Harness {
  readonly who = randomUUID();
  constructor(private page: Page, private ready: { pages: Record<string, string>; contentKey: string }, private csp: string) {}

  url(slug: string): string {
    return `${CONTENT}/${token(this.ready.contentKey, this.ready.pages[slug]!)}/index.html?mode=dark&lang=en&who=${this.who}`;
  }

  async open(slug: string): Promise<void> {
    const src = this.url(slug);
    await this.page.context().addCookies([{ name: 'session', value: 'secret', url: APP }, { name: 'session', value: 'secret', url: CONTENT }]);
    await this.page.route(`${APP}/harness`, (route) => route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': this.csp },
      body: `<!doctype html><title>App secret</title><script src="/harness.js"></script><iframe name="page" sandbox="allow-scripts" referrerpolicy="no-referrer" width="600" height="600" src="${src.replaceAll('&', '&amp;')}"></iframe>` }));
    await this.page.route(`${APP}/harness.js`, (route) => route.fulfill({ contentType: 'text/javascript',
      body: "window.messages = []; addEventListener('message', (e) => { if (e.source === document.querySelector('iframe').contentWindow) messages.push({ ...e.data, origin: e.origin }); }); localStorage.setItem('a', 'secret');" }));
    await this.page.goto(`${APP}/harness`);
  }

  messages = (): Promise<Message[]> => this.page.evaluate(() => (window as unknown as { messages: Message[] }).messages);
  async result(): Promise<unknown> {
    await expect.poll(async () => (await this.messages()).some((m) => m.type === 'result'), { timeout: 25_000 }).toBe(true);
    return (await this.messages()).find((m) => m.type === 'result')!.result;
  }
  hits = async (): Promise<string[]> => (await fetch(`${TRAP}/hits/${this.who}`)).json() as Promise<string[]>;
}

test('a page works: its own scripts, styles, images and data load, in an opaque origin', async ({ harness }) => {
  await harness.open('good');
  expect(await harness.result()).toEqual({ module: 42, style: 'rgb(1, 2, 3)', mode: 'dark', lang: 'en', origin: 'null', fetched: 'yes', image: 7 });
  expect((await harness.messages()).every((m) => m.origin === 'null')).toBe(true);
});

test('the trap records what a browser sends it, from a page that no sandbox holds', async ({ harness, page }) => {
  await page.route(`${APP}/free`, (route) => route.fulfill({ contentType: 'text/html', body: `<iframe src="${CONTENT}/free"></iframe>` }));
  await page.route(`${CONTENT}/free`, (route) => route.fulfill({ contentType: 'text/html', body: `<img src="${TRAP}/${harness.who}/img"><script>fetch('${TRAP}/${harness.who}/fetch', { mode: 'no-cors' })</script>` }));
  await page.goto(`${APP}/free`);
  await expect.poll(async () => (await harness.hits()).sort()).toEqual(['fetch', 'img']);
});

test('a hostile page reads nothing and sends nothing', async ({ harness, page }) => {
  test.setTimeout(60_000);
  const popups: string[] = [];
  page.context().on('page', (p) => popups.push(p.url()));
  page.on('dialog', (d) => { popups.push(`dialog ${d.message()}`); void d.dismiss(); });
  await harness.open('attack');
  const result = await harness.result() as Record<string, string>;
  expect(result['own file'], 'the fixture ran').toBe('works');
  expect(Object.keys(result).length).toBeGreaterThan(30);
  const { 'own file': _, ...rest } = result;
  expect(Object.entries(rest).filter(([, value]) => value !== 'error' && value !== 'nothing')).toEqual([]);
  expect(await harness.hits()).toEqual([]);
  expect(popups).toEqual([]);
  expect(page.url()).toBe(`${APP}/harness`);
});

for (const slug of ['nav-self', 'nav-top', 'nav-meta', 'nav-form', 'nav-link']) {
  test(`a page cannot leave by ${slug}`, async ({ harness, page }) => {
    const popups: string[] = [];
    page.context().on('page', (p) => popups.push(p.url()));
    page.on('download', (d) => popups.push(`download ${d.url()}`));
    await harness.open(slug);
    expect(await harness.result()).toBe('ran');
    await page.waitForTimeout(2500);
    expect(await harness.hits()).toEqual([]);
    expect(popups).toEqual([]);
    expect(page.url()).toBe(`${APP}/harness`);
    expect(await page.title()).toBe('App secret');
  });
}

test('the bridge tells the outline, scrolling and outside links, and takes the theme from its parent only', async ({ harness, page }) => {
  await harness.open('good');
  await harness.result();
  const of = async (type: string) => (await harness.messages()).filter((m) => m.type === type);
  expect((await of('lawh:outline'))[0]!.items).toEqual([{ id: 's-first-section', title: 'First section', level: 1 }, { id: 's-first-section-2', title: 'First section', level: 2 }, { id: 'own', title: 'Own id', level: 3 },
    { id: 's-مرحبا-بكم', title: 'مَرْحَباً بِكُمْ', level: 2 }, { id: 'constructor', title: 'Built in', level: 2 }]);
  const frame = page.frame('page')!;
  await frame.evaluate(() => scrollTo(0, 500));
  await expect.poll(async () => (await of('lawh:scroll-state')).some((m) => m.top === 500)).toBe(true);
  await frame.evaluate(() => scrollTo(0, 0));
  await frame.locator('#out').click();
  await expect.poll(async () => (await of('lawh:open-link')).map((m) => m.url)).toEqual(['https://example.com/a?b=c']);
  await frame.locator('#bad').click();
  await frame.locator('#in').click();
  expect(await frame.evaluate(() => [document.title, location.hash])).toEqual(['Good', '#own']);
  expect((await of('lawh:open-link')).length).toBe(1);
  // Links in a drawing and in an image map are outside links like any other.
  for (const [i, id] of ['svg', 'xlink', 'area'].entries()) {
    await frame.evaluate((x) => document.getElementById(x)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), id);
    await expect.poll(async () => (await of('lawh:open-link')).map((m) => m.url)).toHaveLength(i + 2);
  }
  expect((await of('lawh:open-link')).slice(1).map((m) => m.url)).toEqual(['https://example.com/svg', 'https://example.com/xlink', 'https://example.com/area']);
  await frame.evaluate(() => document.getElementById('long')!.click());
  await page.evaluate(() => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'lawh:theme', mode: 'light', lang: 'ar' }, '*'));
  await expect.poll(() => frame.evaluate(() => [document.documentElement.dataset.lawhMode, document.documentElement.dataset.lawhLang])).toEqual(['light', 'ar']);
  expect((await of('lawh:open-link')).length).toBe(4);
  // Another query, or another file of the page, keeps them.
  await frame.evaluate(() => { const a = document.createElement('a'); a.href = '?tab=2'; document.body.append(a); a.click(); });
  await expect.poll(() => page.frame('page')!.evaluate(() => [new URLSearchParams(location.search).get('tab'), document.documentElement.dataset.lawhMode, document.documentElement.dataset.lawhLang])).toEqual(['2', 'light', 'ar']);
  await page.frame('page')!.locator('#next').click();
  await expect.poll(() => page.frame('page')!.evaluate(() => [location.pathname.split('/').at(-1), document.documentElement.dataset.lawhMode, document.documentElement.dataset.lawhLang])).toEqual(['next.html', 'light', 'ar']);
});

test('a page cannot give itself a theme, and its forged messages are only messages', async ({ harness, page }) => {
  await harness.open('forge');
  expect(await harness.result()).toBe('dark');
  expect(page.url()).toBe(`${APP}/harness`);
  expect((await harness.messages()).length).toBeGreaterThan(5);
});

test('another site cannot frame a page', async ({ harness, page }) => {
  const src = harness.url('good');
  await page.route('http://other.localhost:8797/', (route) => route.fulfill({ contentType: 'text/html', body: `<script>window.got = 0; addEventListener('message', () => { got++; });</script><iframe src="${src.replaceAll('&', '&amp;')}"></iframe>` }));
  await page.goto('http://other.localhost:8797/');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { got: number }).got)).toBe(0);
});

test('a page does not open in its own tab, also when the frame has it in the cache', async ({ harness, page }) => {
  await harness.open('good');
  await harness.result();
  for (const path of ['index.html', 'dot.svg']) {
    const response = await page.goto(harness.url('good').replace('index.html', path));
    expect([path, response!.status()]).toEqual([path, 404]);
  }
  await page.goto(harness.url('attack'));
  await page.waitForTimeout(3000);
  expect(await harness.hits()).toEqual([]);
});

test('whether a page can use WebRTC is recorded', async ({ harness, page }) => {
  await harness.open('good');
  await harness.result();
  const rtc = await page.frame('page')!.evaluate(async () => {
    try {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:localhost:8799' }] });
      peer.createDataChannel('x');
      await peer.setLocalDescription(await peer.createOffer());
      return 'allowed';
    } catch { return 'blocked'; }
  });
  test.info().annotations.push({ type: 'WebRTC', description: rtc });
});
