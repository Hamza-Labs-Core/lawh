import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach } from 'vitest';

// Every test starts from a new database, and leaves nothing behind even when it fails.
beforeEach(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(() => reset());
