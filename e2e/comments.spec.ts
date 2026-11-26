import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { APP, type Asked, db, enter, joinAsked, leave, makeMember, test } from './people';

const open = async (page: Page, member: string, path: string) => { await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const wide = (page: Page) => page.setViewportSize({ width: 1280, height: 800 });
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
const ready = (page: Page) => expect(page.frameLocator('.page-frame').locator('h1').first()).toBeVisible();
const opener = (page: Page) => page.locator('.reader-bar').getByRole('button', { name: /^Comments/ });
const thread = (page: Page, text: string) => page.locator('.thread').filter({ hasText: text });
const id = () => `cmt_${randomBytes(13).toString('hex').toUpperCase()}`;
const quoted = (text: string) => text.replaceAll("'", "''");
/** A comment by someone else: a member, or the agent when `member` is null. */
async function write(asked: Asked, member: string | null, body: string, options: { in?: string; section?: string; title?: string; level?: number; at?: number } = {}): Promise<string> {
  const { in: of = '', section = '', level = 2, at = Date.now() } = options, title = options.title ?? section, own = id();
  await db(`INSERT INTO comments(id,page_id,project_id,thread_id,version_n,section_id,section_title,quote,member_id,author_level,agent_id,body,created_at)
    VALUES('${own}','${asked.pageId}','${asked.project}','${of || own}',1,${section ? `'${section}','${quoted(title)}','Begins so'` : 'NULL,NULL,NULL'},${member ? `'${member}',${level},NULL` : "NULL,NULL,'a'"},'${quoted(body)}',${at})`);
  return own;
}
const comments = async (asked: Asked) => (await db(`SELECT * FROM comments WHERE page_id='${asked.pageId}' ORDER BY created_at, id`))[0]!;

test('on a section: the page’s headings are offered, and the thread shows under its heading, which leads there', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' });
  await open(page, member, asked.path); await ready(page);
  await expect(page.locator('.reader-side')).toHaveCount(0);
  await opener(page).click();
  const section = page.getByLabel('Section');
  await expect(section.locator('option')).toHaveText(['Whole page', /First section/, /First section/, /Own id/, /مَرْحَباً بِكُمْ/, /Built in/]);
  await section.selectOption({ index: 5 });
  await page.getByRole('textbox', { name: 'Comment' }).fill('  How long would that take?  ');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(thread(page, 'How long would that take?')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comment' })).toHaveValue('');
  await expect(page.locator('.threads blockquote')).toHaveText('next');
  expect(await comments(asked)).toMatchObject([{ section_id: 'constructor', section_title: 'Built in', quote: 'next', body: 'How long would that take?', version_n: 1, member_id: member, author_level: 3 }]);
  await expect(opener(page)).toHaveText('Comments 1');
  // In a page of its own, the heading can be far down.
  await page.frameLocator('.page-frame').locator('body').evaluate(() => scrollTo(0, 2500));
  await page.locator('.threads').getByRole('button', { name: 'Built in' }).click();
  await expect.poll(() => page.frameLocator('.page-frame').locator('#constructor').evaluate((h) => { const top = h.getBoundingClientRect().top; return top >= -1 && top < innerHeight; })).toBe(true);
  await page.reload(); await ready(page); await opener(page).click();
  await expect(thread(page, 'How long would that take?')).toContainText('You');
});

test('replies from agents and people say who they are from', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), mona = await makeMember('Rami');
  try {
    await joinAsked(asked, mona);
    const first = await write(asked, member, 'How long?', { level: 3, at: 1000 });
    await write(asked, null, 'About 20 minutes.', { in: first, at: 2000 });
    await write(asked, mona, 'That works.', { in: first, level: 3, at: 3000 });
    await open(page, member, asked.path); await ready(page); await opener(page).click();
    const replies = thread(page, 'How long?').locator('.replies .one');
    await expect(replies).toHaveCount(2);
    await expect(replies.first().locator('.who')).toContainText('bot');
    await expect(replies.first().locator('.status')).toHaveText('Agent');
    await expect(replies.nth(1).locator('.who')).toContainText('Rami');
    await expect(replies.nth(1).locator('.status')).toHaveText('Decider');
    await thread(page, 'How long?').getByRole('textbox', { name: 'Reply' }).fill('Good');
    await thread(page, 'How long?').getByRole('button', { name: 'Reply' }).click();
    await expect(replies).toHaveCount(3);
    await expect(replies.nth(2)).toContainText('Good');
  } finally { await leave(mona); }
});

