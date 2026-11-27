import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP, db, enter, enterOwner, removeAgents, test } from './people';

const execFileAsync = promisify(execFile);

test('an agent connects end-to-end through /connect and the zero-dep CLI publishes and reads back', async ({ page, member, ask }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const asked = await ask([], { level: 4 });
  const tmp = mkdtempSync(join(tmpdir(), 'lawh-cli-e2e-'));
  const storePath = join(tmp, 'agents.json');
  const pageDir = join(tmp, 'site');
  const decisionsFile = join(tmp, 'decisions.json');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    // Download the served CLI and skill from the copy itself.
    const [mdRes, cliRes] = await Promise.all([
      page.request.get(`${APP}/connect.md`),
      page.request.get(`${APP}/lawh.mjs`),
    ]);
    expect(mdRes.status()).toBe(200);
    expect(await mdRes.text()).toContain(`${APP}/lawh.mjs`);
    expect(cliRes.status()).toBe(200);
    const cliPath = join(tmp, 'lawh.mjs');
    writeFileSync(cliPath, await cliRes.text());

    // Run `lawh.mjs connect` for real (isolated 0600 store, --no-open, fast poll) and read its printed code.
    const cliEnv = { ...process.env, LAWH_STORE: storePath, LAWH_NO_KEYCHAIN: '1' };
    child = spawn(process.execPath, [cliPath, 'connect', APP, '--client', 'claude', '--machine', 'workstation', '--no-open', '--poll-ms', '200', '--json'], { env: cliEnv });
    let stdout = '';
    let stderr = '';
    const codePromise = new Promise<string>((resolve, reject) => {
      child!.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child!.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        const match = /Code:\s*([A-Z]{4}-[A-Z]{4})/.exec(stderr);
        if (match) resolve(match[1]!);
      });
      child!.once('error', reject);
      child!.once('exit', (c) => { if (c !== 0) reject(new Error(`connect exited ${c}: ${stderr}`)); });
    });
    const exitPromise = new Promise<number | null>((resolve) => child!.once('exit', resolve));
    const connectCode = await codePromise;

    // Manager opens /connect, types the code, sees client claim + warning, picks name & project, and connects.
    await enter(page.context(), member);
    await page.goto(`${APP}/connect`);
    await page.getByLabel('Type the code the agent client shows.').fill(connectCode);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('The client says it is claude on workstation.')).toBeVisible();
    await expect(page.getByText('Continue only if you started this.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
    await page.getByLabel('New agent name').fill('cli-bot');
    await page.getByRole('button', { name: 'Connect agent' }).click();
    await expect(page.getByText('Connected cli-bot. You can return to the agent.')).toBeVisible();

    // `lawh.mjs connect` finishes, writes 0600 store, and never prints the secret.
    expect(await exitPromise).toBe(0);
    const connected = JSON.parse(stdout) as { agentId: string; name: string };
    expect(connected.name).toBe('cli-bot');
    expect(stdout + stderr).not.toContain('lawh_key_');
    expect(statSync(storePath).mode & 0o777).toBe(0o600);

    // Use the downloaded lawh.mjs CLI to verify whoami, agents, publish, pages, read, decisions, and events.
    const { stdout: whoamiOut } = await execFileAsync(process.execPath, [cliPath, 'whoami', '--json'], { env: cliEnv });
    expect(JSON.parse(whoamiOut)).toMatchObject({ agentId: connected.agentId, name: 'cli-bot' });
    const { stdout: agentsOut } = await execFileAsync(process.execPath, [cliPath, 'agents', '--json'], { env: cliEnv });
    expect(agentsOut).not.toContain('lawh_key_');

    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'index.html'), '<!doctype html><html><body><h1 id="intro">CLI Page</h1><p>Published via lawh.mjs.</p></body></html>');
    writeFileSync(decisionsFile, JSON.stringify([
      { key: 'pick', question: 'Ship it?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    ]));

    const { stdout: pubOut } = await execFileAsync(process.execPath, [
      cliPath, 'publish', pageDir,
      '--project', asked.slug, '--slug', 'from-cli',
      '--title', 'From CLI', '--status', 'in_review',
      '--decisions', decisionsFile, '--json',
    ], { env: cliEnv });
    const published = JSON.parse(pubOut) as { id: string; slug: string; currentVersion: number };
    expect(published).toMatchObject({ slug: 'from-cli', currentVersion: 1 });

    const { stdout: readFileOut } = await execFileAsync(process.execPath, [
      cliPath, 'read', asked.slug, 'from-cli', '--file', 'index.html',
    ], { env: cliEnv });
    expect(readFileOut).toContain('Published via lawh.mjs.');

    const { stdout: decOut } = await execFileAsync(process.execPath, [
      cliPath, 'decisions', '--page', published.id, '--json',
    ], { env: cliEnv });
    expect(JSON.parse(decOut).items[0]).toMatchObject({ key: 'pick', status: 'open' });

    const { stdout: evOut } = await execFileAsync(process.execPath, [
      cliPath, 'events', '--project', asked.slug, '--after', '0', '--json',
    ], { env: cliEnv });
    expect(JSON.parse(evOut).items.some((e: { type: string; pageId: string }) => e.type === 'page.published' && e.pageId === published.id)).toBe(true);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
    // Remove the CLI-published page, blobs, and connect row before fixture teardown deletes the project and agent.
    const extraPages = `(SELECT id FROM pages WHERE project_id='${asked.project}' AND id<>'${asked.pageId}')`;
    const extraDecisions = `(SELECT id FROM decisions WHERE page_id IN ${extraPages})`;
    await db(
      `DELETE FROM agent_connects WHERE member_id='${member}'`,
      `DELETE FROM pages_fts WHERE rowid IN (SELECT rowid FROM pages_fts_map WHERE page_id IN ${extraPages})`,
      `DELETE FROM pages_fts_map WHERE page_id IN ${extraPages}`,
      `DELETE FROM comments WHERE page_id IN ${extraPages}`,
      `UPDATE pages SET deleted_at=1 WHERE id IN ${extraPages}`,
      `DELETE FROM decision_answers WHERE decision_id IN ${extraDecisions}`,
      `DELETE FROM decision_revisions WHERE decision_id IN ${extraDecisions}`,
      `DELETE FROM decisions WHERE page_id IN ${extraPages}`,
      `DELETE FROM version_files WHERE version_id IN (SELECT id FROM page_versions WHERE page_id IN ${extraPages})`,
      `DELETE FROM page_versions WHERE page_id IN ${extraPages}`,
      `DELETE FROM pages WHERE id IN ${extraPages}`,
      `DELETE FROM project_blobs WHERE project_id='${asked.project}'`,
      `DELETE FROM idempotency WHERE key_id IN (SELECT id FROM agent_keys WHERE agent_id IN (SELECT id FROM agents WHERE member_id='${member}'))`,
    );
    await removeAgents(member);
  }
});

test('owner creates a new project inline on /connect and connects an agent to it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const suffix = randomBytes(4).toString('hex');
  const projectTitle = `Launch Board ${suffix}`;
  const slug = `inline-${suffix}`;
  const agentName = `inline-agent-${suffix}`;
  const secret = randomBytes(32).toString('base64url');
  const secretSha256 = createHash('sha256').update(secret).digest('hex');
  let connectId = '';
  try {
    const startRes = await page.request.post(`${APP}/v1/connect`, {
      data: { secretSha256, client: agentName, machine: 'laptop' },
    });
    expect(startRes.status()).toBe(201);
    const started = await startRes.json() as { id: string; code: string };
    connectId = started.id;
    const token = `lawh_${started.id}_${secret}`;

    await enterOwner(page.context());
    await page.goto(`${APP}/connect`);
    await page.getByLabel('Type the code the agent client shows.').fill(started.code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();

    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await page.getByLabel('Name', { exact: true }).fill(projectTitle);
    await expect(page.getByLabel('Address')).toHaveValue(`launch-board-${suffix}`);
    // Duplicate slug stays inside the inline creator without losing the connect screen.
    await page.getByLabel('Address').fill('one');
    await page.getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByRole('alert')).toHaveText('That address is taken.');

    // Pressing Enter inside the inline creator creates the project without submitting the outer connect form.
    await page.getByLabel('Address').fill(slug);
    await page.getByLabel('Address').press('Enter');
    await expect(page.getByRole('button', { name: 'Add project' })).toHaveCount(0);
    await expect(page.getByLabel('All projects')).not.toBeChecked();
    await expect(page.getByLabel(projectTitle)).toBeChecked();

    await page.getByRole('button', { name: 'Connect agent' }).click();
    await expect(page.getByText(`Connected ${agentName}. You can return to the agent.`)).toBeVisible();

    const pollRes = await page.request.get(`${APP}/v1/connect/${started.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pollRes.status()).toBe(200);
    const polled = await pollRes.json() as { agentId: string; name: string; projects: { slug: string }[] };
    expect(polled.name).toBe(agentName);
    expect(polled.projects.map((p) => p.slug)).toEqual([slug]);

    const projRes = await page.request.get(`${APP}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(projRes.status()).toBe(200);
    const projList = await projRes.json() as { items: { slug: string; name: { en: string; ar: string } }[] };
    expect(projList.items).toEqual([{ slug, name: { en: projectTitle, ar: projectTitle } }]);
  } finally {
    const stmts: string[] = [];
    if (connectId) stmts.push(`DELETE FROM agent_connects WHERE id='${connectId}'`);
    stmts.push(
      `DELETE FROM agent_key_projects WHERE project_id IN (SELECT id FROM projects WHERE slug='${slug}')`,
      `DELETE FROM agent_key_projects WHERE key_id IN (SELECT id FROM agent_keys WHERE agent_id IN (SELECT id FROM agents WHERE member_id='o' AND name='${agentName}'))`,
      `DELETE FROM agent_keys WHERE agent_id IN (SELECT id FROM agents WHERE member_id='o' AND name='${agentName}')`,
      `DELETE FROM agents WHERE member_id='o' AND name='${agentName}'`,
      `DELETE FROM projects WHERE slug='${slug}'`,
    );
    await db(...stmts);
  }
});

for (const lang of ['en', 'ar'] as const) for (const mode of ['dark', 'light'] as const) for (const width of [320, 390, 1280]) {
  test(`the connect screens fit and are accessible (${lang}, ${mode}, ${width})`, async ({ page, member, ask }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 800 });
    await page.addInitScript(([l, m]) => { if (self !== top || location.protocol === 'about:') return; localStorage.setItem('lawh-lang', l!); localStorage.setItem('lawh-mode', m!); }, [lang, mode]);
    await ask([], { level: 4, lang });
    const startRes = await page.request.post(`${APP}/v1/connect`, {
      data: { secretSha256: 'a'.repeat(64), client: 'claude', machine: 'laptop' },
    });
    const started = await startRes.json() as { code: string };
    await enter(page.context(), member);
    await page.goto(`${APP}/connect`);
    await expect(page.locator('input.code')).toBeVisible();
    for (const step of ['code', 'details'] as const) {
      if (step === 'details') {
        await page.locator('input.code').fill(started.code);
        await page.locator('button.primary').click();
        await expect(page.locator('.check').first()).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), step).toBeLessThanOrEqual(0);
      for (const target of await page.locator('button:visible, a:visible, input:not([type=checkbox]):visible, select:visible, .check:visible').all()) {
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height), step).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations, step).toEqual([]);
    }
  });
}
