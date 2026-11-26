import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { APP, enterOwner, test } from './people';

test.describe('S18 Settings → People, teams switch, and post-reset key review', () => {
  test('owner manages invites, reset links, removal, teams switch, and sees post-reset key banner (en, ar RTL, axe)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await enterOwner(page.context());

    let teamsOn = true;
    const peopleState = {
      members: [
        {
          id: 'mem_mona',
          name: 'Mona',
          createdAt: 1_700_000_000_000,
          joinedAt: 1_700_000_001_000,
          resetExpiresAt: null,
          teams: [{ id: 'tem_01', name: 'Design', level: 4 }],
        },
      ],
      invites: [
        {
          id: 'mem_exp',
          name: 'Tariq',
          teamId: 'tem_01',
          teamName: 'Design',
          level: 2,
          inviter: 'Owner',
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_000_001_000,
          expired: true,
          canRenew: true,
          canCancel: true,
        },
      ],
      teams: [{ id: 'tem_01', name: 'Design' }],
    };

    const agentsState = {
      items: [
        {
          id: 'agt_01',
          name: 'claude-agent',
          createdAt: 1_700_000_000_000,
          disabledAt: null,
          owner: { id: 'o', name: 'Owner' },
          isMine: true,
          keys: [
            {
              id: 'key_01',
              label: 'Lost laptop',
              scopes: ['pages:read', 'pages:write'],
              allProjects: true,
              projects: [],
              createdAt: 1_700_000_000_000,
              expiresAt: Date.now() + 86_400_000 * 30,
              lastUsedAt: null as number | null,
              revokedAt: null as number | null,
            },
          ],
        },
      ],
      next: null,
    };

    await page.route('**/app-api/me', async (route) => {
      const res = await route.fetch();
      const body = await res.json() as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, teams: teamsOn, managesTeam: true } });
    });
    await page.route('**/app-api/people**', async (route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (pathname === '/app-api/people' && req.method() === 'GET') {
        await route.fulfill({ json: peopleState });
        return;
      }
      if (pathname === '/app-api/people/invite' && req.method() === 'POST') {
        const body = req.postDataJSON() as { name: string; teamId: string; level: number };
        const inv = {
          id: 'mem_lina',
          name: body.name,
          teamId: body.teamId,
          teamName: 'Design',
          level: body.level,
          inviter: 'Owner',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3 * 86_400_000,
          expired: false,
          canRenew: true,
          canCancel: true,
        };
        peopleState.invites.unshift(inv);
        await route.fulfill({
          status: 201,
          json: { id: inv.id, name: inv.name, teamId: inv.teamId, teamName: 'Design', level: inv.level, url: `${APP}/link#${'A'.repeat(43)}`, expiresAt: inv.expiresAt },
        });
        return;
      }
      if (pathname.endsWith('/invite-link') && req.method() === 'POST') {
        await route.fulfill({ status: 200, json: { id: 'mem_exp', url: `${APP}/link#${'B'.repeat(43)}`, expiresAt: Date.now() + 3 * 86_400_000 } });
        return;
      }
      if (pathname.endsWith('/invite') && req.method() === 'DELETE') {
        const id = pathname.split('/').at(-2)!;
        peopleState.invites = peopleState.invites.filter((i) => i.id !== id);
        await route.fulfill({ status: 204 });
        return;
      }
      if (pathname.endsWith('/reset') && req.method() === 'POST') {
        await route.fulfill({ status: 200, json: { id: 'mem_mona', url: `${APP}/link#${'C'.repeat(43)}`, expiresAt: Date.now() + 86_400_000 } });
        return;
      }
      if (req.method() === 'DELETE') {
        const id = pathname.split('/').at(-1)!;
        peopleState.members = peopleState.members.filter((m) => m.id !== id);
        await route.fulfill({ status: 204 });
        return;
      }
      await route.continue();
    });
    await page.route('**/app-api/settings', async (route) => {
      await route.fulfill({ json: { retention: null, webhooks: false, webhookHosts: [], teams: teamsOn } });
    });
    await page.route('**/app-api/switches/teams', async (route) => {
      const body = route.request().postDataJSON() as { on: boolean };
      teamsOn = body.on;
      await route.fulfill({ json: { teams: teamsOn } });
    });
    await page.route('**/app-api/agents*', async (route) => {
      await route.fulfill({ json: agentsState });
    });
    await page.route('**/app-api/agent-keys/*', async (route) => {
      agentsState.items[0]!.keys[0]!.revokedAt = Date.now();
      await route.fulfill({ status: 204 });
    });

    await page.goto(`${APP}/settings/people`);
    await expect(page.getByRole('heading', { name: 'Pending invites' })).toBeVisible();
    await expect(page.getByText('Tariq')).toBeVisible();
    await expect(page.getByText('Link expired')).toBeVisible();
    await expect(page.getByText('Mona')).toBeVisible();

    // Invite Lina -> one-time invite link shown, then dismissed.
    await page.getByRole('button', { name: 'Invite a person' }).click();
    await page.getByLabel('Name').fill('Lina');
    await page.getByRole('button', { name: 'Create invite link' }).click();
    await expect(page.getByRole('heading', { name: 'Invite link' })).toBeVisible();
    await expect(page.getByText(`${APP}/link#${'A'.repeat(43)}`)).toBeVisible();
    await page.getByRole('button', { name: 'Done, hide link' }).click();
    await expect(page.getByText('Lina')).toBeVisible();

    // Cancel Tariq's expired invite.
    await page.locator('ul.rows li', { hasText: 'Tariq' }).getByRole('button', { name: 'Cancel invite' }).click();
    await page.getByRole('button', { name: 'Cancel invite for good' }).click();
    await expect(page.getByText('Tariq')).toHaveCount(0);

    // Create a 1-day reset link for Mona.
    await page.locator('ul.rows li', { hasText: 'Mona' }).getByRole('button', { name: 'Reset link' }).click();
    await page.getByRole('button', { name: 'Create 1-day reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Reset link' })).toBeVisible();
    await expect(page.getByText(`${APP}/link#${'C'.repeat(43)}`)).toBeVisible();
    await page.getByRole('button', { name: 'Done, hide link' }).click();

    // Remove Mona (2-step confirmation).
    await page.locator('ul.rows li', { hasText: 'Mona' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove for good' }).click();
    await expect(page.getByText('No members have joined yet.')).toBeVisible();

    // Check axe accessibility in English & Arabic RTL.
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'العربية' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'English' }).click();

    // Verify Teams switch in Settings → Data warns about resetting answers_needed to 1.
    await page.getByRole('link', { name: 'Versions and export' }).click();
    await expect(page.getByText('Teams are on.')).toBeVisible();
    await page.getByRole('button', { name: 'Turn teams off' }).click();
    await expect(page.getByText(/resets every project’s required agreement count back to 1/)).toBeVisible();
    await page.getByRole('button', { name: 'Turn teams off now' }).click();
    await expect(page.getByText('Teams are off. Only the owner can sign in.')).toBeVisible();

    // Post-reset page (/settings/agents?reset=1) shows banner and active keys with Revoke!
    await page.goto(`${APP}/settings/agents?reset=1`);
    await expect(page.getByText(/Agent keys stay active after a reset/)).toBeVisible();
    await expect(page.getByText('Lost laptop')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke for good' }).click();
    await expect(page.getByText('Revoked')).toBeVisible();
  });
});
