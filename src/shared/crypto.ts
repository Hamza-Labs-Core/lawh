const encoder = new TextEncoder();

export const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

export const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
/** 32 random bytes, 43 characters. */
export const randomToken = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

export function equalInConstantTime(a: string, b: string): boolean {
  const x = encoder.encode(a), y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** A Secrets Store binding, or a Worker secret where the account has no store. */
export async function readSecret(binding: SecretsStoreSecret | string): Promise<string> {
  const value = typeof binding === 'string' ? binding : await binding.get();
  if (!value || value.length < 32) throw new Error('A secret is missing or too short');
  return value;
}
