// pnpm lawh owner setup [--local]
// Prints a link that registers one passkey for the owner: once, for 15 minutes. For the first setup, and when every
// passkey of the owner is lost. Whoever can run it controls the copy's Cloudflare account anyway.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)), bin = join(root, 'node_modules/.bin/wrangler');
const [area, command, ...flags] = process.argv.slice(2), local = flags.includes('--local');
if (area !== 'owner' || command !== 'setup' || flags.some((flag) => flag !== '--local')) {
  console.error('Usage: pnpm lawh owner setup [--local]');
  process.exit(2);
}
const state = join(root, '.wrangler/dev'), config = local ? join(state, 'entry.json') : join(root, 'wrangler.app.jsonc');
if (!existsSync(config)) {
  console.error(local ? 'Run `pnpm dev` first.' : 'wrangler.app.jsonc is missing. `pnpm lawh init` makes it.');
  process.exit(1);
}
const where = local ? ['--local', '--persist-to', state] : ['--remote'];
const sql = (command) => JSON.parse(execFileSync(bin, ['d1', 'execute', 'lawh', ...where, '--json', '-c', config, '--command', command],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'inherit'] }).toString());
const text = (value) => `'${value.replaceAll("'", "''")}'`;

const [{ results: [owner] }] = sql("SELECT id, name FROM members WHERE role = 'owner'");
let id = owner?.id;
if (!id) {
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await ask.question('Your name, as others will see it: ')).trim();
  ask.close();
  if (!name || [...name].length > 80) { console.error('A name of 1 to 80 characters is needed.'); process.exit(1); }
  id = `mem_${randomBytes(16).toString('hex').toUpperCase().slice(0, 26)}`;
  sql(`INSERT INTO members(id, name, role, created_at) VALUES(${text(id)}, ${text(name)}, 'owner', ${Date.now()})`);
}
const token = randomBytes(32).toString('base64url'), hash = createHash('sha256').update(token).digest('hex');
// A new link replaces an unused one.
sql(`DELETE FROM access_links WHERE member_id = ${text(id)} AND used_at IS NULL;
INSERT INTO access_links(token_sha256, kind, member_id, created_at, expires_at) VALUES('${hash}', 'owner', ${text(id)}, ${Date.now()}, ${Date.now() + 900_000});
INSERT INTO audit(at, actor_type, action, subject_id) VALUES(${Date.now()}, 'command', 'owner.setup', ${text(id)})`);
const app = local ? 'http://localhost:8787' : JSON.parse(readFileSync(config, 'utf8').replace(/^\s*\/\/.*$/gm, '')).vars.APP_ORIGIN;
console.log(`\nOpen this once, within 15 minutes, on the device with your passkey:\n\n  ${app}/link#${token}\n`);
if (owner) console.log('Using it removes your other passkeys and ends your sessions.\n');
