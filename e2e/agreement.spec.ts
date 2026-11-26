import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { APP, enterOwner, test } from './people';

test.describe('S19 Agreement: project setting, progress, and Waiting for others', () => {
  test('owner configures answersNeeded with too-few-answerers warning and views agreement progress in Decisions (en, ar RTL, axe)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await enterOwner(page.context());

    const projectsState = {
      items: [
        { slug: 'one', name: { en: 'One', ar: 'واحد' }, level: 5, answersNeeded: 1, answerers: 2 },
      ],
    };

    const waitingDecision = {
      id: 'dec_01AGREE000000000000000001',
      project: 'one',
      projectName: { en: 'One', ar: 'واحد' },
      page: { slug: 'plan', title: 'Storage Plan', lang: 'en', status: 'in_review' },
      revision: 1,
      status: 'open',
      question: 'Which storage backend?',
      context: 'Choose one.',
      options: [
        { id: 'a', label: 'SQLite' },
        { id: 'b', label: 'Postgres' },
      ],
      answer: null,
      answersNeeded: 3,
      agreement: [
        {
          seq: 1,
          revision: 1,
          question: 'Which storage backend?',
          optionId: 'a',
          optionLabel: 'SQLite',
          notes: '',
          answeredAt: 1_700_000_000_000,
          answeredBy: { id: 'owner_1', name: 'Owner' },
          needed: 3,
          decides: false,
        },
      ],
      answerSeq: 1,
      mayAnswer: true,
      answerers: 2,
    };

    await page.route('**/app-api/me', async (route) => {
      const res = await route.fetch();
      const body = await res.json() as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, id: 'owner_1', teams: true, managesTeam: true } });
    });
    await page.route('**/app-api/projects', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: projectsState });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/projects/one', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as { name?: { en: string; ar: string }; answersNeeded?: number };
        if (body.name) projectsState.items[0]!.name = body.name;
        if (body.answersNeeded !== undefined) projectsState.items[0]!.answersNeeded = body.answersNeeded;
        await route.fulfill({ json: projectsState.items[0]! });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/decisions**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/app-api/decisions/count') {
        await route.fulfill({ json: { count: 0, more: false } });
        return;
      }
      const show = url.searchParams.get('show') ?? 'open';
      await route.fulfill({ json: { items: show === 'waiting' ? [waitingDecision] : [], next: null } });
    });

    // Settings → Projects: set answersNeeded to 3 when only 2 can answer -> shows exact warning!
    await page.goto(`${APP}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'One' })).toBeVisible();
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('People who must agree').selectOption('3');
    await expect(page.getByText('Needs 3 people, only 2 can answer.')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('3 must agree')).toBeVisible();
    await expect(page.getByText('Needs 3 people, only 2 can answer.')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Decisions → Waiting for others: shows 1 of 3 agree, Only 2 can answer, Chosen by You!
    await page.getByRole('link', { name: 'Decisions' }).click();
    await expect(page.getByText('Nothing waits for an answer.')).toBeVisible();
    await page.getByRole('link', { name: 'Waiting for others' }).click();
    await expect(page.getByRole('heading', { name: 'Which storage backend?' })).toBeVisible();
    await expect(page.getByText('1 of 3 agree')).toBeVisible();
    await expect(page.getByText('Only 2 can answer.')).toBeVisible();
    await expect(page.getByText('Chosen by: You')).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // Arabic RTL + axe check.
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'Which storage backend?' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
