import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { ContentEnv } from '../../src/shared/env';

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import('../../src/content/index') }
    interface Env extends ContentEnv { TEST_MIGRATIONS: D1Migration[] }
  }
}
