// Cloudflare v4 REST API client for Lawh self-hosting commands.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiError extends Error {
  constructor(message, { status = 500, code = 0, errors = [] } = {}) {
    super(message);
    this.name = 'CloudflareApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export const isNotFoundError = (err) => err instanceof CloudflareApiError && err.status === 404;

export const isSecretsStoreUnavailable = (err) =>
  err instanceof CloudflareApiError &&
  (err.status === 403 || err.status === 404 || err.status === 409 || err.status === 429 ||
    /limit|quota|access|entitlement|not enabled|not available|permission|already exists/i.test(err.message));

/** Reads CLOUDFLARE_API_TOKEN or Wrangler's saved OAuth token. */
export function readCloudflareToken(env = process.env, homeDir = homedir()) {
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_API_TOKEN.trim()) {
    return env.CLOUDFLARE_API_TOKEN.trim();
  }
  const candidates = [
    env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, '.wrangler/config/default.toml') : null,
    join(homeDir, '.config/.wrangler/config/default.toml'),
    join(homeDir, 'Library/Preferences/.wrangler/config/default.toml'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const match = /^\s*oauth_token\s*=\s*"([^"]+)"/m.exec(text);
    if (match?.[1]) return match[1];
  }
  throw new Error('Not signed in to Cloudflare. Run `lawh login` (or `pnpm lawh login`) or set CLOUDFLARE_API_TOKEN.');
}

export function createCloudflareClient({ apiBase = process.env.CLOUDFLARE_API_BASE_URL || DEFAULT_API_BASE, token, fetchImpl = fetch } = {}) {
  const base = apiBase.replace(/\/+$/, '');

  async function req(method, path, { body, raw = false, withEnvelope = false } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: payload });
    if (raw) {
      if (!res.ok) {
        let msg = `Cloudflare API ${method} ${path} failed (${res.status})`;
        let errors = [];
        try {
          const parsed = await res.json();
          if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
            errors = parsed.errors;
            msg = parsed.errors.map((e) => e.message).join('; ');
          }
        } catch { /* ignore */ }
        throw new CloudflareApiError(msg, { status: res.status, code: errors[0]?.code ?? 0, errors });
      }
      return Buffer.from(await res.arrayBuffer());
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!res.ok || (parsed && parsed.success === false)) {
      const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
      const msg = errors.length > 0
        ? errors.map((e) => e.message).join('; ')
        : `Cloudflare API ${method} ${path} failed (${res.status})`;
      throw new CloudflareApiError(msg, { status: res.status, code: errors[0]?.code ?? 0, errors });
    }
    if (withEnvelope) return { result: parsed?.result ?? null, result_info: parsed?.result_info ?? null };
    return parsed?.result ?? null;
  }

  return {
    apiBase: base,
    listAccounts: () => req('GET', '/accounts'),
    getWorkersSubdomain: (accountId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`),
    createWorkersSubdomain: (accountId, subdomain) =>
      req('PUT', `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, { body: { subdomain } }),

    // D1
    listDatabases: (accountId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/d1/database`),
    createDatabase: (accountId, name) => req('POST', `/accounts/${encodeURIComponent(accountId)}/d1/database`, { body: { name } }),
    deleteDatabase: (accountId, dbId) => req('DELETE', `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(dbId)}`),
    queryD1: (accountId, dbId, sql, params = []) =>
      req('POST', `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(dbId)}/query`, { body: { sql, params } }),
    getD1Bookmark: (accountId, dbId) =>
      req('GET', `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(dbId)}/time_travel/bookmark`),

    // R2
    listBuckets: (accountId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/r2/buckets`),
    createBucket: (accountId, name) => req('POST', `/accounts/${encodeURIComponent(accountId)}/r2/buckets`, { body: { name } }),
    deleteBucket: (accountId, name) => req('DELETE', `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(name)}`),
    listR2Objects: async (accountId, bucket, cursor = '') => {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const { result, result_info } = await req(
        'GET',
        `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects${qs}`,
        { withEnvelope: true },
      );
      const objects = Array.isArray(result) ? result : (result?.objects ?? []);
      const nextCursor = result_info?.cursor ?? result?.cursor ?? '';
      const truncated = Boolean(result_info?.is_truncated ?? result?.truncated ?? false);
      return { objects, cursor: nextCursor, truncated };
    },
    getR2Object: (accountId, bucket, key) =>
      req('GET', `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`, { raw: true }),
    deleteR2Object: (accountId, bucket, key) =>
      req('DELETE', `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`),

    // Queues
    listQueues: (accountId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/queues`),
    createQueue: (accountId, name) => req('POST', `/accounts/${encodeURIComponent(accountId)}/queues`, { body: { queue_name: name } }),
    deleteQueue: (accountId, queueId) => req('DELETE', `/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}`),

    // Secrets Store
    listSecretStores: (accountId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores`),
    createSecretStore: (accountId, name) => req('POST', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores`, { body: { name } }),
    listStoreSecrets: (accountId, storeId) => req('GET', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores/${encodeURIComponent(storeId)}/secrets`),
    createStoreSecret: (accountId, storeId, secret) =>
      req('POST', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores/${encodeURIComponent(storeId)}/secrets`, { body: [secret] }),
    deleteStoreSecret: (accountId, storeId, secretId) =>
      req('DELETE', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores/${encodeURIComponent(storeId)}/secrets/${encodeURIComponent(secretId)}`),
    deleteSecretStore: (accountId, storeId) =>
      req('DELETE', `/accounts/${encodeURIComponent(accountId)}/secrets_store/stores/${encodeURIComponent(storeId)}`),

    // Worker secrets fallback
    putWorkerSecret: (accountId, scriptName, name, text) =>
      req('PUT', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`, {
        body: { name, text, type: 'secret_text' },
      }),

    // Workers versions, deployments, rollback, delete
    workerExists: async (accountId, scriptName) => {
      try {
        await req('GET', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`);
        return true;
      } catch (err) {
        if (isNotFoundError(err)) return false;
        throw err;
      }
    },
    listWorkerDeployments: (accountId, scriptName) =>
      req('GET', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`),
    listWorkerVersions: (accountId, scriptName) =>
      req('GET', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/versions`),
    createWorkerVersion: (accountId, scriptName, metadata) =>
      req('POST', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/versions`, { body: metadata }),
    createWorkerDeployment: (accountId, scriptName, versionId, message) =>
      req('POST', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`, {
        body: {
          strategy: 'percentage',
          versions: [{ version_id: versionId, percentage: 100 }],
          annotations: { 'workers/message': message },
        },
      }),
    deleteWorker: (accountId, scriptName) =>
      req('DELETE', `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`),
  };
}
