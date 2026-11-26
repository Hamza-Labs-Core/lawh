import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const fetchApp = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://lawh.example.com${path}`, init));
const turnOn = () => env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1) ON CONFLICT(key) DO UPDATE SET value_json='true'").run();

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(bytes: Uint8Array): [number, number] {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIG);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe('PWA manifest, icons, and service worker', () => {
  it('serves the manifest and icons while instance is off, and gates /sw.js until instance is on', async () => {
    const manifestRes = await fetchApp('/manifest.webmanifest');
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('Content-Type')).toBe('application/manifest+json; charset=utf-8');
    expect(manifestRes.headers.get('Cache-Control')).toBe('no-cache');
    expect(manifestRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(manifestRes.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');

    const manifest = await manifestRes.json<{
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    }>();
    expect(manifest).toMatchObject({
      name: 'Lawh · لوح',
      short_name: 'Lawh',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#12161a',
      theme_color: '#12161a',
    });
    expect(manifest.icons.map((i) => [i.src, i.sizes, i.purpose])).toEqual([
      ['/icon.svg', 'any', 'any'],
      ['/icons/icon-192.png', '192x192', 'any'],
      ['/icons/icon-512.png', '512x512', 'any'],
      ['/icons/icon-maskable-512.png', '512x512', 'maskable'],
    ]);

    // Every icon resolves with valid bytes and expected dimensions.
    const svgRes = await fetchApp('/icon.svg');
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(await svgRes.text()).toContain('<svg ');

    for (const [path, size] of [
      ['/icons/icon-192.png', 192],
      ['/icons/icon-512.png', 512],
      ['/icons/icon-maskable-512.png', 512],
      ['/icons/apple-touch-icon.png', 180],
    ] as const) {
      const res = await fetchApp(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('Content-Type'), path).toBe('image/png');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(pngSize(bytes), path).toEqual([size, size]);
    }

    // /sw.js stays closed while instance is off.
    const swOff = await fetchApp('/sw.js');
    expect(swOff.status).toBe(404);
    expect((await swOff.json<{ code: string }>()).code).toBe('feature_off');
  });

  it('serves /sw.js once instance is on, precaching only static shell assets and never API or content routes', async () => {
    await turnOn();
    const indexHtml = await (await fetchApp('/')).text();
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(indexHtml).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
    expect(indexHtml).toContain('<meta name="theme-color" content="#12161a">');

    const assets = [...indexHtml.matchAll(/\/assets\/[a-z]+-[A-Za-z0-9]{8}\.(?:js|css)/g)].map((m) => m[0]);
    expect(assets.length).toBeGreaterThanOrEqual(3);

    const swRes = await fetchApp('/sw.js');
    expect(swRes.status).toBe(200);
    expect(swRes.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(swRes.headers.get('Cache-Control')).toBe('no-cache');
    expect(swRes.headers.get('Content-Security-Policy')).toContain("worker-src 'self'");

    const sw = await swRes.text();
    for (const asset of assets) expect(sw).toContain(asset);
    expect(sw).toContain("url.pathname.startsWith('/app-api/')");
    expect(sw).toContain("url.pathname.startsWith('/v1/')");
    expect(sw).toContain("url.pathname === '/link'");
    expect(sw).toContain("key.startsWith('lawh-shell-')");
    expect(sw).not.toContain('cache.put');

    // HEAD works; POST and unknown icons return 404.
    expect((await fetchApp('/sw.js', { method: 'HEAD' })).status).toBe(200);
    expect((await fetchApp('/manifest.webmanifest', { method: 'HEAD' })).status).toBe(200);
    expect((await fetchApp('/sw.js', { method: 'POST' })).status).toBe(404);
    expect((await fetchApp('/icons/other.png')).status).toBe(404);
  });
});
