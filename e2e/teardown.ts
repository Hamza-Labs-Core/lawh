import { rmSync } from 'node:fs';

export default function teardown(): void {
  rmSync(new URL('../.wrangler/e2e', import.meta.url), { recursive: true, force: true });
}
