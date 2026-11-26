import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { APP, enterOwner, test } from './people';

test.describe('S17 Settings → Teams and managers’ agents', () => {
  test('owner manages teams, projects, members, and managers’ agents (en, ar RTL, keyboard, axe)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await enterOwner(page.context());

    const teamsState = {
      items: [
        {
          id: 'tem_01DESIGN',
          name: 'Design',
          createdAt: 1_700_000_000_000,
          members: [
            { id: 'm1', name: 'Mona', level: 4, setAt: 1_700_000_000_000 },
            { id: 'm2', name: 'Rami', level: 2, setAt: 1_700_000_000_000 },
          ],
          projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
        },
      ],
      availableMembers: [
        { id: 'm1', name: 'Mona' },
        { id: 'm2', name: 'Rami' },
        { id: 'm3', name: 'Dina' },
      ],
      availableProjects: [
        { slug: 'one', name: { en: 'One', ar: 'واحد' } },
        { slug: 'two', name: { en: 'Two', ar: 'اثنان' } },
      ],
    };

    const agentsState = {
      items: [
        {
          id: 'agt_01MONA',
          name: 'claude-agent',
          createdAt: 1_700_000_000_000,
          disabledAt: null,
          owner: { id: 'm1', name: 'Mona' },
          isMine: false,
          keys: [],
        },
      ],
      next: null,
    };

    // Mock teams=true on /app-api/me and /app-api/teams + /app-api/agents without touching shared D1 settings.
    await page.route('**/app-api/me', async (route) => {
      const res = await route.fetch();
      const body = await res.json() as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, teams: true } });
    });
    await page.route('**/app-api/teams', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: teamsState });
        return;
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { name: string };
        const created = { id: 'tem_02OPS', name: body.name, createdAt: Date.now(), members: [], projects: [] };
        teamsState.items.push(created);
        await route.fulfill({ status: 201, json: created });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/teams/*/members', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { memberId: string; level: number };
        const m = teamsState.availableMembers.find((x) => x.id === body.memberId)!;
        teamsState.items[0]!.members.push({ id: m.id, name: m.name, level: body.level, setAt: Date.now() });
        await route.fulfill({ status: 201, json: { teamId: teamsState.items[0]!.id, ...body } });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/teams/*/projects', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { project: string };
        const p = teamsState.availableProjects.find((x) => x.slug === body.project)!;
        teamsState.items[0]!.projects.push(p);
        await route.fulfill({ status: 201, json: { teamId: teamsState.items[0]!.id, project: p.slug } });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/teams/*/projects/*', async (route) => {
      if (route.request().method() === 'DELETE') {
        const slug = route.request().url().split('/').at(-1)!;
        teamsState.items[0]!.projects = teamsState.items[0]!.projects.filter((x) => x.slug !== slug);
        await route.fulfill({ status: 204 });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/agents*', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: agentsState });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/agents/*/take-over', async (route) => {
      agentsState.items[0]!.isMine = true;
      agentsState.items[0]!.owner = { id: 'owner', name: 'Owner' };
      await route.fulfill({ status: 200, json: { id: 'agt_01MONA', name: 'claude-agent' } });
    });

    await page.goto(`${APP}/settings/teams`);
    await expect(page.getByRole('heading', { name: 'Design' })).toBeVisible();
    await expect(page.getByText('Mona')).toBeVisible();
    await expect(page.getByText('Rami')).toBeVisible();

    // Keyboard navigation: open New team with Enter, cancel -> focus returns to New team button.
    const newTeamBtn = page.getByRole('button', { name: 'New team' });
    await newTeamBtn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Team name')).toBeFocused();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(newTeamBtn).toBeFocused();

    // Create a new team via keyboard submit -> focus returns to New team button.
    await page.keyboard.press('Enter');
    await page.getByLabel('Team name').fill('Ops');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Ops' })).toBeVisible();
    await expect(newTeamBtn).toBeFocused();

    // Assign project Two to Design team, then remove it.
    await page.getByRole('button', { name: 'Add project' }).first().click();
    await expect(page.getByText('(two)')).toBeVisible();
    await page.locator('ul.rows li', { hasText: '(two)' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('(two)')).toHaveCount(0);

    // Add Dina to Design team.
    await page.getByRole('button', { name: 'Add member' }).first().click();
    await expect(page.locator('strong', { hasText: 'Dina' })).toBeVisible();

    // Check axe accessibility on Settings → Teams (en, dark).
    const axeEn = await new AxeBuilder({ page }).analyze();
    expect(axeEn.violations).toEqual([]);

    // Switch to Arabic RTL and verify gender-neutral level nouns & accessibility.
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'Design' })).toBeVisible();
    const axeAr = await new AxeBuilder({ page }).analyze();
    expect(axeAr.violations).toEqual([]);
    await page.getByRole('button', { name: 'English' }).click();

    // Navigate to Settings → Agents and verify "claude-agent (Mona)" + Take over flow.
    await page.getByRole('link', { name: 'Agents and keys' }).click();
    await expect(page.getByRole('heading', { name: 'claude-agent (Mona)' })).toBeVisible();
    await page.getByRole('button', { name: 'Take over agent' }).click();
    await page.getByRole('button', { name: 'Take over and revoke its keys' }).click();
    await expect(page.getByRole('heading', { name: 'claude-agent', exact: true })).toBeVisible();
  });
});
