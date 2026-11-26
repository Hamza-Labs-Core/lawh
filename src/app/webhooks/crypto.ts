import { hmacHex, readSecret } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { invalid } from '../../shared/errors';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RESERVED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.home.arpa'];

export const MAX_WEBHOOK_HOSTS = 50;
export const MAX_WEBHOOK_URL = 500;

async function aesKey(env: AppEnv, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(await readSecret(env.WEBHOOK_KEY)));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

/** AES-256-GCM with random 12-byte IV and webhook id as AAD so ciphertexts cannot move across webhooks. */
export async function encryptWebhookSecret(env: AppEnv, webhookId: string, secret: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(env, 'encrypt');
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(webhookId) }, key, encoder.encode(secret)));
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, iv.byteLength);
  return out;
}

export async function decryptWebhookSecret(env: AppEnv, webhookId: string, blob: ArrayBuffer | Uint8Array | number[]): Promise<string> {
  const bytes = blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob);
  if (bytes.byteLength <= 12) throw new Error('Invalid webhook secret ciphertext');
  const iv = bytes.subarray(0, 12), cipher = bytes.subarray(12);
  const key = await aesKey(env, 'decrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(webhookId) }, key, cipher);
  return decoder.decode(plain);
}

/** `Lawh-Signature: t=<seconds>,v1=<HMAC-SHA256(secret, t.body)>` (security.md §7). */
export async function signWebhook(secret: string, timestampSeconds: number, body: string): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacHex(secret, `${timestampSeconds}.${body}`)}`;
}

/** Normalize and validate an owner-allowed webhook hostname (public DNS name, no scheme/port/IP/localhost). */
export function normalizeHost(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('Each host must be a hostname.');
  const host = raw.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0 || host.length > 253 || !HOST_RE.test(host) || IPV4_RE.test(host) || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw invalid(`Invalid webhook host: ${raw.slice(0, 60)}`);
  }
  return host;
}

export async function readAllowedHosts(env: AppEnv): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'webhook_hosts'").first<{ value_json: string }>();
  if (!row) return [];
  const parsed: unknown = JSON.parse(row.value_json);
  return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
}

/** HTTPS only, no credentials or fragment, hostname explicitly on the owner's allowlist. */
export function checkWebhookUrl(raw: unknown, allowedHosts: string[]): { url: string; host: string } {
  if (typeof raw !== 'string') throw invalid('url must be a string.');
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_WEBHOOK_URL) throw invalid(`url must be at most ${MAX_WEBHOOK_URL} characters.`);
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw invalid('url must be a valid HTTPS address.'); }
  if (parsed.protocol !== 'https:') throw invalid('Webhooks must use HTTPS.');
  if (parsed.port) throw invalid('Webhook URLs must use the standard HTTPS port.');
  if (parsed.username || parsed.password || parsed.hash) throw invalid('url must not contain credentials or a fragment.');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(host) || IPV4_RE.test(host) || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw invalid('Webhook host is not allowed.');
  }
  if (!allowedHosts.includes(host)) throw invalid('That host is not on the allowed list.');
  return { url: parsed.toString(), host };
}
