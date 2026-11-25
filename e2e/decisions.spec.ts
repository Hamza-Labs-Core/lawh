import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { APP, type Asked, db, enter, joinAsked, leave, makeMember, OPTIONS, test } from './people';

const card = (page: Page, question: string) => page.locator('.decision').filter({ has: page.getByRole('heading', { name: question, exact: true }) });
const record = (page: Page, question: string) => card(page, question).getByRole('button', { name: 'Record decision' });
const open = async (page: Page, member: string, path: string) => { await enter(page.context(), member); await page.goto(`${APP}${path}`); };
const answers = async (asked: Asked, i = 0) => (await db(`SELECT seq, revision, option_id, notes, member_id, decides FROM decision_answers WHERE decision_id='${asked.ids[i]!}' ORDER BY seq`))[0]!;
const answered = (asked: Asked, member: string, option: string, seq = 1, decides = 1, needed = 1) =>
  db(`INSERT INTO decision_answers(decision_id,seq,revision,option_id,notes,answered_at,member_id,needed,decides) SELECT id,${seq},revision,'${option}','',${Date.now()},'${member}',${needed},${decides} FROM decisions WHERE id='${asked.ids[0]!}'`);
const reworded = (asked: Asked, question: string) => db(
  `INSERT INTO decision_revisions(decision_id,revision,question,options_json,version_n,created_at) VALUES('${asked.ids[0]!}',2,'${question}','${JSON.stringify(OPTIONS)}',1,2)`,
  `UPDATE decisions SET revision=2, status=CASE status WHEN 'answered' THEN 'stale' ELSE status END WHERE id='${asked.ids[0]!}'`);
const wide = async (page: Page) => page.setViewportSize({ width: 1280, height: 800 });
const phone = async (page: Page) => page.setViewportSize({ width: 390, height: 844 });

test('beside the page: nothing is chosen in advance, the first option is recommended, and an answer is recorded', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Where should photos be stored?', context: 'Photos only.' }, { question: 'Keep old ones?' }]);
  await open(page, member, asked.path);
  const first = card(page, 'Where should photos be stored?');
  await expect(first.getByText('Photos only.')).toBeVisible();
  await expect(first.getByRole('radio')).toHaveCount(3);
  await expect(first.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(record(page, 'Where should photos be stored?')).toBeDisabled();
  expect(await first.locator('.opt').allInnerTexts()).toEqual([expect.stringMatching(/Object storage\s+Recommended[\s\S]*One region\.[\s\S]*About \$2 a month/), expect.not.stringContaining('Recommended'), expect.not.stringContaining('Recommended')]);
  await expect(page.getByRole('link', { name: 'Decisions 2' })).toBeVisible();
  await first.getByText('Database blobs').click();
  await first.getByRole('textbox').fill('  Simpler  ');
  await record(page, 'Where should photos be stored?').click();
  await expect(first.getByText('Recorded.')).toBeVisible();
  await expect(first.locator('.given')).toContainText('Database blobs');
  await expect(first.locator('.given')).toContainText('Simpler');
  await expect(first).toBeFocused();
  await expect(first.getByRole('radio')).toHaveCount(0);
  expect(await answers(asked)).toEqual([{ seq: 1, revision: 1, option_id: 'b', notes: 'Simpler', member_id: member, decides: 1 }]);
  await expect(page.getByRole('link', { name: 'Decisions 1' })).toBeVisible();
  await expect(page.locator('.reader-bar .status')).toHaveText('In review');
  // The last one decides the page.
  await card(page, 'Keep old ones?').getByText('Object storage').click();
  await record(page, 'Keep old ones?').click();
  await expect(page.locator('.reader-bar .status')).toHaveText('Decided');
  await expect(page.getByRole('link', { name: 'Decisions', exact: true })).toBeVisible();
  await page.reload();
  await expect(first.locator('.given')).toContainText('You');
});

