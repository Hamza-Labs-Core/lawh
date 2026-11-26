// Generates the PWA icons, web app manifest, and shell-only service worker into .build/ui.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const BG = [0x12, 0x16, 0x1a, 0xff];
const SURFACE = [0x1a, 0x20, 0x26, 0xff];
const LINE = [0x34, 0x40, 0x4b, 0xff];
const ACCENT = [0xe0, 0xb1, 0x5a, 0xff];
const INK = [0xee, 0xf2, 0xf4, 0xff];
const MUTED = [0xa3, 0xb0, 0xba, 0xff];

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(buf, width, height, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= width || y >= height || alpha <= 0) return;
  const i = (y * width + x) * 4;
  const a = Math.min(1, alpha) * (color[3] / 255);
  const inv = 1 - a;
  buf[i] = Math.round(color[0] * a + buf[i] * inv);
  buf[i + 1] = Math.round(color[1] * a + buf[i + 1] * inv);
  buf[i + 2] = Math.round(color[2] * a + buf[i + 2] * inv);
  buf[i + 3] = 255;
}

function fillRoundedRect(buf, size, x, y, w, h, r, color) {
  const x0 = Math.max(0, Math.floor(x) - 1);
  const y0 = Math.max(0, Math.floor(y) - 1);
  const x1 = Math.min(size - 1, Math.ceil(x + w) + 1);
  const y1 = Math.min(size - 1, Math.ceil(y + h) + 1);
  const cx0 = x + r, cy0 = y + r, cx1 = x + w - r, cy1 = y + h - r;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 < cx0 ? cx0 - (px + 0.5) : px + 0.5 > cx1 ? (px + 0.5) - cx1 : 0;
      const dy = py + 0.5 < cy0 ? cy0 - (py + 0.5) : py + 0.5 > cy1 ? (py + 0.5) - cy1 : 0;
      const dist = dx > 0 || dy > 0 ? Math.hypot(dx, dy) - r : Math.max(x - (px + 0.5), (px + 0.5) - (x + w), y - (py + 0.5), (py + 0.5) - (y + h));
      if (dist < 0.5) blendPixel(buf, size, size, px, py, color, 0.5 - dist);
    }
  }
}

function fillCircle(buf, size, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r) - 1);
  const y0 = Math.max(0, Math.floor(cy - r) - 1);
  const x1 = Math.min(size - 1, Math.ceil(cx + r) + 1);
  const y1 = Math.min(size - 1, Math.ceil(cy + r) + 1);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dist = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r;
      if (dist < 0.5) blendPixel(buf, size, size, px, py, color, 0.5 - dist);
    }
  }
}

/** Draws the Lawh writing-tablet mark at `size`x`size`. `maskable` keeps the motif inside the safe zone. */
function renderIconPng(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = BG[0]; buf[i + 1] = BG[1]; buf[i + 2] = BG[2]; buf[i + 3] = 255;
  }
  const pad = size * (maskable ? 0.22 : 0.14);
  const tw = size - pad * 2;
  const th = tw;
  const tx = pad, ty = pad;
  const radius = size * (maskable ? 0.08 : 0.11);
  const border = Math.max(2, size * 0.024);

  // Tablet outer border and surface.
  fillRoundedRect(buf, size, tx, ty, tw, th, radius, LINE);
  fillRoundedRect(buf, size, tx + border, ty + border, tw - border * 2, th - border * 2, Math.max(1, radius - border * 0.6), SURFACE);

  // Gold header bar across the tablet.
  const inset = tw * 0.14;
  const innerW = tw - inset * 2;
  const barH = Math.max(3, tw * 0.075);
  fillRoundedRect(buf, size, tx + inset, ty + inset, innerW, barH, barH / 2, ACCENT);

  // Three writing lines.
  const lineH = Math.max(2, tw * 0.055);
  fillRoundedRect(buf, size, tx + inset, ty + inset + tw * 0.18, innerW, lineH, lineH / 2, INK);
  fillRoundedRect(buf, size, tx + inset, ty + inset + tw * 0.31, innerW * 0.78, lineH, lineH / 2, MUTED);
  fillRoundedRect(buf, size, tx + inset, ty + inset + tw * 0.44, innerW * 0.56, lineH, lineH / 2, MUTED);

  // Decision mark in the bottom corner.
  fillCircle(buf, size, tx + tw - inset - tw * 0.075, ty + th - inset - tw * 0.075, tw * 0.085, ACCENT);

  return encodePng(size, size, buf);
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Lawh">
  <rect width="512" height="512" rx="112" fill="#12161a"/>
  <rect x="72" y="72" width="368" height="368" rx="56" fill="#1a2026" stroke="#34404b" stroke-width="14"/>
  <rect x="124" y="124" width="264" height="28" rx="14" fill="#e0b15a"/>
  <rect x="124" y="190" width="264" height="20" rx="10" fill="#eef2f4"/>
  <rect x="124" y="238" width="206" height="20" rx="10" fill="#a3b0ba"/>
  <rect x="124" y="286" width="148" height="20" rx="10" fill="#a3b0ba"/>
  <circle cx="360" cy="360" r="32" fill="#e0b15a"/>
</svg>
`;

export function writePwaAssets(out, shellAssetPaths) {
  mkdirSync(join(out, 'icons'), { recursive: true });
  writeFileSync(join(out, 'icon.svg'), ICON_SVG);
  writeFileSync(join(out, 'icons/icon-192.png'), renderIconPng(192, false));
  writeFileSync(join(out, 'icons/icon-512.png'), renderIconPng(512, false));
  writeFileSync(join(out, 'icons/icon-maskable-512.png'), renderIconPng(512, true));
  writeFileSync(join(out, 'icons/apple-touch-icon.png'), renderIconPng(180, false));

  const manifest = `${JSON.stringify({
    name: 'Lawh · لوح',
    short_name: 'Lawh',
    description: 'Private self-hosted pages and decisions for agents and teams.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#12161a',
    theme_color: '#12161a',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`;
  writeFileSync(join(out, 'manifest.webmanifest'), manifest);

  const staticFiles = [
    ...shellAssetPaths,
    '/icon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-maskable-512.png',
    '/icons/apple-touch-icon.png',
  ];
  const precache = ['/', '/manifest.webmanifest', ...staticFiles];
  const version = createHash('sha256').update(JSON.stringify(precache) + manifest + ICON_SVG).digest('hex').slice(0, 12);

  // Shell-only service worker: never caches /app-api/*, /v1/*, /link, or cross-origin content.
  const sw = `const CACHE = ${JSON.stringify(`lawh-shell-${version}`)};
const PRECACHE = ${JSON.stringify(precache)};
const STATIC = new Set(${JSON.stringify(staticFiles)});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/app-api/') || url.pathname.startsWith('/v1/') || url.pathname === '/sw.js' || url.pathname === '/link') return;

  if (STATIC.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then((cache) => cache.match(url.pathname).then((hit) => hit ?? fetch(request))),
    );
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match('/manifest.webmanifest')).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match('/')).then((hit) => hit ?? Response.error())),
    );
  }
});
`;
  writeFileSync(join(out, 'sw.js'), sw);
}
