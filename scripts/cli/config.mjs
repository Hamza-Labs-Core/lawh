// Config file management and Wrangler config generation for self-hosted Lawh instances.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CONFIG_FILE = 'lawh.config.json';
export const UPGRADE_STATE_FILE = '.wrangler/lawh-upgrade.json';
export const INIT_SECRETS_FILE = '.wrangler/lawh-init-secrets.json';

export function defaultConfig() {
  return {
    instance: {
      name: { en: 'Lawh', ar: 'لوح' },
      accent: '#e0b15a',
      icon: 'default',
      defaultLang: 'en',
      defaultTheme: 'dark',
    },
    hosts: {
      mode: 'workers.dev',
      app: '',
      content: '',
    },
    secrets: {
      backend: 'secrets_store',
      storeName: 'lawh-secrets',
    },
    workers: {
      app: 'lawh-app',
      content: 'lawh-content',
    },
    resources: {
      accountId: '',
      database: { name: 'lawh', id: '' },
      bucket: { name: 'lawh-files', created: false },
      queue: { name: 'lawh-webhooks', id: '' },
      deadLetterQueue: { name: 'lawh-webhooks-dlq', id: '' },
      secretsStore: { id: '', created: false, secrets: {} },
      workersCreated: { app: false, content: false },
    },
  };
}

export function atomicWriteJson(filePath, data, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  try { chmodSync(tmp, mode); } catch { /* Windows */ }
  renameSync(tmp, filePath);
  try { chmodSync(filePath, mode); } catch { /* Windows */ }
}

export function readConfig(root) {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const base = defaultConfig();
  return {
    ...base,
    ...parsed,
    instance: { ...base.instance, ...parsed.instance, name: { ...base.instance.name, ...parsed.instance?.name } },
    hosts: { ...base.hosts, ...parsed.hosts },
    secrets: { ...base.secrets, ...parsed.secrets },
    workers: { ...base.workers, ...parsed.workers },
    resources: {
      ...base.resources,
      ...parsed.resources,
      database: { ...base.resources.database, ...parsed.resources?.database },
      bucket: { ...base.resources.bucket, ...parsed.resources?.bucket },
      queue: { ...base.resources.queue, ...parsed.resources?.queue },
      deadLetterQueue: { ...base.resources.deadLetterQueue, ...parsed.resources?.deadLetterQueue },
      secretsStore: {
        ...base.resources.secretsStore,
        ...parsed.resources?.secretsStore,
        secrets: { ...parsed.resources?.secretsStore?.secrets },
      },
      workersCreated: { ...base.resources.workersCreated, ...parsed.resources?.workersCreated },
    },
  };
}

export function writeConfig(root, cfg) {
  atomicWriteJson(join(root, CONFIG_FILE), cfg, 0o600);
}

export function readUpgradeState(root) {
  const path = join(root, UPGRADE_STATE_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeUpgradeState(root, state) {
  atomicWriteJson(join(root, UPGRADE_STATE_FILE), state, 0o600);
}

export function validateOrigin(raw, label, { allowLocalHttp = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid https:// origin.`); }
  const local = allowLocalHttp && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.origin !== raw || !/^[a-z0-9.-]+$/.test(url.hostname) || (url.protocol !== 'https:' && !local)) {
    throw new Error(`${label} must be an exact https:// origin with no path, query, or fragment.`);
  }
  return url.origin;
}

export function validateHostPair(appOrigin, contentOrigin, opts = {}) {
  const app = validateOrigin(appOrigin, 'App origin', opts);
  const content = validateOrigin(contentOrigin, 'Content origin', opts);
  if (new URL(app).hostname === new URL(content).hostname) {
    throw new Error('The app and content hosts must use different hostnames.');
  }
  return { app, content };
}

export function validateDisplayName(value, label = 'Name', max = 80) {
  const trimmed = String(value ?? '').trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || [...trimmed].length > max || !trimmed.isWellFormed() || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error(`${label} must be 1 to ${max} printable characters.`);
  }
  return trimmed;
}

export function validateProjectSlug(value) {
  const slug = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new Error('Project slug must use lowercase letters, digits, and hyphens (1-80 characters).');
  }
  return slug;
}

