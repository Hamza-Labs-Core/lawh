import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const worker = (name: 'app' | 'content') => ({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: `./wrangler.${name}.dev.jsonc` },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')) } },
    })),
  ],
  test: { name, include: [`test/${name}/**/*.test.ts`], setupFiles: ['./test/shared/migrate.ts'], retry: 0 },
});

export default defineConfig({ test: { projects: [worker('app'), worker('content'), { test: { name: 'ui', include: ['test/ui/**/*.test.ts'], retry: 0 } }] } });