test('notes alone answer, and an answer can be changed with its history kept', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  const it = card(page, 'Which?');
  await it.getByRole('textbox').fill('   ');
  await expect(record(page, 'Which?')).toBeDisabled();
  await it.getByRole('textbox').fill('None of these');
  await record(page, 'Which?').click();
  await expect(it.locator('.given')).toContainText('None of these');
  await it.getByRole('button', { name: 'Change the answer' }).click();
  await it.getByText('Object storage').click();
  await it.getByRole('button', { name: 'Cancel' }).click();
  await expect(it.getByRole('radio')).toHaveCount(0);
  await it.getByRole('button', { name: 'Change the answer' }).click();
  await expect(it.getByRole('radio', { checked: true })).toHaveCount(0);
  await it.getByText('Object storage').click();
  await it.getByRole('button', { name: 'Change the answer' }).click();
  await expect(it.locator('.given').first()).toContainText('Object storage');
  await it.getByText('History').click();
  await expect(it.locator('.answers li')).toHaveText([/Object storage/, /None of these/]);
  expect((await answers(asked)).map((a) => [a.seq, a.option_id])).toEqual([[1, null], [2, 'a']]);
});

test('with the keyboard alone', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  const it = card(page, 'Which?');
  await it.getByRole('radio').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(it.getByRole('radio').nth(1)).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(it.getByRole('textbox')).toBeFocused();
  await page.keyboard.type('Yes');
  await it.getByRole('button', { name: 'Record decision' }).focus();
  await page.keyboard.press('Enter');
  await expect(it.getByText('Recorded.')).toBeVisible();
  expect((await answers(asked)).map((a) => [a.option_id, a.notes])).toEqual([['b', 'Yes']]);
});

test('an answer from elsewhere meanwhile is shown first, and nothing is recorded over it', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]), other = await makeMember('Rami');
  try {
    await joinAsked(asked, other);
    await open(page, member, asked.path);
    const it = card(page, 'Which?');
    await it.getByText('Object storage').click();
    await it.getByRole('textbox').fill('Mine');
    await answered(asked, other, 'b');
    await record(page, 'Which?').click();
    await expect(it.getByRole('alert')).toHaveText(/changed meanwhile/);
    await expect(it.locator('.given')).toContainText('Database blobs');
    await expect(it.locator('.given')).toContainText('Rami');
    expect(await answers(asked)).toHaveLength(1);
    // Still there to record, after seeing it.
    await it.getByRole('button', { name: 'Change the answer' }).click();
    await expect(it.getByRole('textbox')).toHaveValue('Mine');
    await it.getByRole('button', { name: 'Change the answer' }).click();
    await expect(it.locator('.given')).toContainText('Mine');
    expect(await answers(asked)).toHaveLength(2);
  } finally { await leave(other); }
});

test('a question that changes meanwhile is shown anew, with nothing chosen, and the notes are kept', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  await card(page, 'Which?').getByText('Object storage').click();
  await card(page, 'Which?').getByRole('textbox').fill('Long thoughts');
  await reworded(asked, 'Which one now?');
  await record(page, 'Which?').click();
  const it = card(page, 'Which one now?');
  await expect(it.getByRole('alert')).toHaveText(/changed meanwhile/);
  await expect(it.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(it.getByRole('textbox')).toHaveValue('Long thoughts');
  expect(await answers(asked)).toHaveLength(0);
});

test('a question that changed after its answer is asked again, with the earlier answer and its wording', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await answered(asked, member, 'a');
  await reworded(asked, 'Which one now?');
  await open(page, member, asked.path);
  const it = card(page, 'Which one now?');
  await expect(it.getByText('Question changed')).toBeVisible();
  await expect(it.locator('.given')).toContainText('Which?');
  await expect(it.locator('.given')).toContainText('Object storage');
  await it.getByText('Database blobs').click();
  await record(page, 'Which one now?').click();
  await expect(it.getByText('Answered', { exact: true })).toBeVisible();
  await it.getByText('History').click();
  await expect(it.locator('.answers li').nth(1)).toContainText('Asked: Which?');
});

