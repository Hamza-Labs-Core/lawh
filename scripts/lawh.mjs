// pnpm lawh <init|upgrade|rollback|destroy|owner setup [--local]>
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createCloudflareClient, readCloudflareToken } from './cli/cloudflare.mjs';
import { runDestroy, runInit, runRollback, runUpgrade } from './cli/commands.mjs';
import { parseJsonc } from './local/jsonc.mjs';

const USAGE = `Usage:
  pnpm lawh init
  pnpm lawh upgrade
  pnpm lawh rollback
  pnpm lawh destroy
  pnpm lawh owner setup [--local]`;

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');

async function runOwnerSetup(flags) {
  if (flags.some((flag) => flag !== '--local')) fail(USAGE, 2);
  const local = flags.includes('--local');
  const state = process.env.LAWH_LOCAL_STATE ?? join(root, '.wrangler/dev');
  const config = local ? join(state, 'entry.json') : join(root, 'wrangler.app.jsonc');
  if (!existsSync(config)) fail(local ? 'Run `pnpm dev` first.' : 'wrangler.app.jsonc is missing. `pnpm lawh init` makes it.');
  // Read before anything is changed: without the address there is no link to print.
  const app = new URL(parseJsonc(readFileSync(config, 'utf8')).vars.APP_ORIGIN).origin;

  const where = local ? ['--local', '--persist-to', state] : ['--remote'];
  const sql = (statements) => JSON.parse(execFileSync(
    process.execPath,
    [wrangler, 'd1', 'execute', 'DB', ...where, '--json', '-c', config, '--command', statements],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'inherit'] },
  ).toString());
  const text = (value) => `'${value.replaceAll("'", "''")}'`;

  const [{ results: [owner] }] = sql("SELECT id, name, joined_at FROM members WHERE role = 'owner'");
  let id = owner?.id;
  if (!id) {
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    const name = (await ask.question('Your name, as others will see it: ')).trim();
    ask.close();
    // eslint-disable-next-line no-control-regex
    if (!name || [...name].length > 80 || !name.isWellFormed() || /[\u0000-\u001F\u007F]/.test(name)) fail('A name of 1 to 80 characters is needed.');
    id = `mem_${randomBytes(13).toString('hex').toUpperCase()}`;
    sql(`INSERT INTO members(id, name, role, created_at) VALUES(${text(id)}, ${text(name)}, 'owner', ${Date.now()})`);
  }
  const now = Date.now();
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  // A new link replaces an unused one.
  sql(`DELETE FROM access_links WHERE member_id = ${text(id)} AND used_at IS NULL;
INSERT INTO access_links(token_sha256, kind, member_id, created_at, expires_at) VALUES('${hash}', 'owner', ${text(id)}, ${now}, ${now + 900_000});
INSERT INTO audit(at, actor_type, action, subject_id) VALUES(${now}, 'command', 'owner.setup', ${text(id)})`);
  console.log(`\nOpen this once, within 15 minutes, on the device with your passkey:\n\n  ${app}/link#${token}\n`);
  if (owner?.joined_at) console.log('Using it removes your other passkeys and ends your sessions.\n');
}

function makePrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: (question) => rl.question(question),
    close: () => rl.close(),
  };
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'owner' && rest[0] === 'setup') {
  await runOwnerSetup(rest.slice(1));
} else if ((cmd === 'init' || cmd === 'upgrade' || cmd === 'rollback' || cmd === 'destroy') && rest.length === 0) {
  const io = makePrompt();
  try {
    const token = readCloudflareToken();
    const cf = createCloudflareClient({ token });
    if (cmd === 'init') await runInit({ root, cf, prompt: io.prompt });
    else if (cmd === 'upgrade') await runUpgrade({ root, cf });
    else if (cmd === 'rollback') await runRollback({ root, cf });
    else if (cmd === 'destroy') await runDestroy({ root, cf, prompt: io.prompt });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    io.close();
  }
} else {
  fail(USAGE, 2);
}