test('resolving moves a thread away, and it can be opened again', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' });
  await write(asked, member, 'Done?', { level: 3 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  await thread(page, 'Done?').getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByText('Resolved: 1')).toBeVisible();
  await expect(opener(page)).toHaveText('Comments 0');
  await expect(thread(page, 'Done?')).toBeHidden();
  await page.getByText('Resolved: 1').click();
  await thread(page, 'Done?').getByRole('button', { name: 'Open again' }).click();
  await expect(opener(page)).toHaveText('Comments 1');
  await page.getByRole('link', { name: 'Comments', exact: true }).click();
  await expect(thread(page, 'Done?')).toBeVisible();
});

test('deleting asks first, and a thread goes with its replies', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), first = await write(asked, member, 'Mine', { level: 3 });
  await write(asked, null, 'An answer', { in: first }); await write(asked, member, 'My reply', { in: first, level: 3 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const it = thread(page, 'Mine');
  await expect(it.getByRole('button', { name: 'Delete' })).toHaveCount(2);
  await it.getByRole('button', { name: 'Delete' }).nth(1).click();
  await it.getByRole('button', { name: 'Cancel' }).click();
  await it.getByRole('button', { name: 'Delete' }).nth(1).click();
  await it.getByRole('button', { name: 'Delete this reply' }).click();
  await expect(it.getByText('My reply')).toHaveCount(0);
  await it.getByRole('button', { name: 'Delete' }).click();
  await it.getByRole('button', { name: 'Delete with its replies' }).click();
  await expect(page.getByText('No comments yet.')).toBeVisible();
  expect((await comments(asked)).every((c) => c.deleted_at !== null)).toBe(true);
});

test('a section the page no longer has is kept under "Earlier sections", with its title and how it began', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' });
  await write(asked, member, 'About something gone', { section: 's-risks', title: 'Risks', level: 3 });
  await write(asked, member, 'About the start', { section: 's-first-section', title: 'Old title', level: 3 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const earlier = page.locator('.threads').filter({ has: page.getByRole('heading', { name: 'Earlier sections' }) });
  await expect(earlier.locator('.thread')).toHaveCount(1);
  await expect(earlier).toContainText('Risks');
  await expect(earlier).toContainText('Begins so');
  await expect(page.locator('.threads').filter({ has: page.getByRole('heading', { name: 'First section' }) })).toContainText('About the start');
});

test('a viewer reads and cannot write', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good', level: 1 });
  const other = await makeMember('Rami');
  try {
    await joinAsked(asked, other, 2);
    await write(asked, other, 'Seen');
    await open(page, member, asked.path); await ready(page); await opener(page).click();
    await expect(thread(page, 'Seen')).toBeVisible();
    await expect(page.getByText('Your level here is to read only.')).toBeVisible();
    await expect(page.locator('.reader-side').getByRole('textbox')).toHaveCount(0);
    await expect(thread(page, 'Seen').getByRole('button')).toHaveCount(0);
  } finally { await leave(other); }
});

test('a failure keeps the text; sent again after a lost reply it is there once', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const field = page.getByRole('textbox', { name: 'Comment' }), add = page.getByRole('button', { name: 'Add comment' });
  await expect(add).toBeDisabled();
  await field.fill('Only once');
  await page.route('**/page/comments', async (route) => { if (route.request().method() !== 'POST') return route.continue(); await route.fetch(); await route.abort(); });
  await add.click();
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await expect(field).toHaveValue('Only once');
  await page.unroute('**/page/comments');
  await add.dblclick();
  await expect(thread(page, 'Only once')).toHaveCount(1);
  expect(await comments(asked)).toHaveLength(1);
});

