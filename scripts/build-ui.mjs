// Bundles the app's pages into .build/ui: one script and one style sheet, named by their content.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, '.build/ui');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
const result = await build({
  entryPoints: [join(root, 'src/ui/main.tsx')], bundle: true, minify: true, format: 'esm', target: ['es2022', 'safari16.4'], jsx: 'automatic', jsxImportSource: 'preact',
  outdir: join(out, 'assets'), entryNames: '[name]-[hash]', write: true, metafile: true, legalComments: 'none',
});
const script = Object.keys(result.metafile.outputs).find((path) => path.endsWith('.js')).split('/').at(-1);
const css = readFileSync(join(root, 'src/ui/style.css')), style = `style-${createHash('sha256').update(css).digest('hex').slice(0, 8)}.css`;
writeFileSync(join(out, 'assets', style), css);
// The first script sets the theme and language before anything is drawn. It is a file: the CSP allows nothing inline.
const first = readFileSync(join(root, 'src/ui/first.js')), firstName = `first-${createHash('sha256').update(first).digest('hex').slice(0, 8)}.js`;
writeFileSync(join(out, 'assets', firstName), first);
writeFileSync(join(out, 'index.html'), `<!doctype html><html lang="en" dir="ltr" data-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta name="robots" content="noindex"><title>Lawh</title><script src="/assets/${firstName}"></script><link rel="stylesheet" href="/assets/${style}"><script type="module" src="/assets/${script}"></script></head><body><div id="app"></div><noscript>Lawh needs JavaScript. يحتاج لوح إلى جافاسكربت.</noscript></body></html>
`);
