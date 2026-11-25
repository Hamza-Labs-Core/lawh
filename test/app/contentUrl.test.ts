import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { contentUrl } from '../../src/app/contentUrl';
import { readContentToken } from '../../src/shared/contentToken';

const VERSION = `ver_${'0'.repeat(26)}`;

it('gives an address of the content host that opens the version', async () => {
  const url = new URL(await contentUrl(env, VERSION, 'a b/صورة #1?.html', 'light', 'ar'));
  const [, token, ...path] = url.pathname.split('/');
  expect(url.origin).toBe('http://127.0.0.1:8787');
  expect(await readContentToken(env.CONTENT_KEY as string, token!)).toBe(VERSION);
  expect([path.map(decodeURIComponent).join('/'), url.search, url.hash]).toEqual(['a b/صورة #1?.html', '?mode=light&lang=ar', '']);
});

it('fails when the hosts are the same, or not valid', async () => {
  for (const change of [{ CONTENT_ORIGIN: env.APP_ORIGIN }, { CONTENT_ORIGIN: 'http://localhost:9' }, { CONTENT_ORIGIN: 'https://a.example.com/' }, { APP_ORIGIN: 'ftp://a.example.com' }]) {
    await expect(contentUrl({ ...env, ...change }, VERSION, 'index.html', 'dark', 'en')).rejects.toThrow();
  }
});
