import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { guarded } from '../../src/shared/handler';

const HEADERS = { 'Content-Security-Policy': "default-src 'none'", 'X-Robots-Tag': 'noindex' };
const call = (route: () => Response | Promise<Response>, headers: () => Record<string, string> = () => HEADERS) =>
  guarded<Cloudflare.Env>(route, headers)(new Request('https://lawh.example.com/'), env, createExecutionContext());

beforeEach(async () => { await env.DB.prepare("INSERT INTO settings(key,value_json,updated_at) VALUES('instance','true',1)").run(); });

it('adds the headers and no-store to a route that sets neither', async () => {
  const response = await call(() => new Response('x'));
  expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

it("keeps a route's own CSP and caching, and nothing else of it", async () => {
  const response = await call(() => new Response('x', {
    headers: { 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=60', 'X-Robots-Tag': 'all' } }));
  expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
  expect(response.headers.get('Cache-Control')).toBe('private, max-age=60');
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
});

it('treats empty values as not set, and header names in any case', async () => {
  const empty = await call(() => new Response('x', { headers: { 'Content-Security-Policy': '', 'Cache-Control': '' } }));
  expect(empty.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
  expect(empty.headers.get('Cache-Control')).toBe('no-store');
  const lower = await call(() => new Response('x', { headers: { 'Content-Security-Policy': 'sandbox' } }), () => ({ 'content-security-policy': 'x' }));
  expect(lower.headers.get('Content-Security-Policy')).toBe('sandbox');
});

it.each([
  ['throw', () => { throw new Error('private text'); }],
  ['are invalid', () => ({ 'X-Robots-Tag': 'a\r\nb' })],
])('still answers 500 with safe headers when the host headers %s', async (_, headers) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await call(() => new Response('x'), headers);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'internal', message: 'Something went wrong.' });
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally { log.mockRestore(); }
});

it('works for redirects and empty responses', async () => {
  expect((await call(() => Response.redirect('https://lawh.example.com/a'))).headers.get('X-Robots-Tag')).toBe('noindex');
  expect((await call(() => new Response(null, { status: 204 }))).status).toBe(204);
});

it.each([
  ['an error', () => { throw new Error('private text'); }],
  ['something else', () => { throw 'private text'; }],
  ['a body already read', async () => { const r = new Response('private text'); await r.text(); return r; }],
])('answers 500 without details, and logs none, when a route throws or returns %s', async (_, route) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await call(route);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally { log.mockRestore(); }
});
