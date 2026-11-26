import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, code, json, makeKey, publish, seed, sql } from './api/helpers';
import { api, enter, one } from './people/helpers';

beforeEach(seed);

describe('S20 live pings: switch, tickets, Durable Object WebSockets, limits, and alarms', () => {
  it('toggles the live switch (owner only) and gates /v1/events/ticket and /v1/events/live behind it', async () => {
    const { cookie: owner } = await enter('o');
    const { cookie: mona } = await enter('m');
    const { token } = await makeKey();

    // Off by default -> 404 feature_off.
    expect(await code(await call('/v1/events/ticket', { method: 'POST', token, json: { project: 'one' } }))).toEqual([404, 'feature_off']);
    expect(await code(await call('/v1/events/live?ticket=bad.ticket'))).toEqual([404, 'feature_off']);

    // Non-owner cannot toggle live switch.
    expect(await code(await api('PUT', '/switches/live', { cookie: mona, body: { on: true } }))).toEqual([403, 'forbidden']);

    // Owner toggles live on -> reflected in /settings and audit log.
    expect(await json(await api('PUT', '/switches/live', { cookie: owner, body: { on: true } }))).toEqual({ live: true });
    expect((await json(await api('GET', '/settings', { cookie: owner }))).live).toBe(true);
    expect(await one("SELECT action FROM audit WHERE action='live.on'")).toEqual({ action: 'live.on' });

    // Owner turns live off -> 404 feature_off again.
    expect(await json(await api('PUT', '/switches/live', { cookie: owner, body: { on: false } }))).toEqual({ live: false });
    expect(await code(await call('/v1/events/ticket', { method: 'POST', token, json: { project: 'one' } }))).toEqual([404, 'feature_off']);
    expect(await one("SELECT action FROM audit WHERE action='live.off'")).toEqual({ action: 'live.off' });
  });

  it('issues 60-second signed tickets for accessible projects and rejects invalid, tampered, or non-WS upgrades', async () => {
    await sql("INSERT INTO settings(key, value_json, updated_at) VALUES('live', 'true', 1) ON CONFLICT(key) DO UPDATE SET value_json='true'");
    const { token: ownerTok } = await makeKey();
    const { token: limitedTok } = await makeKey({ projects: ['p1'] });

    // Inaccessible or missing project -> 404.
    expect(await code(await call('/v1/events/ticket', { method: 'POST', token: limitedTok, json: { project: 'two' } }))).toEqual([404, 'not_found']);
    expect(await code(await call('/v1/events/ticket', { method: 'POST', token: ownerTok, json: { project: 'missing' } }))).toEqual([404, 'not_found']);

    // Valid ticket -> 201 with ws:// URL and ~60s expiry.
    const before = Date.now();
    const res = await call('/v1/events/ticket', { method: 'POST', token: limitedTok, json: { project: 'one' } });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.url).toMatch(/^ws:\/\/localhost:8787\/v1\/events\/live\?ticket=/);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 55_000);
    expect(body.expiresAt).toBeLessThanOrEqual(before + 65_000);

    const parsedUrl = new URL(body.url);
    const ticket = parsedUrl.searchParams.get('ticket')!;
    // Without Upgrade: websocket -> 422 invalid.
    expect(await code(await call(`/v1/events/live?ticket=${encodeURIComponent(ticket)}`))).toEqual([422, 'invalid']);

    // Tampered signature -> 401 unauthorized.
    const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('0') ? '1' : '0'}`;
    expect(await code(await call(`/v1/events/live?ticket=${encodeURIComponent(tampered)}`, { headers: { Upgrade: 'websocket' } }))).toEqual([401, 'unauthorized']);
    expect(await code(await call('/v1/events/live?ticket=garbage', { headers: { Upgrade: 'websocket' } }))).toEqual([401, 'unauthorized']);
  });

  it('connects WebSockets via LiveProject DO, broadcasts { seq } pings, ignores client messages, enforces 5-per-key cap, and expires sockets', async () => {
    await sql("INSERT INTO settings(key, value_json, updated_at) VALUES('live', 'true', 1) ON CONFLICT(key) DO UPDATE SET value_json='true'");
    const stub = env.LIVE.get(env.LIVE.idFromName('p1'));

    // Unknown DO path returns 404.
    expect((await stub.fetch('https://live/')).status).toBe(404);

    // Connect via full Worker route with a real signed ticket!
    const { token } = await makeKey({ projects: ['p1'] });
    const { url } = await json(await call('/v1/events/ticket', { method: 'POST', token, json: { project: 'one' } }));
    const wsPath = new URL(url).pathname + new URL(url).search;

    const sockets: WebSocket[] = [];
    const received: string[] = [];
    for (let i = 0; i < 5; i++) {
      const upgradeRes = await call(wsPath, { headers: { Upgrade: 'websocket' } });
      expect(upgradeRes.status).toBe(101);
      const ws = upgradeRes.webSocket!;
      ws.accept();
      if (i === 0) ws.addEventListener('message', (ev) => received.push(String(ev.data)));
      sockets.push(ws);
    }

    // 6th connection for the SAME key in the same project gets 429 rate_limited!
    const sixth = await call(wsPath, { headers: { Upgrade: 'websocket' } });
    expect(sixth.status).toBe(429);

    // Incoming client messages are ignored without error.
    sockets[0]!.send('hello-should-be-ignored');

    // Publishing a page commits an event and sends a `{ seq }` ping to connected WebSockets!
    const pubRes = await publish(token, { 'index.html': '<p>live</p>' }, { page: { title: 'Live Page' } });
    expect(pubRes.status).toBe(200);

    // Direct DO ping also delivers `{ seq: 999 }` cleanly.
    const pingRes = await stub.fetch('https://live/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: 999 }),
    });
    expect(pingRes.status).toBe(204);

    // Wait briefly for message delivery.
    await new Promise((r) => setTimeout(r, 50));
    expect(received.some((m) => m === '{"seq":999}')).toBe(true);

    // A short-lived socket expires and is closed/skipped on ping.
    const expRes = await stub.fetch('https://live/connect', {
      method: 'GET',
      headers: {
        Upgrade: 'websocket',
        'X-Lawh-Key-Id': 'key_other',
        'X-Lawh-Expires-At': String(Date.now() + 20),
      },
    });
    expect(expRes.status).toBe(101);
    const expWs = expRes.webSocket!;
    expWs.accept();
    const expMessages: string[] = [];
    expWs.addEventListener('message', (ev) => expMessages.push(String(ev.data)));
    await new Promise((r) => setTimeout(r, 40));
    await stub.fetch('https://live/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: 1000 }),
    });
    expect(expMessages).toEqual([]);

    for (const ws of sockets) ws.close();
    expWs.close();
  });
});
