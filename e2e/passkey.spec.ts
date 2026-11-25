// Chromium only: the others have no test passkey device.
import { expect, type Page } from '@playwright/test';
import { APP, makeLink, test } from './people';

/** A passkey device that always says yes. Only Chromium has one for tests. */
async function passkeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

test('a link registers a passkey, which then signs in', async ({ page, member }) => {
  await passkeyDevice(page);
  await page.goto(`${APP}/link#${await makeLink(member)}`);
  await expect(page.getByRole('heading', { name: /^Welcome, \W?Mona\W?$/ })).toBeVisible();
  expect(page.url(), 'the token is taken out of the address').toBe(`${APP}/link`);
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
  expect(page.url()).toBe(`${APP}/`);
  await page.goBack();
  expect(page.url(), 'Back does not return to the used link').not.toContain('/link');
  await page.goto(APP);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
});

test('a link works once', async ({ page, member }) => {
  await passkeyDevice(page);
  const token = await makeLink(member);
  await page.goto(`${APP}/link#${token}`);
  await page.getByRole('button', { name: 'Create a passkey' }).click();
  await expect(page.getByRole('heading', { name: /^Signed in as \W?Mona\W?$/ })).toBeVisible();
  await page.goto('about:blank');
  await page.goto(`${APP}/link#${token}`);
  await expect(page.getByText('This link doesn’t work.')).toBeVisible();
});
