// Runs both Workers locally, in one process, with local D1 and R2. Nothing here talks to a deployed copy.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname, bin = join(root, 'node_modules/.bin/wrangler');
export const PEPPER = 'local-development-pepper-not-a-secret', CONTENT_KEY = 'local-development-content-key-not-a-secret';

/** `localhost` is the app and `127.0.0.1` the content host: two host names, so cookies of one never reach the other. */
export function runLocal({ port, state, testing = false }) {
  mkdirSync(state, { recursive: true });
  const app = `http://localhost:${port}`, content = `http://127.0.0.1:${port}`;
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', ...(testing && { CI: '1' }) };
  // The Workers' own development configs, with these hosts. One process runs all three, so one opens the database.
  const configs = ['app', 'content'].map((name) => {
    const config = JSON.parse(readFileSync(join(root, `wrangler.${name}.dev.jsonc`), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    Object.assign(config.vars, { APP_ORIGIN: app, CONTENT_ORIGIN: content, CONTENT_KEY, ...(name === 'app' && { PEPPER }) });
    config.main = join(root, config.main);
    config.d1_databases[0].migrations_dir = join(root, 'migrations');
    const path = join(state, `${name}.json`);
    writeFileSync(path, JSON.stringify(config));
    return path;
  });
  const entry = join(state, 'entry.json');
  writeFileSync(entry, JSON.stringify({
    name: 'lawh-local', main: join(root, 'scripts/local/entry.ts'), compatibility_date: '2026-11-10', send_metrics: false, vars: { TESTING: testing },
    services: [{ binding: 'APP', service: 'lawh-app' }, { binding: 'CONTENT', service: 'lawh-content' }],
    d1_databases: [{ binding: 'DB', database_name: 'lawh', database_id: 'local', migrations_dir: join(root, 'migrations') }],
  }));
  // With no terminal it doesn't ask.
  execFileSync(bin, ['d1', 'migrations', 'apply', 'lawh', '--local', '--persist-to', state, '-c', entry], { cwd: root, env: { ...env, CI: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const child = spawn(bin, ['dev', '-c', entry, ...configs.flatMap((path) => ['-c', path]), '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--inspector-port', '0',
    ...(testing ? ['--log-level', 'warn'] : [])], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
  return { child, app, content };
}