test('two people must agree: who chose what is shown, and it moves to "Waiting for others"', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }], { needed: 2 }), other = await makeMember('Rami');
  try {
    await joinAsked(asked, other);
    await answered(asked, other, 'b', 1, 0, 2);
    await open(page, member, asked.path);
    const it = card(page, 'Which?');
    await expect(it.getByText('1 of 2 agree')).toBeVisible();
    await expect(it.locator('.opt').nth(1)).toContainText('Chosen by: Rami');
    await it.getByRole('textbox').fill('Notes alone');
    await expect(record(page, 'Which?')).toBeDisabled();
    await it.getByText('Object storage').click();
    await record(page, 'Which?').click();
    await expect(it.getByText('Recorded. Others still need to agree.')).toBeVisible();
    await expect(it.locator('.opt').first()).toContainText('Chosen by: You');
    await page.getByRole('link', { name: 'Decisions', exact: true }).click();
    await expect(page.getByText('Nothing waits for an answer.')).toBeVisible();
    await page.getByRole('link', { name: 'Waiting for others' }).click();
    await it.getByText('Database blobs').click();
    await it.getByRole('button', { name: 'Change the answer' }).click();
    await expect(it.getByText('Recorded.', { exact: true })).toBeVisible();
    await expect(it.locator('.given')).toContainText('Database blobs');
  } finally { await leave(other); }
});

test('below decider, decisions are read only', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }], { level: 2 });
  await open(page, member, asked.path);
  const it = card(page, 'Which?');
  await expect(it.getByText('Only deciders answer here.')).toBeVisible();
  await expect(it.getByRole('radio')).toHaveCount(0);
  await expect(it.getByRole('textbox')).toHaveCount(0);
  await expect(it.getByText('Object storage')).toBeVisible();
  await page.getByRole('link', { name: 'Decisions', exact: true }).click();
  await expect(page.getByText('Nothing waits for an answer.')).toBeVisible();
});

test('a level lost meanwhile is told, and the form goes away', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  await card(page, 'Which?').getByText('Object storage').click();
  await db(`UPDATE team_members SET level=1, set_by='o' WHERE member_id='${member}'`);
  await record(page, 'Which?').click();
  await expect(card(page, 'Which?').getByRole('alert')).toHaveText('Only deciders answer here.');
  await expect(card(page, 'Which?').getByRole('radio')).toHaveCount(0);
  await db("DELETE FROM team_members WHERE member_id='" + member + "'");
  await page.reload();
  await expect(page.getByText('This page isn’t here, or you can’t see it.')).toBeVisible();
});

test('a failure keeps what was chosen, and trying again records it once', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  const it = card(page, 'Which?');
  await it.getByText('Object storage').click();
  await page.route('**/answers', (route) => route.abort());
  await record(page, 'Which?').click();
  await expect(it.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/answers');
  await record(page, 'Which?').dblclick();
  await expect(it.getByText('Recorded.')).toBeVisible();
  expect(await answers(asked)).toHaveLength(1);
});

test('an answer that arrived although its reply was lost is shown, not recorded twice', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await open(page, member, asked.path);
  const it = card(page, 'Which?');
  await it.getByText('Object storage').click();
  await page.route('**/answers', async (route) => { await route.fetch(); await route.abort(); });
  await record(page, 'Which?').click();
  await expect(it.getByRole('alert')).toBeVisible();
  await page.unroute('**/answers');
  await record(page, 'Which?').click();
  await expect(it.locator('.given')).toContainText('Object storage');
  expect(await answers(asked)).toHaveLength(1);
});

test('questions that fail to load can be tried again', async ({ page, member, ask }) => {
  await wide(page);
  const asked = await ask([{ question: 'Which?' }]);
  await page.route('**/page/decisions', (route) => route.abort());
  await open(page, member, asked.path);
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/page/decisions');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(card(page, 'Which?')).toBeVisible();
});

