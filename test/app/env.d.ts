import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { AppEnv } from '../../src/shared/env';

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import('../../src/app/index') }
    interface Env extends AppEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}
