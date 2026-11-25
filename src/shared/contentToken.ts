import { equalInConstantTime } from './crypto';

const HOUR = 3_600_000;
const TOKEN = /^(ver_[0-9A-HJKMNP-TV-Z]{26})\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/;

async function sign(key: string, text: string): Promise<string> {
  const bytes = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', bytes.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, bytes.encode(text)));
  return btoa(String.fromCharCode(...mac)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * A token opens one version of one page for 3 to 4 hours. Its end is a whole hour, so loading a page again within the
 * hour gives the same address and the browser's cache is used.
 */
export async function makeContentToken(key: string, versionId: string, now = Date.now()): Promise<string> {
  const payload = `${versionId}.${(Math.floor(now / HOUR) + 4).toString(36)}`;
  return `${payload}.${await sign(key, payload)}`;
}

/** The version a token opens, or null when it is malformed, changed or over. */
export async function readContentToken(key: string, token: string, now = Date.now()): Promise<string | null> {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, versionId, hour, mac] = match as unknown as [string, string, string, string];
  if (!equalInConstantTime(mac, await sign(key, `${versionId}.${hour}`))) return null;
  return Number.parseInt(hour, 36) * HOUR > now ? versionId : null;
}
