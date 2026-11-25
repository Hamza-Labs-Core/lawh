// pnpm dev
import { join } from 'node:path';
import { runLocal } from './local/run.mjs';

const { child, app, content } = runLocal({ port: 8787, state: join(new URL('..', import.meta.url).pathname, '.wrangler/dev') });
console.log(`App ${app}, pages ${content}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
