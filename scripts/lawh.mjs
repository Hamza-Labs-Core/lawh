// Lawh self-hosting CLI:
// lawh <login|init|upgrade|rollback|destroy|self-update|version|owner setup [--local]|owner transfer <member> [--local]>
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createCloudflareClient, readCloudflareToken } from './cli/cloudflare.mjs';
import { runDestroy, runInit, runRollback, runUpgrade } from './cli/commands.mjs';
import { runOwnerTransfer } from './cli/transfer.mjs';
import { parseJsonc } from './local/jsonc.mjs';

const managed = process.env.LAWH_MANAGED_INSTALL === '1';
const bin = managed ? 'lawh' : 'pnpm lawh';

const USAGE = `Usage:
  ${bin} login
  ${bin} init
  ${bin} upgrade
  ${bin} rollback
  ${bin} destroy
  ${bin} owner setup [--local]
  ${bin} owner transfer <member> [--local]
  ${bin} self-update
  ${bin} version`;

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

const root = fileURLToPath(new URL('..', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');

function runWranglerLogin() {
  if (!existsSync(wrangler)) fail('Wrangler is not installed. Run `pnpm install` first.');
  execFileSync(process.execPath, [wrangler, 'login'], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: 'inherit',
  });
}

function openD1(local) {
  const state = process.env.LAWH_LOCAL_STATE ?? join(root, '.wrangler/dev');
  const config = local ? join(state, 'entry.json') : join(root, 'wrangler.app.jsonc');
  if (!existsSync(config)) fail(local ? 'Run `pnpm dev` first.' : `wrangler.app.jsonc is missing. \`${bin} init\` makes it.`);
  const parsedConfig = parseJsonc(readFileSync(config, 'utf8'));
  const accountEnv = !local && typeof parsedConfig.account_id === 'string' && parsedConfig.account_id
    ? { CLOUDFLARE_ACCOUNT_ID: parsedConfig.account_id }
    : {};
  const where = local ? ['--local', '--persist-to', state] : ['--remote'];
  const sql = (statements) => JSON.parse(execFileSync(
    process.execPath,
    [wrangler, 'd1', 'execute', 'DB', ...where, '--json', '-c', config, '--command', statements],
    { cwd: root, env: { ...process.env, ...accountEnv, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString());
  return { parsedConfig, sql };
}

const askOnce = async (question) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); }
  finally { rl.close(); }
};

async function runOwnerSetup(flags) {
  if (flags.some((flag) => flag !== '--local')) fail(USAGE, 2);
  const local = flags.includes('--local');
  const { parsedConfig, sql } = openD1(local);
  // Read before anything is changed: without the address there is no link to print.
  const app = new URL(parsedConfig.vars.APP_ORIGIN).origin;
  const text = (value) => `'${value.replaceAll("'", "''")}'`;

  const [{ results: [owner] }] = sql("SELECT id, name, joined_at FROM members WHERE role = 'owner'");
  let id = owner?.id;
  if (!id) {
    const name = (await askOnce('Your name, as others will see it: ')).trim();
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

async function runOwnerTransferCli(args) {
  const local = args.includes('--local');
  const positional = args.filter((arg) => arg !== '--local');
  if (positional.some((arg) => arg.startsWith('-')) || positional.length !== 1) {
    fail(`Usage: ${bin} owner transfer <member> [--local]`, 2);
  }
  const { sql } = openD1(local);
  try {
    await runOwnerTransfer({ targetArg: positional[0], sql, prompt: askOnce });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}

function runSelfUpdate() {
  if (!managed) {
    console.log('This copy is running from a local repository. To update, run:\n  git pull && pnpm install && pnpm lawh upgrade');
    return;
  }
  const installer = join(root, 'install.sh');
  if (!existsSync(installer)) fail('install.sh is missing from this installation.');
  execFileSync('bash', [installer], { stdio: 'inherit', env: process.env });
}

function printVersion() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`lawh v${pkg.version}`);
}

function makePrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: (question) => rl.question(question),
    close: () => rl.close(),
  };
}

async function ensureCloudflareToken(cmd, io) {
  try {
    return readCloudflareToken();
  } catch (err) {
    if (cmd === 'init' && process.stdin.isTTY && process.stdout.isTTY) {
      const answer = (await io.prompt('Not signed in to Cloudflare yet. Sign in now with Wrangler? [Y/n]: ')).trim().toLowerCase();
      if (!answer || answer === 'y' || answer === 'yes') {
        io.close();
        runWranglerLogin();
        return readCloudflareToken();
      }
    }
    throw err;
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  if (rest.length > 0) fail(USAGE, 2);
  printVersion();
} else if (cmd === 'login' && rest.length === 0) {
  runWranglerLogin();
} else if (cmd === 'self-update' && rest.length === 0) {
  runSelfUpdate();
} else if (cmd === 'owner' && rest[0] === 'setup') {
  await runOwnerSetup(rest.slice(1));
} else if (cmd === 'owner' && rest[0] === 'transfer') {
  await runOwnerTransferCli(rest.slice(1));
} else if ((cmd === 'init' || cmd === 'upgrade' || cmd === 'rollback' || cmd === 'destroy') && rest.length === 0) {
  let io = makePrompt();
  try {
    let token;
    try {
      token = readCloudflareToken();
    } catch (err) {
      if (cmd === 'init' && process.stdin.isTTY && process.stdout.isTTY) {
        token = await ensureCloudflareToken(cmd, io);
        io = makePrompt();
      } else {
        throw err;
      }
    }
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
