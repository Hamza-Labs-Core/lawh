// D1 migration listing and application compatible with Wrangler's d1_migrations table.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_FILE = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

export function listMigrationFiles(migrationsDir) {
  return readdirSync(migrationsDir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
}

export async function ensureMigrationsTable(cf, accountId, dbId) {
  await cf.queryD1(
    accountId,
    dbId,
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
  );
}

export async function listPendingMigrations(cf, accountId, dbId, migrationsDir) {
  await ensureMigrationsTable(cf, accountId, dbId);
  const res = await cf.queryD1(accountId, dbId, 'SELECT name FROM d1_migrations ORDER BY id');
  const applied = new Set((res?.[0]?.results ?? []).map((row) => row.name));
  return listMigrationFiles(migrationsDir).filter((name) => !applied.has(name));
}

export async function applyPendingMigrations(cf, accountId, dbId, migrationsDir, pending) {
  const applied = [];
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    try {
      await cf.queryD1(accountId, dbId, sql);
      await cf.queryD1(accountId, dbId, 'INSERT INTO d1_migrations(name) VALUES(?)', [name]);
      applied.push(name);
    } catch (error) {
      const err = new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      err.migration = name;
      err.cause = error;
      throw err;
    }
  }
  return applied;
}