test('what was lost meanwhile is told', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), first = await write(asked, member, 'Soon gone', { level: 3 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  await db(`UPDATE comments SET deleted_at=1 WHERE id='${first}'`);
  const it = thread(page, 'Soon gone');
  await it.getByRole('textbox', { name: 'Reply' }).fill('Late');
  await it.getByRole('button', { name: 'Reply' }).click();
  await expect(it.getByRole('alert')).toHaveText(/deleted meanwhile/);
  await expect(it.getByRole('textbox', { name: 'Reply' })).toHaveValue('Late');
  await db(`UPDATE team_members SET level=1, set_by='o' WHERE member_id='${member}'`);
  await page.getByRole('textbox', { name: 'Comment' }).fill('No more');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'read only' })).toBeVisible();
});

test('on a phone the comments are a sheet; a section leads to the page; what was written is kept', async ({ page, member, ask }) => {
  await phone(page);
  const asked = await ask([{ question: 'Which?' }], { like: 'good' });
  await write(asked, member, 'Below', { section: 'constructor', title: 'Built in', level: 3 });
  await open(page, member, asked.path); await ready(page);
  await opener(page).click();
  const sheet = page.getByRole('dialog', { name: 'Comments' });
  await sheet.getByRole('textbox', { name: 'Comment' }).fill('Half a thought');
  await sheet.getByRole('button', { name: 'Decisions 1' }).click();
  await expect(page.getByRole('dialog', { name: 'Decisions' }).getByRole('radio').first()).toBeVisible();
  await page.getByRole('button', { name: 'Comments 1' }).last().click();
  await expect(sheet.getByRole('textbox', { name: 'Comment' })).toHaveValue('Half a thought');
  await sheet.getByRole('button', { name: 'Built in' }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => page.frameLocator('.page-frame').locator('#constructor').evaluate((h) => { const top = h.getBoundingClientRect().top; return top >= -1 && top < innerHeight; })).toBe(true);
  await opener(page).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
});

test('beside the page, the panel changes between questions and comments, and closes', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }], { like: 'good' });
  await open(page, member, asked.path); await ready(page);
  const side = page.locator('.reader-side');
  await expect(side.getByRole('heading', { name: 'Which?' })).toBeVisible();
  await opener(page).click();
  await expect(side.getByText('No comments yet.')).toBeVisible();
  await expect(opener(page)).toHaveAttribute('aria-expanded', 'true');
  await side.getByRole('button', { name: 'Decisions 1' }).click();
  await expect(side.getByRole('heading', { name: 'Which?' })).toBeVisible();
  await side.getByRole('button', { name: 'Comments 0' }).click();
  await opener(page).click();
  await expect(side).toHaveCount(0);
  await opener(page).click();
  await expect(side.getByText('No comments yet.')).toBeVisible();
});

test('a page that sends its sections without end, or false ones, changes nothing but the list to choose from', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  await expect(page.getByLabel('Section').locator('option')).toHaveCount(6);
  await page.frameLocator('.page-frame').locator('body').evaluate(() => {
    let n = 0;
    setInterval(() => { for (let i = 0; i < 50; i++) parent.postMessage({ type: 'lawh:outline', items: [{ id: 'x', title: `<b>${n++}</b>`, level: 1 }] }, '*'); }, 5);
  });
  await expect(page.getByLabel('Section').locator('option')).toHaveCount(2);
  const field = page.getByRole('textbox', { name: 'Comment' });
  await field.pressSequentially('Still typing here', { delay: 20 });
  await expect(field).toHaveValue('Still typing here');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(thread(page, 'Still typing here')).toBeVisible();
  expect(await page.locator('.reader-side b').count()).toBe(0);
});

test('text from anyone is text', async ({ page, member, ask }) => {
  await wide(page);
  const evil = '<img src=x onerror="document.title=1"><b>bold</b>';
  const asked = await ask([], { like: 'good', title: evil });
  const first = await write(asked, member, evil, { section: 'gone', title: evil, level: 3 });
  await write(asked, null, evil, { in: first });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  await expect(page.locator('.thread')).toContainText(evil);
  await page.goto(`${APP}/comments`);
  await expect(page.locator('.thread')).toContainText(evil);
  expect(await page.locator('main img, main b').count()).toBe(0);
});

