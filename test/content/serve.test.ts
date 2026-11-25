import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContentToken, readContentToken } from '../../src/shared/contentToken';

const KEY = env.CONTENT_KEY as string, HOUR = 3_600_000;
const VERSION = `ver_${'0'.repeat(26)}`, OTHER = `ver_${'1'.repeat(26)}`;
const sql = (...statements: string[]) => env.DB.batch(statements.map((s) => env.DB.prepare(s)));
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`http://localhost:8788${path}`, init));
const FILES: Record<string, [string, string]> = {
  'index.html': ['text/html; charset=utf-8', '<!doctype html><html lang="en"><head><title>T</title></head><body><h1>Hi</h1></body></html>'],
  'bare.html': ['text/html; charset=utf-8', '<h1>No html element</h1>'],
  'a b/صورة #1?.png': ['image/png', '0123456789'],
  'template.html': ['text/html; charset=utf-8', '<html><head><template><body>x</body></template></head><body>y</body></html>'],
  'app.js': ['text/javascript; charset=utf-8', 'export default 1'],
  '100%.txt': ['text/plain; charset=utf-8', 'percent'],
};

let token: string;
beforeEach(async () => {
  await sql(
    "INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1)",
    "INSERT INTO projects(id,slug,name_en,name_ar,created_at) VALUES('p1','one','One','واحد',1)",
    "INSERT INTO members(id,name,role,created_at) VALUES('o','Owner','owner',1)", 'UPDATE members SET joined_at=1',
    "INSERT INTO agents(id,member_id,name,created_at) VALUES('a','o','bot',1)",
    "INSERT INTO agent_keys(id,agent_id,secret_hmac,scopes_json,created_at,expires_at) VALUES('k','a','h','[]',1,9)",
    "INSERT INTO pages(id,project_id,slug,title,created_by,created_at,updated_at) VALUES('g','p1','s','T','a',1,1)",
    `INSERT INTO page_versions VALUES('${VERSION}','g',1,'index.html','',1,1,'a','k',1),('${OTHER}','g',2,'index.html','',1,1,'a','k',1)`,
    "INSERT INTO blobs(sha256,r2_key,bytes,created_at) VALUES('secret','blobs/secret',6,1)",
    `INSERT INTO version_files VALUES('${OTHER}','other.txt','secret','text/plain; charset=utf-8',6)`,
  );
  await env.FILES.put('blobs/secret', 'secret');
  for (const [i, [path, [type, body]]] of Object.entries(FILES).entries()) {
    await env.FILES.put(`blobs/${i}`, body);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO blobs(sha256,r2_key,bytes,created_at) VALUES(?,?,?,1)').bind(`h${i}`, `blobs/${i}`, body.length),
      env.DB.prepare('INSERT INTO version_files VALUES(?,?,?,?,?)').bind(VERSION, path, `h${i}`, type, body.length),
    ]);
  }
  token = await makeContentToken(KEY, VERSION);
});

describe('content tokens', () => {
  const now = Date.UTC(2026, 10, 25, 9, 20);

  it('opens one version for 3 to 4 hours, and is the same within an hour', async () => {
    const t = await makeContentToken(KEY, VERSION, now);
    expect(await readContentToken(KEY, t, now)).toBe(VERSION);
    expect(await readContentToken(KEY, t, now + 3 * HOUR)).toBe(VERSION);
    expect(await readContentToken(KEY, t, now + 4 * HOUR)).toBeNull();
    expect(await makeContentToken(KEY, VERSION, now + HOUR / 2)).toBe(t);
    expect(await makeContentToken(KEY, VERSION, now + HOUR)).not.toBe(t);
    expect(await makeContentToken(KEY, OTHER, now)).not.toBe(t);
  });

  it('refuses any change to it', async () => {
    const t = await makeContentToken(KEY, VERSION, now), [version, hour, mac] = t.split('.') as [string, string, string];
    const later = (Number.parseInt(hour, 36) + 1).toString(36), flipped = mac[0] === 'A' ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;
    for (const bad of ['', 'x', `${OTHER}.${hour}.${mac}`, `${version}.${later}.${mac}`, `${version}.0${hour}.${mac}`, `${version}.${hour.toUpperCase()}.${mac}`,
      `${version}.${hour}.${flipped}`, `${version}.${hour}.${mac}=`, `${version}.${hour}`, `${t}.x`, t.toLowerCase(), `${version}.${hour}.${mac.slice(0, -1)}`]) {
      expect(await readContentToken(KEY, bad, now), bad).toBeNull();
    }
    expect(await readContentToken(`${KEY}x`, t, now)).toBeNull();
  });
});

