// Self-hosting lifecycle commands: init, upgrade, rollback, destroy.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isNotFoundError,
  isSecretsStoreUnavailable,
} from './cloudflare.mjs';
import {
  atomicWriteJson,
  CONFIG_FILE,
  defaultConfig,
  INIT_SECRETS_FILE,
  readConfig,
  readUpgradeState,
  UPGRADE_STATE_FILE,
  validateDisplayName,
  validateHostPair,
  validateProjectSlug,
  writeConfig,
  writeUpgradeState,
  writeWranglerConfigs,
} from './config.mjs';
import { defaultExportDir, exportInstance } from './export.mjs';
import { applyPendingMigrations, listPendingMigrations } from './migrations.mjs';

const SECRET_NAMES = [
  ['PEPPER', 'LAWH_PEPPER'],
  ['CONTENT_KEY', 'LAWH_CONTENT_KEY'],
  ['WEBHOOK_KEY', 'LAWH_WEBHOOK_KEY'],
  ['LIVE_KEY', 'LAWH_LIVE_KEY'],
];

const APP_SECRETS = ['PEPPER', 'CONTENT_KEY', 'WEBHOOK_KEY', 'LIVE_KEY'];
const CONTENT_SECRETS = ['CONTENT_KEY'];

const isYes = (answer, defaultYes = false) => {
  const s = String(answer ?? '').trim().toLowerCase();
  if (!s) return defaultYes;
  return s === 'y' || s === 'yes';
};

function randomSecret() {
  return randomBytes(32).toString('base64url');
}

function ulidLikeId(prefix) {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (const b of randomBytes(26)) out += chars[b % 32];
  return `${prefix}_${out}`;
}

async function currentWorkerVersion(cf, accountId, scriptName) {
  const res = await cf.listWorkerDeployments(accountId, scriptName);
  const deployments = Array.isArray(res) ? res : (res?.deployments ?? []);
  const latest = deployments[0];
  const versionId = latest?.versions?.[0]?.version_id ?? null;
  return versionId;
}

export async function defaultDeployWorker({ root, cf, accountId, workerName, configFile, kind, env = process.env }) {
  if (kind === 'app') {
    execFileSync(process.execPath, [join(root, 'scripts/build-ui.mjs')], {
      cwd: root,
      env: { ...env, WRANGLER_SEND_METRICS: 'false' },
      stdio: 'inherit',
    });
  }
  const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
  execFileSync(process.execPath, [wrangler, 'deploy', '-c', join(root, configFile)], {
    cwd: root,
    env: { ...env, WRANGLER_SEND_METRICS: 'false' },
    stdio: 'inherit',
  });
  return (await currentWorkerVersion(cf, accountId, workerName)) ?? `ver_${randomBytes(8).toString('hex')}`;
}

async function checkHost(fetchImpl, origin, label) {
  const res = await fetchImpl(`${origin}/`, { method: 'GET', redirect: 'manual' });
  if (res.status >= 500) {
    throw new Error(`Health check failed for ${label} (${origin}): HTTP ${res.status}`);
  }
  return res.status;
}