test('the open threads of every project, with their pages, and more on request', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good', title: 'Photo storage' }), other = await ask([], { like: 'good', title: 'Onboarding' });
  for (let i = 0; i < 31; i++) await write(asked, member, `Thread ${i}`, { level: 3, at: 1000 + i });
  await write(other, member, 'Elsewhere', { level: 3, section: 's-first-section', title: 'First section' });
  await open(page, member, '/comments');
  await expect(page.locator('.thread')).toHaveCount(30);
  await expect(page.locator('.thread').first()).toContainText('Elsewhere');
  await expect(page.locator('.thread').first()).toContainText('Section: First section');
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('.thread')).toHaveCount(32);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await page.locator('.thread').first().getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.locator('.thread').first().getByRole('button', { name: 'Open again' })).toBeVisible();
  await page.getByRole('link', { name: 'Onboarding' }).click();
  await expect(page).toHaveURL(`${APP}${other.path}`);
});

test('earlier replies of a long thread come on request, in order, and stay when one is added', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), first = await write(asked, member, 'Long', { level: 3, at: 1 });
  for (let i = 0; i < 60; i++) await write(asked, null, `Reply ${i}.`, { in: first, at: 100 + i });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const replies = page.locator('.replies .one');
  await expect(replies).toHaveCount(50);
  await page.getByRole('button', { name: 'Show earlier replies' }).click();
  await expect(replies).toHaveCount(60);
  await expect(replies.first()).toContainText('Reply 0.');
  await page.getByRole('textbox', { name: 'Reply' }).fill('And one');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(replies).toHaveCount(61);
  await expect(page.getByRole('button', { name: 'Show earlier replies' })).toHaveCount(0);
});