describe('files', () => {
  it.each(Object.keys(FILES).filter((p) => !p.endsWith('.html')))('serves %s as its type', async (path) => {
    const response = await call(`/${token}/${path.split('/').map(encodeURIComponent).join('/')}`);
    expect([response.status, response.headers.get('Content-Type'), await response.text()]).toEqual([200, ...FILES[path]!]);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=3600, immutable');
    expect(response.headers.get('Content-Length')).toBe(String(FILES[path]![1].length));
  });

  it('answers 404 to everything else', async () => {
    const paths = ['/', '/x', `/${token}`, `/${token}/`, `/${token}/nope.html`, `/${token}/other.txt`, `/${token}/INDEX.html`, `/${token}//index.html`, `/${token}/index.html/`,
      `/${token}/%E0%A4%A`, `/${token}/%2e%2e/index.html`, `/${token}/_lawh%2Fbridge.js`, `/${token}/${encodeURIComponent('a b/صورة #1?.png')}`, `/${token}/_lawh/nope.js`, `/${token}/_lawh/`, `/x/index.html`, `/${token}x/index.html`, '/v1/me', '/robots.txt'];
    for (const path of paths) {
      const response = await call(path);
      expect([path, response.status, response.headers.get('Cache-Control')]).toEqual([path, 404, 'no-store']);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await call(`/${token}/app.js`, { method })).status, method).toBe(404);
  });

  it('answers 404 to a tab of its own, and the file to everything else', async () => {
    for (const path of ['index.html', 'app.js', '_lawh/bridge.js']) {
      expect((await call(`/${token}/${path}`, { headers: { 'Sec-Fetch-Dest': 'document' } })).status).toBe(404);
      for (const dest of ['iframe', 'script', 'image', 'empty', 'font']) {
        const response = await call(`/${token}/${path}`, { headers: { 'Sec-Fetch-Dest': dest } });
        expect([response.status, response.headers.get('Vary')]).toEqual([200, 'Sec-Fetch-Dest']);
      }
    }
  });

  it('answers 404 for another version, an expired token, a deleted page and a purged version', async () => {
    expect((await call(`/${await makeContentToken(KEY, OTHER)}/app.js`)).status).toBe(404);
    expect((await call(`/${await makeContentToken(KEY, VERSION, Date.now() - 4 * HOUR)}/app.js`)).status).toBe(404);
    expect((await call(`/${await makeContentToken(KEY, `ver_${'2'.repeat(26)}`)}/_lawh/bridge.js`)).status).toBe(404);
    for (const path of ['app.js', 'index.html', '_lawh/bridge.js']) {
      await sql('UPDATE pages SET deleted_at=1');
      expect((await call(`/${token}/${path}`)).status, path).toBe(404);
      await sql('UPDATE pages SET deleted_at=NULL');
      expect((await call(`/${token}/${path}`)).status, path).toBe(200);
    }
  });

  it('fails closed when the key or an origin is missing or wrong', async () => {
    const { default: worker } = await import('../../src/content/index');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const change of [{ CONTENT_KEY: '' }, { CONTENT_KEY: 'short' }, { APP_ORIGIN: 'https://a.example.com/x' }, { CONTENT_ORIGIN: 'http://a.example.com' }, { APP_ORIGIN: "https://a.example.com; script-src *" }, { APP_ORIGIN: 'https://a"b.example.com' }, { APP_ORIGIN: 'https://a;b.example.com' }, { CONTENT_ORIGIN: "https://a'b.example.com" }, { CONTENT_ORIGIN: '*' }, { CONTENT_ORIGIN: env.APP_ORIGIN }]) {
        const response = await worker.fetch(new Request(`http://localhost:8788/${token}/app.js`) as Request<unknown, IncomingRequestCfProperties>, { ...env, ...change }, {} as ExecutionContext);
        expect([response.status, response.headers.get('Content-Security-Policy')!.includes('sandbox')], JSON.stringify(change)).toEqual([500, true]);
      }
    } finally { log.mockRestore(); }
  });

  it('answers 500, not 416, when R2 fails, and reads no body for HEAD', async () => {
    const { default: worker } = await import('../../src/content/index');
    const run = (init: RequestInit, get: () => Promise<never>) => worker.fetch(new Request(`http://127.0.0.1:8787/${token}/app.js`, init) as Request<unknown, IncomingRequestCfProperties>,
      { ...env, FILES: new Proxy(env.FILES, { get: (t, n) => (n === 'get' ? get : Reflect.get(t, n).bind(t)) }) }, {} as ExecutionContext);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const down = vi.fn(async (): Promise<never> => { throw new Error('R2 is down'); });
      expect((await run({ headers: { Range: 'bytes=0-1' } }, down)).status).toBe(500);
      expect((await run({ method: 'HEAD' }, down)).status).toBe(200);
      expect(down).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it('answers HEAD, ETags and byte ranges', async () => {
    const path = `/${token}/${encodeURIComponent('a b')}/${encodeURIComponent('صورة #1?.png')}`;
    const head = await call(path, { method: 'HEAD' });
    expect([head.status, await head.text(), head.headers.get('Content-Length')]).toEqual([200, '', '10']);
    const etag = head.headers.get('ETag')!;
    for (const header of [etag, `W/${etag}`, `"x", ${etag}`, '*']) expect((await call(path, { headers: { 'If-None-Match': header } })).status, header).toBe(304);
    expect((await call(path, { headers: { 'If-None-Match': '"x"' } })).status).toBe(200);
    for (const [range, status, body, header] of [['bytes=2-4', 206, '234', 'bytes 2-4/10'], ['bytes=7-', 206, '789', 'bytes 7-9/10'], ['bytes=-3', 206, '789', 'bytes 7-9/10'],
      ['bytes=8-99', 206, '89', 'bytes 8-9/10'], ['bytes=0-', 206, '0123456789', 'bytes 0-9/10'], ['bytes=0-9', 206, '0123456789', 'bytes 0-9/10'], ['bytes=-99', 206, '0123456789', 'bytes 0-9/10'],
      ['bytes=10-', 416, '', 'bytes */10'], ['bytes=10-20', 416, '', 'bytes */10'], ['bytes=-0', 416, '', 'bytes */10'], ['bytes=5-2', 200, '0123456789', null], ['bytes=0-1,4-5', 200, '0123456789', null],
      ['bytes=-', 200, '0123456789', null], ['items=0-1', 200, '0123456789', null]] as const) {
      const response = await call(path, { headers: { Range: range } });
      expect([range, response.status, await response.text(), response.headers.get('Content-Range')]).toEqual([range, status, body, header]);
    }
  });
});