export function generateAppWranglerConfig(cfg) {
  const config = {
    name: cfg.workers.app,
    main: 'src/app/index.ts',
    send_metrics: false,
    compatibility_date: '2026-11-10',
    workers_dev: cfg.hosts.mode === 'workers.dev',
    ...(cfg.hosts.mode === 'custom'
      ? { routes: [{ pattern: new URL(cfg.hosts.app).hostname, custom_domain: true }] }
      : {}),
    d1_databases: [
      {
        binding: 'DB',
        database_name: cfg.resources.database.name,
        database_id: cfg.resources.database.id,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'FILES', bucket_name: cfg.resources.bucket.name }],
    vars: {
      APP_ORIGIN: cfg.hosts.app,
      CONTENT_ORIGIN: cfg.hosts.content,
    },
    ...(cfg.secrets.backend === 'secrets_store' && cfg.resources.secretsStore.id
      ? {
          secrets_store_secrets: [
            { binding: 'PEPPER', store_id: cfg.resources.secretsStore.id, secret_name: 'LAWH_PEPPER' },
            { binding: 'CONTENT_KEY', store_id: cfg.resources.secretsStore.id, secret_name: 'LAWH_CONTENT_KEY' },
            { binding: 'WEBHOOK_KEY', store_id: cfg.resources.secretsStore.id, secret_name: 'LAWH_WEBHOOK_KEY' },
            { binding: 'LIVE_KEY', store_id: cfg.resources.secretsStore.id, secret_name: 'LAWH_LIVE_KEY' },
          ],
        }
      : {}),
    queues: {
      producers: [{ binding: 'WEBHOOKS', queue: cfg.resources.queue.name }],
      consumers: [
        {
          queue: cfg.resources.queue.name,
          max_batch_size: 10,
          max_retries: 5,
          dead_letter_queue: cfg.resources.deadLetterQueue.name,
        },
        { queue: cfg.resources.deadLetterQueue.name, max_batch_size: 10 },
      ],
    },
    ratelimits: [
      { name: 'KEY_LIMIT', namespace_id: '1001', simple: { limit: 1200, period: 60 } },
      { name: 'AUTH_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
      { name: 'SIGNIN_LIMIT', namespace_id: '1003', simple: { limit: 300, period: 60 } },
      { name: 'CODE_LIMIT', namespace_id: '1004', simple: { limit: 5, period: 60 } },
    ],
    triggers: { crons: ['17 * * * *'] },
    assets: { directory: '.build/ui', binding: 'ASSETS', run_worker_first: true, html_handling: 'none' },
    durable_objects: { bindings: [{ name: 'LIVE', class_name: 'LiveProject' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['LiveProject'] }],
  };
  return `// Generated by \`pnpm lawh init\`. Gitignored — never commit this file.\n${JSON.stringify(config, null, 2)}\n`;
}

export function generateContentWranglerConfig(cfg) {
  const config = {
    name: cfg.workers.content,
    main: 'src/content/index.ts',
    send_metrics: false,
    compatibility_date: '2026-11-10',
    workers_dev: cfg.hosts.mode === 'workers.dev',
    ...(cfg.hosts.mode === 'custom'
      ? { routes: [{ pattern: new URL(cfg.hosts.content).hostname, custom_domain: true }] }
      : {}),
    vars: {
      APP_ORIGIN: cfg.hosts.app,
      CONTENT_ORIGIN: cfg.hosts.content,
    },
    ...(cfg.secrets.backend === 'secrets_store' && cfg.resources.secretsStore.id
      ? {
          secrets_store_secrets: [
            { binding: 'CONTENT_KEY', store_id: cfg.resources.secretsStore.id, secret_name: 'LAWH_CONTENT_KEY' },
          ],
        }
      : {}),
    observability: { enabled: true, logs: { invocation_logs: false } },
    d1_databases: [
      {
        binding: 'DB',
        database_name: cfg.resources.database.name,
        database_id: cfg.resources.database.id,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'FILES', bucket_name: cfg.resources.bucket.name }],
  };
  return `// Generated by \`pnpm lawh init\`. Gitignored — never commit this file.\n${JSON.stringify(config, null, 2)}\n`;
}

export function writeWranglerConfigs(root, cfg) {
  writeFileSync(join(root, 'wrangler.app.jsonc'), generateAppWranglerConfig(cfg), { mode: 0o600 });
  writeFileSync(join(root, 'wrangler.content.jsonc'), generateContentWranglerConfig(cfg), { mode: 0o600 });
}
