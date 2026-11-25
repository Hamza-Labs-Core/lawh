import type { AppEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';

// Every page of the app is the same document; its script shows the screen for the address.
const PAGES = /^\/(?:|link|device|approve|account|p\/[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,79})$/;
/** Reachable while the instance is off: sign-in, setup, and the files they need. */
const OPEN = /^\/(?:|link)$/;
const ASSET = /^\/assets\/[a-z]+-[A-Za-z0-9]{8}\.(?:js|css)$/;
const read = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD';

export const isOpenPage = (request: Request, url: URL): boolean => read(request) && (OPEN.test(url.pathname) || ASSET.test(url.pathname));

export async function servePage(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!read(request)) return errorResponse('not_found', 'Not found.');
  const asset = ASSET.test(url.pathname);
  if (!asset && !PAGES.test(url.pathname)) return errorResponse('not_found', 'Not found.');
  const response = await env.ASSETS.fetch(new Request(new URL(asset ? url.pathname : '/index.html', url), { method: request.method }));
  if (!response.ok) return errorResponse('not_found', 'Not found.');
  // Only these headers: the rest are the app's own.
  return new Response(response.body, { headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream', 'Cache-Control': asset ? 'public, max-age=31536000, immutable' : 'no-store' } });
}
