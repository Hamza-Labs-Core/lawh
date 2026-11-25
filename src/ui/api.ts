export class CallError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Calls the app's own API. A network failure is a CallError with status 0. */
export async function call<T = undefined>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/app-api${path}`, { method, ...(method !== 'GET' && { body: JSON.stringify(body ?? {}), headers: { 'Content-Type': 'application/json' } }), cache: 'no-store' });
  } catch { throw new CallError(0, 'offline'); }
  if (!response.ok) throw new CallError(response.status, await response.json().then((b: { code?: string }) => b.code ?? 'internal', () => 'internal'));
  if (response.status === 202) return 'waiting' as T;
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

/** What to tell the person. */
export const problemOf = (error: unknown): 'offline' | 'wait' | 'failed' =>
  !(error instanceof CallError) ? 'failed' : error.status === 0 ? 'offline' : error.status === 429 ? 'wait' : 'failed';

export interface Me { id: string; name: string; isOwner: boolean; instance: boolean }