test('on a phone: a fixed button opens the questions as a sheet, and closing keeps what was written', async ({ page, member, ask }) => {
  await phone(page);
  const asked = await ask([{ question: 'Which?' }, { question: 'And this?' }]);
  await open(page, member, asked.path);
  const button = page.getByRole('button', { name: 'Decisions to make: 2' }), sheet = page.getByRole('dialog', { name: 'Decisions' });
  await button.click();
  await card(page, 'Which?').getByText('Object storage').click();
  await card(page, 'Which?').getByRole('textbox').fill('Half a thought');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await expect(card(page, 'Which?').getByRole('radio').first()).toBeChecked();
  await expect(card(page, 'Which?').getByRole('textbox')).toHaveValue('Half a thought');
  await record(page, 'Which?').click();
  await expect(card(page, 'Which?').getByText('Recorded.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Decisions to make: 1' })).toBeVisible();
  // Another person signing in on this device doesn't see a draft.
  expect(await answers(asked)).toHaveLength(1);
});

test('the page can be read and scrolled beside and under the questions', async ({ page, member, ask }) => {
  const asked = await ask([{ question: 'Which?' }]);
  for (const [width, height] of [[1280, 800], [390, 844], [320, 568]] as const) {
    await page.setViewportSize({ width, height });
    await open(page, member, asked.path);
    await expect(width > 960 ? card(page, 'Which?') : page.getByRole('button', { name: 'Decisions to make: 1' })).toBeVisible();
    const box = (await page.locator('.page-frame').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(width > 960 ? width - 400 : width);
    expect(box.height).toBeGreaterThanOrEqual(height * 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});

test('text from agents and people is text, whatever it says', async ({ page, member, ask }) => {
  await wide(page);
  const evil = '<img src=x onerror="document.title=1"><b>bold</b>';
  const asked = await ask([{ question: evil, context: evil, options: [{ id: 'a', label: evil, detail: evil, cost: evil }, { id: 'b', label: 'B' }] }], { title: evil });
  await open(page, member, asked.path);
  const it = page.locator('.decision');
  await it.getByRole('radio').first().check();
  await it.getByRole('textbox').fill(evil);
  await it.getByRole('button', { name: 'Record decision' }).click();
  await expect(it.locator('.given')).toContainText(evil);
  await page.goto(`${APP}/decisions?show=answered`);
  await expect(it.locator('.given')).toContainText(evil);
  expect(await page.locator('main img, main b').count()).toBe(0);
});

test('the open decisions of every project, only those to answer, each with its page', async ({ page, member, ask }) => {
  await wide(page);
  await ask([{ question: 'First?' }, { question: 'Second?' }]);
  const other = await ask([{ question: 'Third?' }], { title: 'Onboarding screens' });
  await ask([{ question: 'Not mine?' }], { level: 1 });
  await open(page, member, '/decisions');
  await expect(page.locator('.decision h2')).toHaveText(['First?', 'Second?', 'Third?']);
  await card(page, 'Second?').getByText('Object storage').click();
  await record(page, 'Second?').click();
  // It stays where it was, answered, until the list is read again.
  await expect(card(page, 'Second?').getByText('Recorded.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Decisions 2' })).toBeVisible();
  await page.getByRole('link', { name: 'Answered' }).click();
  await expect(page.locator('.decision h2')).toHaveText(['Second?']);
  await page.goBack();
  await expect(page.locator('.decision h2')).toHaveText(['First?', 'Third?']);
  await page.getByRole('link', { name: 'Onboarding screens' }).click();
  await expect(page).toHaveURL(`${APP}${other.path}`);
});

test('a long list shows more on request, without a repeat', async ({ page, member, ask }) => {
  await wide(page);
  await ask(Array.from({ length: 35 }, (_, i) => ({ question: `Question ${i}?` })));
  await open(page, member, '/decisions');
  await expect(page.locator('.decision')).toHaveCount(30);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('.decision')).toHaveCount(35);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  expect(new Set(await page.locator('.decision h2').allInnerTexts()).size).toBe(35);
});

test('a list that fails can be tried again', async ({ page, member, ask }) => {
  await ask([{ question: 'Which?' }]);
  await page.route('**/app-api/decisions?**', (route) => route.abort());
  await open(page, member, '/decisions');
  await expect(page.getByRole('alert')).toHaveText('No connection.');
  await page.unroute('**/app-api/decisions?**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(card(page, 'Which?')).toBeVisible();
});

const AR = [{ id: 'a', label: 'تخزين الكائنات', detail: 'في منطقة واحدة.', cost: 'نحو ٢ دولار شهريًا' }, { id: 'b', label: 'داخل قاعدة البيانات', cost: 'نحو ٣٠ دولارًا شهريًا' }, { id: 'c', label: 'إبقاء الملفات على الجهاز' }];
for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [390, 1280]) {
  test(`the decision screens fit and are accessible (${lang}, ${mode}, ${width})`, async ({ page, member, ask, browserName }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    const ar = lang === 'ar', options = ar ? AR : OPTIONS, rami = await makeMember(ar ? 'رامي' : 'Rami'), shots = process.env.LAWH_SHOTS;
    const check = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(0);
      for (const target of await page.locator('button:visible, a:visible, .opt:visible, textarea:visible, summary:visible').all()) {
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height), `${name}: ${(await target.textContent())?.slice(0, 40)}`).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`), name).toEqual([]);
      if (shots && browserName === 'chromium') await page.screenshot({ path: `${shots}/${name}-${lang}-${mode}-${width}.png` });
    };
    const show = async () => { if (width < 500) await page.locator('.to-panel button').click(); await expect(page.locator('.decision').first()).toBeVisible(); };
    try {
      const asked = await ask([{ question: ar ? 'أين تُخزَّن الصور؟' : 'Where should photos be stored?', context: ar ? 'للصور فقط، لا للملفات الأخرى.' : 'For photos only, not other files.', options }, { question: ar ? 'هل تبقى الصور القديمة؟' : 'Keep the old photos?', options }], { title: ar ? 'خيارات تخزين الصور' : 'Photo storage options', lang });
      const shared = await ask([{ question: ar ? 'متى يبدأ النقل؟' : 'When does the move start?', options }], { needed: 3, title: ar ? 'خطة النقل' : 'Moving plan', lang });
      await joinAsked(shared, rami);
      await answered(shared, rami, 'b', 1, 0, 3);
      await open(page, member, asked.path); await expect(page.frameLocator('.page-frame').locator('h1')).toBeVisible(); await check('decisions-page');
      await show(); await page.locator('.opt').first().click(); if (width < 500) await check('decisions-sheet'); else await check('decisions-chosen');
      await page.locator('.decision .primary').first().click(); await expect(page.locator('.decision .done')).toBeVisible();
      await page.locator('summary').click(); await expect(page.locator('.answers li')).toHaveCount(1); await check('decisions-answered');
      await reworded(asked, ar ? 'أين تُخزَّن الصور والمقاطع؟' : 'Where should photos and videos be stored?');
      await page.reload(); await show(); await expect(page.locator('[data-status=stale]')).toBeVisible(); await check('decisions-changed');
      await page.goto(`${APP}/decisions`); await expect(page.locator('.decision')).toHaveCount(3); await check('decisions');
      await page.goto(`${APP}/decisions?show=waiting`); await expect(page.locator('.empty')).toBeVisible(); await check('decisions-empty');
      await open(page, member, shared.path); await show(); await page.locator('.opt').first().click(); await page.locator('.decision .primary').click(); await expect(page.locator('.decision .done')).toBeVisible(); await check('decisions-agree');
      await page.goto(`${APP}/decisions?show=answered`); await expect(page.locator('.empty')).toBeVisible();
      await db(`UPDATE team_members SET level=1, set_by='o' WHERE member_id='${member}'`);
      await page.goto(`${APP}${asked.path}`); await show(); await check('decisions-read-only');
    } finally { await leave(rami); }
  });
}