test('earlier replies with equal timestamps and concurrent new replies are all kept', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), first = await write(asked, member, 'Long', { level: 3, at: 1 });
  for (let i = 0; i < 55; i++) await write(asked, null, `Reply ${i}.`, { in: first, at: 100 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const replies = page.locator('.replies .one');
  await expect(replies).toHaveCount(50);
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  await page.route('**/comments/*/replies?cursor=*', async (route) => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Show earlier replies' }).click();
  await page.getByRole('textbox', { name: 'Reply' }).fill('Brand new');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(replies.filter({ hasText: 'Brand new' })).toHaveCount(1);
  release();
  await expect(replies).toHaveCount(56);
  await expect(replies.filter({ hasText: 'Brand new' })).toHaveCount(1);
  // Posting again after all equal-timestamp replies are loaded still keeps every one.
  await page.getByRole('textbox', { name: 'Reply' }).fill('One more');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(replies).toHaveCount(57);
});

test('a delayed reply response does not bring back a reply deleted meanwhile', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([], { like: 'good' }), first = await write(asked, member, 'Root', { level: 3, at: 1 });
  await write(asked, member, 'Old reply', { in: first, level: 3, at: 2 });
  await open(page, member, asked.path); await ready(page); await opener(page).click();
  const replies = page.locator('.replies .one');
  await expect(replies).toHaveCount(1);
  let release!: () => void, fetched!: () => void;
  const gate = new Promise<void>((done) => { release = done; }), got = new Promise<void>((done) => { fetched = done; });
  await page.route('**/comments/*/replies', async (route) => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch({ headers: { ...await route.request().allHeaders(), origin: APP, 'sec-fetch-site': 'same-origin' } });
      fetched();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.getByRole('textbox', { name: 'Reply' }).fill('New reply');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await got;
  // Reopen the panel before deleting, so the delayed response belongs to the earlier mount.
  await opener(page).click();
  await opener(page).click();
  const old = replies.filter({ hasText: 'Old reply' });
  await old.getByRole('button', { name: 'Delete' }).click();
  await old.getByRole('button', { name: 'Delete' }).click();
  await expect(replies).toHaveCount(0);
  release();
  await expect(replies.filter({ hasText: 'New reply' })).toHaveCount(1);
  await expect(replies.filter({ hasText: 'Old reply' })).toHaveCount(0);
});

test('switching tabs keeps the chosen section and on a phone submitting keeps focus off Close', async ({ page, member, ask }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const asked = await ask([{ question: 'Which?' }], { like: 'good' });
  await open(page, member, asked.path); await ready(page);
  await page.getByRole('button', { name: 'Decisions to make: 1' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: /Comments/ }).click();
  await sheet.getByLabel('Section').selectOption('s-first-section');
  await sheet.getByRole('textbox', { name: 'Comment' }).fill('Unsent draft');
  await sheet.getByRole('button', { name: /Decisions/ }).click();
  await sheet.getByRole('button', { name: /Comments/ }).click();
  await expect(sheet.getByLabel('Section')).toHaveValue('s-first-section');
  await expect(sheet.getByRole('textbox', { name: 'Comment' })).toHaveValue('Unsent draft');
  await page.route('**/comments', async (route) => {
    if (route.request().method() === 'POST') { await new Promise((done) => setTimeout(done, 400)); await route.abort(); } else await route.continue();
  });
  await sheet.getByRole('button', { name: 'Add comment' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.activeElement?.textContent)).not.toBe('Close');
  await expect(sheet.getByRole('alert')).toHaveText('No connection.');
  await expect(sheet.getByRole('textbox', { name: 'Comment' })).toBeFocused();
  await expect(sheet.getByRole('textbox', { name: 'Comment' })).toHaveValue('Unsent draft');
});

test('a list that fails can be tried again', async ({ page, member, ask }) => {
  const asked = await ask([], { like: 'good' });
  await write(asked, member, 'Here', { level: 3 });
  await page.route('**/app-api/comments', (route) => route.abort());
  await open(page, member, '/comments');
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/app-api/comments');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(thread(page, 'Here')).toBeVisible();
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`the comment screens fit and are accessible (${lang}, ${mode}, ${width})`, async ({ page, member, ask, browserName }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const ar = lang === 'ar', rami = await makeMember(ar ? 'رامي' : 'Rami'), shots = process.env.LAWH_SHOTS, title = ar ? 'خيارات تخزين الصور' : 'Photo storage options';
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(0);
      for (const target of await page.locator('button:visible, a:visible, textarea:visible, select:visible, summary:visible').all()) {
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height), `${name}: ${(await target.textContent())?.slice(0, 40)}`).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`), name).toEqual([]);
      if (shots && browserName === 'chromium') await page.screenshot({ path: `${shots}/${name}-${lang}-${mode}-${width}.png` });
    };
    try {
      const asked = await ask([{ question: ar ? 'أين تُخزَّن الصور؟' : 'Where should photos be stored?' }], { like: 'good', title, lang });
      await joinAsked(asked, rami);
      await open(page, member, asked.path); await ready(page); await page.locator('.reader-bar button').nth(1).click(); await expect(page.locator('.write')).toBeVisible(); await check('comments-none');
      const first = await write(asked, rami, ar ? 'كم يستغرق نسخ الصور لاحقًا؟' : 'How long would copying every photo take later?', { section: 's-first-section', title: ar ? 'القسم الأول' : 'First section', level: 3, at: Date.now() - 60_000 });
      await write(asked, null, ar ? 'نحو ٢٠ دقيقة لعشرة آلاف صورة.' : 'About 20 minutes for 10,000 photos.', { in: first });
      await write(asked, member, ar ? 'سؤال عن الصفحة كلها.' : 'A question about the whole page.', { level: 3 });
      await write(asked, member, ar ? 'عن قسم أزيل.' : 'About a section that is gone.', { section: 'gone', title: ar ? 'المخاطر' : 'Risks', level: 3 });
      const done = await write(asked, member, ar ? 'انتهى.' : 'Done.', { level: 3 });
      await db(`UPDATE comments SET resolved_at=${Date.now()} WHERE id='${done}'`);
      await page.reload(); await ready(page); await page.locator('.reader-bar button').nth(1).click(); await expect(page.locator('.thread')).toHaveCount(4); await check('comments-page');
      await page.locator('summary').click(); await page.locator('.one .text').first().click(); await check('comments-delete');
      await page.goto(`${APP}/comments`); await expect(page.locator('.thread')).toHaveCount(3); await check('comments');
      await db(`DELETE FROM comments WHERE page_id='${asked.pageId}'`);
      await page.reload(); await expect(page.locator('.empty')).toBeVisible(); await check('comments-empty');
    } finally { await leave(rami); }
  });
}
