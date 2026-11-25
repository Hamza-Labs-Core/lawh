// pnpm lawh owner setup [--local]
// Prints a link that registers one passkey for the owner: once, for 15 minutes. For the first setup, and when every
// passkey of the owner is lost. Whoever can run it controls the copy's Cloudflare account anyway.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './local/jsonc.mjs';

const fail = (message, code = 1) => { console.error(message); process.exit(code); };
const root = fileURLToPath(new URL('..', import.meta.url)), wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const [area, command, ...flags] = process.argv.slice(2), local = flags.includes('--local');
if (area !== 'owner' || command !== 'setup' || flags.some((flag) => flag !== '--local')) fail('Usage: pnpm lawh owner setup [--local]', 2);
const state = process.env.LAWH_LOCAL_STATE ?? join(root, '.wrangler/dev'), config = local ? join(state, 'entry.json') : join(root, 'wrangler.app.jsonc');
if (!existsSync(config)) fail(local ? 'Run `pnpm dev` first.' : 'wrangler.app.jsonc is missing. `pnpm lawh init` makes it.');
// Read before anything is changed: without the address there is no link to print.
const app = new URL(parseJsonc(readFileSync(config, 'utf8')).vars.APP_ORIGIN).origin;

const where = local ? ['--local', '--persist-to', state] : ['--remote'];
const sql = (statements) => JSON.parse(execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', ...where, '--json', '-c', config, '--command', statements],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'inherit'] }).toString());
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
const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex');
// A new link replaces an unused one.
sql(`DELETE FROM access_links WHERE member_id = ${text(id)} AND used_at IS NULL;
INSERT INTO access_links(token_sha256, kind, member_id, created_at, expires_at) VALUES('${hash}', 'owner', ${text(id)}, ${Date.now()}, ${Date.now() + 900_000});
INSERT INTO audit(at, actor_type, action, subject_id) VALUES(${Date.now()}, 'command', 'owner.setup', ${text(id)})`);
console.log(`\nOpen this once, within 15 minutes, on the device with your passkey:\n\n  ${app}/link#${token}\n`);
if (owner?.joined_at) console.log('Using it removes your other passkeys and ends your sessions.\n');
