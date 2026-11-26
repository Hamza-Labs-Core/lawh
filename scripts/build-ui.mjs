// Bundles the app's pages into .build/ui: one script and one style sheet, named by their content.
import { build } from 'esbuild';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePwaAssets } from './pwa-assets.mjs';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function buildUi({ root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, '.build/ui'), configPath = join(root, 'lawh.config.json') } = {}) {
  const hasCustomConfig = existsSync(configPath);
  let instance = {};
  if (hasCustomConfig) {
    try { instance = JSON.parse(readFileSync(configPath, 'utf8'))?.instance ?? {}; } catch { /* ignore invalid local config */ }
  }
  const nameEn = typeof instance?.name?.en === 'string' && instance.name.en.trim() ? instance.name.en.trim() : 'Lawh';
  const nameAr = typeof instance?.name?.ar === 'string' && instance.name.ar.trim() ? instance.name.ar.trim() : 'لوح';
  const defaultLang = instance?.defaultLang === 'ar' ? 'ar' : 'en';
  const explicitDefaultLang = instance?.defaultLang === 'ar' || instance?.defaultLang === 'en' ? instance.defaultLang : '';
  const defaultMode = instance?.defaultTheme === 'light' ? 'light' : 'dark';
  const accent = typeof instance?.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(instance.accent) ? instance.accent.toLowerCase() : null;
  const themeColor = defaultMode === 'light' ? '#f6f4ef' : '#12161a';

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  const result = await build({
    entryPoints: [join(root, 'src/ui/main.tsx')], bundle: true, minify: true, format: 'esm', target: ['es2022', 'safari16.4'], jsx: 'automatic', jsxImportSource: 'preact',
    outdir: join(out, 'assets'), entryNames: '[name]-[hash]', write: true, metafile: true, legalComments: 'none',
  });
  const script = Object.keys(result.metafile.outputs).find((path) => path.endsWith('.js')).split('/').at(-1);
  let css = readFileSync(join(root, 'src/ui/style.css'), 'utf8');
  if (accent && accent !== '#e0b15a') css += `\n:root,:root[data-mode=light]{--ac:${accent};}\n`;
  const style = `style-${createHash('sha256').update(css).digest('hex').slice(0, 8)}.css`;
  writeFileSync(join(out, 'assets', style), css);
  // The first script sets the theme and language before anything is drawn. It is a file: the CSP allows nothing inline.
  const first = readFileSync(join(root, 'src/ui/first.js')), firstName = `first-${createHash('sha256').update(first).digest('hex').slice(0, 8)}.js`;
  writeFileSync(join(out, 'assets', firstName), first);
  // Served by the app Worker at /connect.md and /lawh.mjs so the skill and client match this copy's version.
  writeFileSync(join(out, 'connect.md'), readFileSync(join(root, 'skills/lawh/SKILL.md')));
  writeFileSync(join(out, 'lawh.mjs'), readFileSync(join(root, 'skills/lawh/lawh.mjs')));
  const title = escapeHtml(nameEn);
  const titleAr = escapeHtml(nameAr);
  const langAttr = explicitDefaultLang ? ` data-default-lang="${explicitDefaultLang}"` : '';
  const indexHtml = `<!doctype html><html lang="${defaultLang}" dir="${defaultLang === 'ar' ? 'rtl' : 'ltr'}" data-mode="${defaultMode}" data-default-mode="${defaultMode}"${langAttr} data-brand-en="${title}" data-brand-ar="${titleAr}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="theme-color" content="${themeColor}"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${title}"><meta name="robots" content="noindex"><title>${title}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><script src="/assets/${firstName}"></script><link rel="stylesheet" href="/assets/${style}"><script type="module" src="/assets/${script}"></script></head><body><div id="app"></div><noscript>${title} needs JavaScript. يحتاج ${titleAr} إلى جافاسكربت.</noscript></body></html>
`;
  writePwaAssets(out, [`/assets/${firstName}`, `/assets/${style}`, `/assets/${script}`], indexHtml, instance);
  writeFileSync(join(out, 'index.html'), indexHtml);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildUi();
}