function readInitSecrets(root) {
  const path = join(root, INIT_SECRETS_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeInitSecrets(root, secrets) {
  atomicWriteJson(join(root, INIT_SECRETS_FILE), secrets, 0o600);
}

function removeIfExists(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

async function resolveAccount(cf, cfg, { env = process.env, prompt }) {
  if (cfg.resources.accountId) return cfg.resources.accountId;
  if (env.CLOUDFLARE_ACCOUNT_ID?.trim()) return env.CLOUDFLARE_ACCOUNT_ID.trim();
  const accounts = await cf.listAccounts();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('No Cloudflare accounts found for this token.');
  }
  if (accounts.length === 1) return accounts[0].id;
  const list = accounts.map((a, i) => `  ${i + 1}. ${a.name} (${a.id})`).join('\n');
  const choice = await prompt(`Multiple Cloudflare accounts found:\n${list}\nChoose account number [1]: `);
  const idx = choice.trim() ? Number(choice.trim()) - 1 : 0;
  if (!Number.isInteger(idx) || idx < 0 || idx >= accounts.length) {
    throw new Error('Invalid account choice.');
  }
  return accounts[idx].id;
}

export async function runInit({
  root,
  cf,
  prompt,
  log = (msg) => console.log(msg),
  deployWorker = defaultDeployWorker,
  env = process.env,
  now = () => Date.now(),
  allowLocalHttp = false,
}) {
  const existing = readConfig(root);
  const cfg = existing ?? defaultConfig();

  // Step 1: Account, instance name (en & ar), hosts.
  const accountId = await resolveAccount(cf, cfg, { env, prompt });
  cfg.resources.accountId = accountId;

  if (!existing?.hosts?.app || !existing?.hosts?.content) {
    const enRaw = (await prompt(`Instance name (English) [${cfg.instance.name.en}]: `)).trim();
    const arRaw = (await prompt(`Instance name (Arabic) [${cfg.instance.name.ar}]: `)).trim();
    cfg.instance.name.en = validateDisplayName(enRaw || cfg.instance.name.en, 'English instance name', 60);
    cfg.instance.name.ar = validateDisplayName(arRaw || cfg.instance.name.ar, 'Arabic instance name', 60);

    const hostModeRaw = (await prompt('Hosts — press Enter for workers.dev, or type "custom" to use your own domain [workers.dev]: ')).trim().toLowerCase();
    if (hostModeRaw === 'custom') {
      const appRaw = (await prompt('App origin (e.g. https://lawh.example.com): ')).trim();
      const contentRaw = (await prompt('Content origin (must be a different host, e.g. https://lawh-content.example.com): ')).trim();
      const pair = validateHostPair(appRaw, contentRaw, { allowLocalHttp });
      cfg.hosts = { mode: 'custom', app: pair.app, content: pair.content };
    } else if (!hostModeRaw || hostModeRaw === 'workers.dev') {
      const sub = await cf.getWorkersSubdomain(accountId);
      const subdomain = sub?.subdomain;
      if (!subdomain) throw new Error('Cloudflare account does not have a workers.dev subdomain configured.');
      const pair = validateHostPair(
        `https://${cfg.workers.app}.${subdomain}.workers.dev`,
        `https://${cfg.workers.content}.${subdomain}.workers.dev`,
        { allowLocalHttp },
      );
      cfg.hosts = { mode: 'workers.dev', app: pair.app, content: pair.content };
    } else {
      throw new Error('Hosts choice must be "workers.dev" or "custom".');
    }
    writeConfig(root, cfg);
  }

  // Step 2: Plan + cost notes + explicit yes.
  if (!cfg.initConfirmed) {
    log([
      '',
      'Lawh will create in your Cloudflare account:',
      `  - D1 database:      ${cfg.resources.database.name}`,
      `  - R2 bucket:        ${cfg.resources.bucket.name}`,
      `  - Queues:           ${cfg.resources.queue.name} and ${cfg.resources.deadLetterQueue.name}`,
      `  - Secrets:          ${cfg.secrets.backend === 'secrets_store' ? `Secrets Store (${cfg.secrets.storeName}, falls back to Worker secrets if unavailable)` : 'Worker secrets'}`,
      `  - Workers:          ${cfg.workers.app} (with LiveProject Durable Object) and ${cfg.workers.content}`,
      `  - Hosts:            ${cfg.hosts.app} and ${cfg.hosts.content}`,
      '',
      'Cost notes:',
      '  - Cloudflare Workers Paid plan is required ($5/month per account).',
      '  - Typical usage is ~$0.22/month (small) to ~$2.20/month (medium); workers.dev and custom domain certificates are included.',
      '  - Both Workers deploy with the `instance` switch OFF until you confirm.',
      '',
    ].join('\n'));
    const confirm = await prompt('Create these resources and deploy? [y/N]: ');
    if (!isYes(confirm, false)) {
      throw new Error('Cancelled before creating resources.');
    }
    cfg.initConfirmed = true;
    writeConfig(root, cfg);
  }

  // Step 3: Create D1, R2, Queues, secrets, and write generated Wrangler configs (each persisted immediately for resume).
  if (!cfg.resources.database.id) {
    const db = await cf.createDatabase(accountId, cfg.resources.database.name);
    cfg.resources.database.id = db.uuid ?? db.id;
    writeConfig(root, cfg);
  }

  if (!cfg.resources.bucket.created) {
    await cf.createBucket(accountId, cfg.resources.bucket.name);
    cfg.resources.bucket.created = true;
    writeConfig(root, cfg);
  }

  if (!cfg.resources.deadLetterQueue.id) {
    const dlq = await cf.createQueue(accountId, cfg.resources.deadLetterQueue.name);
    cfg.resources.deadLetterQueue.id = dlq.queue_id ?? dlq.id;
    writeConfig(root, cfg);
  }

  if (!cfg.resources.queue.id) {
    const queue = await cf.createQueue(accountId, cfg.resources.queue.name);
    cfg.resources.queue.id = queue.queue_id ?? queue.id;
    writeConfig(root, cfg);
  }

  // Generate local secrets once per interrupted init so CONTENT_KEY stays identical across resumes.
  let localSecrets = readInitSecrets(root);
  if (!localSecrets) {
    localSecrets = {
      PEPPER: randomSecret(),
      CONTENT_KEY: randomSecret(),
      WEBHOOK_KEY: randomSecret(),
      LIVE_KEY: randomSecret(),
    };
    writeInitSecrets(root, localSecrets);
  }

  if (cfg.secrets.backend === 'secrets_store') {
    try {
      if (!cfg.resources.secretsStore.id) {
        const store = await cf.createSecretStore(accountId, cfg.secrets.storeName);
        cfg.resources.secretsStore.id = store.id;
        cfg.resources.secretsStore.created = true;
        writeConfig(root, cfg);
      }
      for (const [binding, secretName] of SECRET_NAMES) {
        if (cfg.resources.secretsStore.secrets[secretName]) continue;
        const created = await cf.createStoreSecret(accountId, cfg.resources.secretsStore.id, {
          name: secretName,
          value: localSecrets[binding],
          scopes: ['workers'],
        });
        const entry = Array.isArray(created) ? created[0] : created;
        cfg.resources.secretsStore.secrets[secretName] = entry?.id ?? secretName;
        writeConfig(root, cfg);
      }
    } catch (err) {
      if (!isSecretsStoreUnavailable(err)) throw err;
      log(`Secrets Store unavailable (${err.message}); falling back to Worker secrets.`);
      cfg.secrets.backend = 'worker_secrets';
      writeConfig(root, cfg);
    }
  }

  writeWranglerConfigs(root, cfg);

  // Step 4: Apply migrations and deploy both Workers with the `instance` switch off.
  const migrationsDir = join(root, 'migrations');
  const pending = await listPendingMigrations(cf, accountId, cfg.resources.database.id, migrationsDir);
  if (pending.length > 0) {
    await applyPendingMigrations(cf, accountId, cfg.resources.database.id, migrationsDir, pending);
  }

  if (!cfg.resources.workersCreated.app) {
    await deployWorker({
      root,
      cf,
      accountId,
      workerName: cfg.workers.app,
      configFile: 'wrangler.app.jsonc',
      kind: 'app',
      env,
    });
    cfg.resources.workersCreated.app = true;
    writeConfig(root, cfg);
  }

  if (!cfg.resources.workersCreated.content) {
    await deployWorker({
      root,
      cf,
      accountId,
      workerName: cfg.workers.content,
      configFile: 'wrangler.content.jsonc',
      kind: 'content',
      env,
    });
    cfg.resources.workersCreated.content = true;
    writeConfig(root, cfg);
  }

  if (cfg.secrets.backend === 'worker_secrets' && !cfg.secrets.workerSecretsUploaded) {
    for (const name of APP_SECRETS) {
      await cf.putWorkerSecret(accountId, cfg.workers.app, name, localSecrets[name]);
    }
    for (const name of CONTENT_SECRETS) {
      await cf.putWorkerSecret(accountId, cfg.workers.content, name, localSecrets[name]);
    }
    cfg.secrets.workerSecretsUploaded = true;
    writeConfig(root, cfg);
  }
  removeIfExists(join(root, INIT_SECRETS_FILE));

  // Step 5: Owner display name, first project, confirm turning `instance` on, and create owner setup link.
  const ownerRes = await cf.queryD1(accountId, cfg.resources.database.id, "SELECT id, name, joined_at FROM members WHERE role = 'owner'");
  let owner = ownerRes?.[0]?.results?.[0] ?? null;
  if (!owner) {
    const ownerName = validateDisplayName(await prompt('Your name, as others will see it: '), 'Owner name', 80);
    const ownerId = ulidLikeId('mem');
    await cf.queryD1(
      accountId,
      cfg.resources.database.id,
      "INSERT INTO members(id, name, role, created_at) VALUES(?, ?, 'owner', ?)",
      [ownerId, ownerName, now()],
    );
    owner = { id: ownerId, name: ownerName, joined_at: null };
  }

  const projRes = await cf.queryD1(accountId, cfg.resources.database.id, 'SELECT id, slug FROM projects LIMIT 1');
  let project = projRes?.[0]?.results?.[0] ?? null;
  if (!project) {
    const slugRaw = (await prompt('First project slug [general]: ')).trim();
    const slug = validateProjectSlug(slugRaw || 'general');
    const enDefault = slug.charAt(0).toUpperCase() + slug.slice(1);
    const nameEnRaw = (await prompt(`First project name (English) [${enDefault}]: `)).trim();
    const nameEn = validateDisplayName(nameEnRaw || enDefault, 'Project name (English)', 80);
    const nameArRaw = (await prompt(`First project name (Arabic) [${nameEn}]: `)).trim();
    const nameAr = validateDisplayName(nameArRaw || nameEn, 'Project name (Arabic)', 80);
    const projectId = ulidLikeId('prj');
    await cf.queryD1(
      accountId,
      cfg.resources.database.id,
      'INSERT INTO projects(id, slug, name_en, name_ar, created_at) VALUES(?, ?, ?, ?, ?)',
      [projectId, slug, nameEn, nameAr, now()],
    );
    project = { id: projectId, slug };
  }

  const switchRes = await cf.queryD1(accountId, cfg.resources.database.id, "SELECT value_json FROM settings WHERE key = 'instance'");
  let instanceOn = switchRes?.[0]?.results?.[0]?.value_json === 'true';
  if (!instanceOn) {
    const turnOn = await prompt('Turn the instance switch ON so your copy can accept requests? [y/N]: ');
    if (isYes(turnOn, false)) {
      const ts = now();
      await cf.queryD1(
        accountId,
        cfg.resources.database.id,
        "INSERT INTO settings(key, value_json, updated_at) VALUES('instance', 'true', ?) ON CONFLICT(key) DO UPDATE SET value_json='true', updated_at=excluded.updated_at",
        [ts],
      );
      await cf.queryD1(
        accountId,
        cfg.resources.database.id,
        "INSERT INTO audit(at, actor_type, action, subject_id) VALUES(?, 'command', 'switch.instance.on', ?)",
        [ts, owner.id],
      );
      instanceOn = true;
    } else {
      log('Instance switch remains OFF. Turn it on in Settings after signing in.');
    }
  }

  const ts = now();
  const token = randomBytes(32).toString('base64url');
  const tokenSha256 = createHash('sha256').update(token).digest('hex');
  await cf.queryD1(
    accountId,
    cfg.resources.database.id,
    'DELETE FROM access_links WHERE member_id = ? AND used_at IS NULL',
    [owner.id],
  );
  await cf.queryD1(
    accountId,
    cfg.resources.database.id,
    "INSERT INTO access_links(token_sha256, kind, member_id, created_at, expires_at) VALUES(?, 'owner', ?, ?, ?)",
    [tokenSha256, owner.id, ts, ts + 900_000],
  );
  await cf.queryD1(
    accountId,
    cfg.resources.database.id,
    "INSERT INTO audit(at, actor_type, action, subject_id) VALUES(?, 'command', 'owner.setup', ?)",
    [ts, owner.id],
  );

  const setupLink = `${cfg.hosts.app}/link#${token}`;
  log(`\nOpen this once, within 15 minutes, on the device with your passkey:\n\n  ${setupLink}\n`);
  cfg.initCompletedAt = ts;
  writeConfig(root, cfg);

  return { config: cfg, owner, project, instanceOn, setupLink };
}

export async function runUpgrade({
  root,
  cf,
  log = (msg) => console.log(msg),
  deployWorker = defaultDeployWorker,
  fetchImpl = fetch,
  env = process.env,
  now = () => Date.now(),
}) {
  const cfg = readConfig(root);
  if (!cfg || !cfg.resources.accountId || !cfg.resources.database.id) {
    throw new Error(`${CONFIG_FILE} is missing or incomplete. Run \`pnpm lawh init\` first.`);
  }
  const accountId = cfg.resources.accountId;
  writeWranglerConfigs(root, cfg);

  const migrationsDir = join(root, 'migrations');
  const pending = await listPendingMigrations(cf, accountId, cfg.resources.database.id, migrationsDir);
  if (pending.length === 0) {
    log('Pending migrations: none');
  } else {
    log(`Pending migrations (${pending.length}):\n${pending.map((m) => `  - ${m}`).join('\n')}`);
  }

  // Preserve pre-upgrade bookmark & Worker version IDs if resuming an interrupted upgrade.
  const prior = readUpgradeState(root);
  let state;
  if (prior?.inProgress && prior.previousVersions?.app && prior.previousVersions?.content) {
    state = prior;
  } else {
    const bookmarkRes = await cf.getD1Bookmark(accountId, cfg.resources.database.id);
    const bookmark = bookmarkRes?.bookmark;
    if (!bookmark) throw new Error('Could not record D1 Time Travel bookmark before upgrade.');
    const [appPrev, contentPrev] = await Promise.all([
      currentWorkerVersion(cf, accountId, cfg.workers.app),
      currentWorkerVersion(cf, accountId, cfg.workers.content),
    ]);
    if (!appPrev || !contentPrev) {
      throw new Error('Could not determine current deployed Worker version IDs before upgrade.');
    }
    state = {
      inProgress: true,
      startedAt: now(),
      bookmark,
      previousVersions: { app: appPrev, content: contentPrev },
      newVersions: { app: null, content: null },
      appliedMigrations: [],
    };
    writeUpgradeState(root, state);
  }

  log(`Recorded D1 Time Travel bookmark: ${state.bookmark}`);
  log(`Recorded Worker versions: ${cfg.workers.app}=${state.previousVersions.app}, ${cfg.workers.content}=${state.previousVersions.content}`);

  if (pending.length > 0) {
    try {
      const applied = await applyPendingMigrations(cf, accountId, cfg.resources.database.id, migrationsDir, pending);
      state.appliedMigrations = [...(state.appliedMigrations ?? []), ...applied];
      writeUpgradeState(root, state);
    } catch (err) {
      const restoreCmd = `pnpm exec wrangler d1 time-travel restore ${cfg.resources.database.name} --bookmark=${state.bookmark} -c wrangler.app.jsonc`;
      log(`\nMigration failed (${err.message}).\nRestore the database to its pre-upgrade bookmark with:\n\n  ${restoreCmd}\n`);
      err.restoreCommand = restoreCmd;
      throw err;
    }
  }

  if (!state.newVersions.app) {
    state.newVersions.app = await deployWorker({
      root,
      cf,
      accountId,
      workerName: cfg.workers.app,
      configFile: 'wrangler.app.jsonc',
      kind: 'app',
      env,
    });
    writeUpgradeState(root, state);
  }

  if (!state.newVersions.content) {
    state.newVersions.content = await deployWorker({
      root,
      cf,
      accountId,
      workerName: cfg.workers.content,
      configFile: 'wrangler.content.jsonc',
      kind: 'content',
      env,
    });
    writeUpgradeState(root, state);
  }

  const appStatus = await checkHost(fetchImpl, cfg.hosts.app, cfg.workers.app);
  const contentStatus = await checkHost(fetchImpl, cfg.hosts.content, cfg.workers.content);
  state.inProgress = false;
  state.completedAt = now();
  writeUpgradeState(root, state);

  log(`Upgrade complete. Checked ${cfg.hosts.app} (HTTP ${appStatus}) and ${cfg.hosts.content} (HTTP ${contentStatus}).`);
  return { state, appStatus, contentStatus };
}

export async function runRollback({
  root,
  cf,
  log = (msg) => console.log(msg),
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const cfg = readConfig(root);
  if (!cfg || !cfg.resources.accountId) {
    throw new Error(`${CONFIG_FILE} is missing or incomplete.`);
  }
  const state = readUpgradeState(root);
  if (!state?.previousVersions?.app || !state?.previousVersions?.content) {
    throw new Error(`No previous Worker version IDs recorded in ${UPGRADE_STATE_FILE}.`);
  }
  const accountId = cfg.resources.accountId;

  await cf.createWorkerDeployment(accountId, cfg.workers.app, state.previousVersions.app, 'lawh rollback');
  await cf.createWorkerDeployment(accountId, cfg.workers.content, state.previousVersions.content, 'lawh rollback');

  const appStatus = await checkHost(fetchImpl, cfg.hosts.app, cfg.workers.app);
  const contentStatus = await checkHost(fetchImpl, cfg.hosts.content, cfg.workers.content);

  state.inProgress = false;
  state.rolledBackAt = now();
  writeUpgradeState(root, state);

  log(`Rolled back ${cfg.workers.app} -> ${state.previousVersions.app} and ${cfg.workers.content} -> ${state.previousVersions.content}.`);
  return { restored: state.previousVersions, appStatus, contentStatus };
}

async function ignoreNotFound(fn) {
  try {
    await fn();
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

export async function runDestroy({
  root,
  cf,
  prompt,
  log = (msg) => console.log(msg),
  homeDir = homedir(),
  now = () => Date.now(),
}) {
  const cfg = readConfig(root);
  if (!cfg || !cfg.resources.accountId) {
    throw new Error(`${CONFIG_FILE} is missing or incomplete.`);
  }
  const accountId = cfg.resources.accountId;

  let exportResult = null;
  if (cfg.resources.database.id) {
    const wantExport = await prompt('Export a backup ZIP (rows + files, without search index) before deleting? [Y/n]: ');
    if (isYes(wantExport, true)) {
      const defDir = defaultExportDir(homeDir);
      const chosen = (await prompt(`Export folder (must be outside this repository) [${defDir}]: `)).trim();
      exportResult = await exportInstance({
        cf,
        accountId,
        dbId: cfg.resources.database.id,
        bucketName: cfg.resources.bucket.name,
        exportDir: chosen || defDir,
        repoRoot: root,
        homeDir,
        now: now(),
      });
      log(`Backup exported to ${exportResult.zipPath} (${exportResult.fileCount} files, ${exportResult.bytes} bytes).`);
    }
  }

  const expectedName = cfg.instance.name.en;
  const typed = (await prompt(`Type the instance name (${expectedName}) to permanently delete this copy: `)).trim();
  if (typed !== expectedName) {
    throw new Error('Instance name did not match. Nothing was deleted.');
  }

  // Delete ONLY resources recorded in lawh.config.json; each step is idempotent on 404.
  if (cfg.resources.workersCreated.content) {
    await ignoreNotFound(() => cf.deleteWorker(accountId, cfg.workers.content));
    cfg.resources.workersCreated.content = false;
    writeConfig(root, cfg);
  }

  if (cfg.resources.workersCreated.app) {
    await ignoreNotFound(() => cf.deleteWorker(accountId, cfg.workers.app));
    cfg.resources.workersCreated.app = false;
    writeConfig(root, cfg);
  }

  if (cfg.resources.bucket.created) {
    await ignoreNotFound(async () => {
      let cursor = '';
      for (;;) {
        const listing = await cf.listR2Objects(accountId, cfg.resources.bucket.name, cursor);
        const objects = Array.isArray(listing) ? listing : (listing?.objects ?? []);
        for (const obj of objects) {
          await ignoreNotFound(() => cf.deleteR2Object(accountId, cfg.resources.bucket.name, obj.key));
        }
        const next = listing?.cursor ?? '';
        if (!listing?.truncated || !next) break;
        cursor = next;
      }
      await cf.deleteBucket(accountId, cfg.resources.bucket.name);
    });
    cfg.resources.bucket.created = false;
    writeConfig(root, cfg);
  }

  if (cfg.resources.queue.id) {
    await ignoreNotFound(() => cf.deleteQueue(accountId, cfg.resources.queue.id));
    cfg.resources.queue.id = '';
    writeConfig(root, cfg);
  }

  if (cfg.resources.deadLetterQueue.id) {
    await ignoreNotFound(() => cf.deleteQueue(accountId, cfg.resources.deadLetterQueue.id));
    cfg.resources.deadLetterQueue.id = '';
    writeConfig(root, cfg);
  }

  if (cfg.resources.database.id) {
    await ignoreNotFound(() => cf.deleteDatabase(accountId, cfg.resources.database.id));
    cfg.resources.database.id = '';
    writeConfig(root, cfg);
  }

  if (cfg.resources.secretsStore.id) {
    for (const [name, secretId] of Object.entries(cfg.resources.secretsStore.secrets)) {
      await ignoreNotFound(() => cf.deleteStoreSecret(accountId, cfg.resources.secretsStore.id, secretId));
      delete cfg.resources.secretsStore.secrets[name];
      writeConfig(root, cfg);
    }
    if (cfg.resources.secretsStore.created) {
      await ignoreNotFound(() => cf.deleteSecretStore(accountId, cfg.resources.secretsStore.id));
    }
    cfg.resources.secretsStore.id = '';
    cfg.resources.secretsStore.created = false;
    writeConfig(root, cfg);
  }

  removeIfExists(join(root, 'wrangler.app.jsonc'));
  removeIfExists(join(root, 'wrangler.content.jsonc'));
  removeIfExists(join(root, UPGRADE_STATE_FILE));
  removeIfExists(join(root, INIT_SECRETS_FILE));
  removeIfExists(join(root, CONFIG_FILE));

  log('Deleted all Lawh resources and removed local instance configuration.');
  return { exportResult };
}
