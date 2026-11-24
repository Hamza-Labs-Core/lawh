// PW=<folder that has node_modules/playwright> node docs/spec/mockups/shoot.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(process.env.PW + '/x.js')('playwright-core');
const here = new URL('.', import.meta.url);
mkdirSync(new URL('png/', here), { recursive: true });
const b = await chromium.launch();
for (const [screen, lang, mode, w] of [
  ['library','en','dark',1280],['library','en','dark',390],['library','ar','light',390],
  ['page','en','dark',1280],['page','ar','dark',1280],['page','en','light',390],
  ['viewer','en','dark',390],['inbox','ar','dark',390],['inbox','en','dark',1280],
  ['comments','en','dark',390],['keys','ar','light',1280],['signin','en','dark',390]]) {
  const p = await b.newPage({ viewport: { width: w, height: w < 500 ? 844 : 800 } });
  p.on('pageerror', e => { console.error(screen, lang, e.message); process.exitCode = 1; });
  await p.goto(new URL(`index.html?screen=${screen}&lang=${lang}&mode=${mode}`, here).href);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (over > 0) { console.error('OVERFLOW', screen, lang, w, over); process.exitCode = 1; }
  await p.screenshot({ path: new URL(`png/${screen}-${lang}-${mode}-${w}.png`, here).pathname });
  await p.close();
}
await b.close();
