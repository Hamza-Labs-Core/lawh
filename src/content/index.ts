import { readContentToken } from '../shared/contentToken';
import { readSecret } from '../shared/crypto';
import type { ContentEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { matchesEtag } from '../shared/etag';
import { guarded } from '../shared/handler';
import { origins } from '../shared/origin';
import { BRIDGE } from './bridge';

/** Security model, section 2. Sent with everything, errors too. */
function contentHeaders(env: ContentEnv): Record<string, string> {
  const { app, content } = origins(env);
  return {
    // `CONTENT`, not 'self': the page's origin is opaque, and 'self' doesn't work reliably for it.
    'Content-Security-Policy': [
      'sandbox allow-scripts', "default-src 'none'", `script-src ${content} 'unsafe-inline' 'wasm-unsafe-eval'`, `style-src ${content} 'unsafe-inline'`,
      `img-src ${content} data: blob:`, `font-src ${content} data:`, `media-src ${content} blob:`, `connect-src ${content}`, "worker-src 'none'",
      "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", `frame-ancestors ${app}`, "webrtc 'block'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), payment=()',
    // Safe: this host uses no cookies. Access comes only from the token in the address.
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-DNS-Prefetch-Control': 'off',
    // So that a copy cached for the frame isn't used for a tab.
    Vary: 'Sec-Fetch-Dest',
  };
}

const notFound = (): Response => errorResponse('not_found', 'Not found.');
const CACHE = 'private, max-age=3600, immutable';

interface FileRow { path: string | null; media_type: string; sha256: string; bytes: number; r2_key: string }

async function serve(request: Request, env: ContentEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();
  // Only inside the app's frame: in its own tab a page has no parent whose frame-src keeps it from navigating away.
  if (request.headers.get('Sec-Fetch-Dest') === 'document') return notFound();
  const url = new URL(request.url);
  const match = /^\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return notFound();
  const versionId = await readContentToken(await readSecret(env.CONTENT_KEY), match[1]!);
  if (versionId === null) return notFound();
  let segments: string[];
  try { segments = match[2]!.split('/').map(decodeURIComponent); } catch { return notFound(); }
  // An encoded slash would give one file two addresses, with different relative links.
  if (segments.some((segment) => segment === '' || segment.includes('/'))) return notFound();
  const path = segments.join('/');

  // Also tells whether the version still exists and its page isn't deleted, for the bridge too.
  const file = await env.DB.prepare(
    `SELECT f.path, f.media_type, f.sha256, f.bytes, b.r2_key FROM page_versions v JOIN pages p ON p.id = v.page_id AND p.deleted_at IS NULL
     LEFT JOIN version_files f ON f.version_id = v.id AND f.path = ? LEFT JOIN blobs b ON b.sha256 = f.sha256 WHERE v.id = ?`,
  ).bind(path, versionId).first<FileRow>();
  if (!file) return notFound();
  if (path === '_lawh/bridge.js') return new Response(request.method === 'HEAD' ? null : BRIDGE, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': CACHE } });
  if (file.path === null) return notFound();

  const html = file.media_type.startsWith('text/html');
  const headers = new Headers({ 'Content-Type': file.media_type, 'Cache-Control': CACHE });
  if (!html) { headers.set('ETag', `"${file.sha256}"`); headers.set('Accept-Ranges', 'bytes'); }
  if (!html && matchesEtag(request.headers.get('If-None-Match'), `"${file.sha256}"`)) return new Response(null, { status: 304, headers });

  if (request.method === 'HEAD') {
    if (!(await env.FILES.head(file.r2_key))) throw new Error('R2 object missing');
    if (!html) headers.set('Content-Length', String(file.bytes));
    return new Response(null, { headers });
  }
  const range = html ? null : readRange(request.headers.get('Range'), file.bytes);
  if (range === 'none') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.bytes}`, 'Cache-Control': 'no-store' } });
  const object = await env.FILES.get(file.r2_key, range ? { range } : {});
  if (!object) throw new Error('R2 object missing');
  if (html) return withBridge(new Response(object.body, { headers }), url, match[1]!, origins(env).app);
  if (!range) {
    headers.set('Content-Length', String(file.bytes));
    return new Response(object.body, { headers });
  }
  headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.bytes}`);
  headers.set('Content-Length', String(range.length));
  return new Response(object.body, { status: 206, headers });
}

/** One byte range of a file, 'none' when it holds none of it, or null to send the whole file (no range, or several). */
function readRange(header: string | null, size: number): { offset: number; length: number } | 'none' | null {
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length === 0 ? 'none' : { offset: size - length, length };
  }
  const first = Number(match[1]), last = match[2] === '' ? size - 1 : Number(match[2]);
  if (match[2] !== '' && last < first) return null;
  return first >= size ? 'none' : { offset: first, length: Math.min(last, size - 1) - first + 1 };
}

/** Adds the bridge at the end of the body, and the theme and language where the page's first style rule can use them. */
function withBridge(response: Response, url: URL, token: string, app: string): Response {
  const mode = url.searchParams.get('mode') === 'light' ? 'light' : 'dark', lang = url.searchParams.get('lang') === 'ar' ? 'ar' : 'en';
  const script = `<script src="/${token}/_lawh/bridge.js" data-app="${app}" data-mode="${mode}" data-lang="${lang}"></script>`;
  let added = false;
  return new HTMLRewriter()
    .on('html', { element(element) { element.setAttribute('data-lawh-mode', mode); element.setAttribute('data-lawh-lang', lang); } })
    .on('html > body', { element(element) { element.onEndTag((tag) => { if (!added) { added = true; tag.before(script, { html: true }); } }); } })
    .onDocument({ end(end) { if (!added) end.append(script, { html: true }); } })
    .transform(response);
}

export default { fetch: guarded<ContentEnv>(serve, contentHeaders) } satisfies ExportedHandler<ContentEnv>;
