import type { AppEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { origins } from '../shared/origin';

// Every page of the app is the same document; its script shows the screen for the address.
const PAGES = /^\/(?:|link|device|approve|connect|decisions|comments|settings(?:\/(?:agents|projects|deleted|data|webhooks|teams|people))?|p\/[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,79})$/;
/** Reachable while the instance is off: sign-in, setup, and the static shell files they link to. */
const OPEN = /^\/(?:|link)$/;
const ASSET = /^\/assets\/[a-z]+-[A-Za-z0-9]{8}\.(?:js|css)$/;
const STATIC_FILES: Record<string, { type: string; cache: string; openWhenOff: boolean }> = {
  '/manifest.webmanifest': { type: 'application/manifest+json; charset=utf-8', cache: 'no-cache', openWhenOff: true },
  '/sw.js': { type: 'application/javascript; charset=utf-8', cache: 'no-cache', openWhenOff: false },
  '/icon.svg': { type: 'image/svg+xml; charset=utf-8', cache: 'public, max-age=86400', openWhenOff: true },
  '/icons/icon-192.png': { type: 'image/png', cache: 'public, max-age=86400', openWhenOff: true },
  '/icons/icon-512.png': { type: 'image/png', cache: 'public, max-age=86400', openWhenOff: true },
  '/icons/icon-maskable-512.png': { type: 'image/png', cache: 'public, max-age=86400', openWhenOff: true },
  '/icons/apple-touch-icon.png': { type: 'image/png', cache: 'public, max-age=86400', openWhenOff: true },
};
const read = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD';

export const isOpenPage = (request: Request, url: URL): boolean =>
  read(request) && (OPEN.test(url.pathname) || ASSET.test(url.pathname) || STATIC_FILES[url.pathname]?.openWhenOff === true);

export async function servePage(request: Request, env: AppEnv, url: URL): Promise<Response> {
  if (!read(request)) return errorResponse('not_found', 'Not found.');
  if (url.pathname === '/connect.md') {
    const response = await env.ASSETS.fetch(new Request(new URL('/connect.md', url), { method: 'GET' }));
    if (!response.ok) return errorResponse('not_found', 'Not found.');
    const body = (await response.text()).replaceAll('{{APP_URL}}', origins(env).app);
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
  if (url.pathname === '/lawh.mjs') {
    const response = await env.ASSETS.fetch(new Request(new URL('/lawh.mjs', url), { method: request.method }));
    if (!response.ok) return errorResponse('not_found', 'Not found.');
    return new Response(response.body, {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
  const asset = ASSET.test(url.pathname);
  const staticFile = STATIC_FILES[url.pathname];
  if (!asset && !staticFile && !PAGES.test(url.pathname)) return errorResponse('not_found', 'Not found.');
  const target = asset || staticFile ? url.pathname : '/index.html';
  const response = await env.ASSETS.fetch(new Request(new URL(target, url), { method: request.method }));
  if (!response.ok) return errorResponse('not_found', 'Not found.');
  // Only these headers: the rest are the app's own.
  const contentType = staticFile?.type ?? response.headers.get('Content-Type') ?? 'application/octet-stream';
  const cacheControl = staticFile?.cache ?? (asset ? 'public, max-age=31536000, immutable' : 'no-store');
  return new Response(response.body, { headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl } });
}
