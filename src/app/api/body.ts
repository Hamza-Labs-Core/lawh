import { ApiError, invalid } from '../../shared/errors';
import { findSecret } from './scan';

const MAX_JSON = 1_500_000; // A D1 row holds at most 2 MB.

/** Reads a JSON object, stopping at the size limit. Also returns the text, for the idempotency check. */
export async function readJson(request: Request): Promise<{ body: Record<string, unknown>; text: string }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_JSON) throw new ApiError('too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  let text: string, body: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await new Blob(chunks).arrayBuffer());
    body = JSON.parse(text);
  } catch {
    throw invalid('The body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('The body must be a JSON object.');
  const at = findSecret(text);
  if (at !== -1) throw new ApiError('secret_found', 'The text looks like it has a key or password in it.', { position: at });
  return { body: body as Record<string, unknown>, text };
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Counts characters as people do (code points), not UTF-16 units. */
export function text(value: unknown, name: string, { min = 0, max }: { min?: number; max: number }): string {
  if (typeof value !== 'string' || value.length > max * 2) throw invalid(`${name} must be text of at most ${max} characters.`);
  const length = [...value].length;
  if (length > max || value.trim().length < min) throw invalid(`${name} must be text of ${min} to ${max} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) || !value.isWellFormed()) throw invalid(`${name} has characters that aren't text.`);
  return value;
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw invalid(`${name} must be one of: ${allowed.join(', ')}.`);
  return value as T;
}

export function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw invalid('The body has a field this API does not know.');
}