describe('pages', () => {
  it('adds the bridge at the end, and the theme and language from the address only when they are known', async () => {
    const read = async (path: string) => (await call(`/${token}/${path}`)).text();
    expect(await read('index.html?mode=light&lang=ar')).toBe(`<!doctype html><html lang="en" data-lawh-mode="light" data-lawh-lang="ar"><head><title>T</title></head><body><h1>Hi</h1><script src="/${token}/_lawh/bridge.js" data-app="http://localhost:8787" data-mode="light" data-lang="ar"></script></body></html>`);
    expect(await read('index.html?mode=%22%3E%3Cscript%3E&lang=x')).toContain('data-lawh-mode="dark" data-lawh-lang="en"');
    expect(await read('template.html')).toMatch(/<template><body>x<\/body><\/template><\/head><body>y<script [^>]*><\/script><\/body><\/html>$/);
    expect(await read('bare.html?mode=light')).toBe(`<h1>No html element</h1><script src="/${token}/_lawh/bridge.js" data-app="http://localhost:8787" data-mode="light" data-lang="en"></script>`);
  });

  it('serves the bridge, which is valid JavaScript', async () => {
    const response = await call(`/${token}/_lawh/bridge.js`);
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    const text = await response.text();
    expect(text).toContain("'lawh:' + type");
    expect(text).not.toMatch(/<\/script/i);
  });

  it('sends the sandbox and the rest with every response', async () => {
    for (const path of [`/${token}/index.html`, `/${token}/app.js`, `/${token}/_lawh/bridge.js`, `/${token}/nope`, '/']) {
      const { headers } = await call(path);
      expect(headers.get('Content-Security-Policy'), path).toBe("sandbox allow-scripts; default-src 'none'; script-src http://127.0.0.1:8787 'unsafe-inline' 'wasm-unsafe-eval'; "
        + "style-src http://127.0.0.1:8787 'unsafe-inline'; img-src http://127.0.0.1:8787 data: blob:; font-src http://127.0.0.1:8787 data:; media-src http://127.0.0.1:8787 blob:; "
        + "connect-src http://127.0.0.1:8787; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:8787; webrtc 'block'");
      for (const [name, value] of [['Referrer-Policy', 'no-referrer'], ['X-Content-Type-Options', 'nosniff'], ['Access-Control-Allow-Origin', '*'], ['Cross-Origin-Resource-Policy', 'cross-origin'],
        ['X-Robots-Tag', 'noindex, nofollow'], ['X-DNS-Prefetch-Control', 'off']] as const) expect(headers.get(name), `${path} ${name}`).toBe(value);
      expect(headers.get('Set-Cookie'), path).toBeNull();
    }
  });
});
