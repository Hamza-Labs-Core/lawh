import { DurableObject } from 'cloudflare:workers';
import type { AppEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { isOn } from '../shared/switches';

const MAX_CONNECTION_MS = 3_600_000;
const MAX_PER_KEY = 5;

interface SocketMeta {
  keyId: string;
  expiresAt: number;
}

/**
 * One Durable Object per project holding hibernatable WebSocket connections for live event pings.
 * Enforces 1-hour maximum connection lifetime and at most 5 active connections per key per project.
 * Carries only `{ seq }` numbers, ignores incoming client messages, and closes expired sockets on alarm or ping.
 */
export class LiveProject extends DurableObject<AppEnv> {
  private readMeta(ws: WebSocket): SocketMeta {
    try {
      const att = ws.deserializeAttachment() as Partial<SocketMeta> | null;
      if (att && typeof att.keyId === 'string' && typeof att.expiresAt === 'number') {
        return { keyId: att.keyId, expiresAt: att.expiresAt };
      }
    } catch { /* fall back to tags */ }
    const tags = this.ctx.getTags(ws);
    const keyTag = tags.find((t) => t.startsWith('key:'))?.slice(4) ?? '';
    const expTag = Number(tags.find((t) => t.startsWith('exp:'))?.slice(4) ?? 0);
    return { keyId: keyTag, expiresAt: Number.isFinite(expTag) ? expTag : 0 };
  }

  private closeSocket(ws: WebSocket, code = 1000, reason = 'expired'): void {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private async rescheduleAlarm(now: number): Promise<void> {
    let soonest = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const { expiresAt } = this.readMeta(ws);
      if (expiresAt <= now) {
        this.closeSocket(ws, 1000, 'expired');
      } else if (expiresAt < soonest) {
        soonest = expiresAt;
      }
    }
    if (Number.isFinite(soonest)) {
      await this.ctx.storage.setAlarm(soonest);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === 'POST' && url.pathname === '/ping') {
      let body: unknown;
      try { body = await request.json(); } catch { return errorResponse('invalid', 'Invalid ping payload.'); }
      const seq = typeof body === 'object' && body !== null && 'seq' in body ? (body as { seq: unknown }).seq : null;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
        return errorResponse('invalid', 'seq must be a positive integer.');
      }
      const message = JSON.stringify({ seq });
      for (const ws of this.ctx.getWebSockets()) {
        const { expiresAt } = this.readMeta(ws);
        if (expiresAt <= now) {
          this.closeSocket(ws, 1000, 'expired');
          continue;
        }
        try {
          ws.send(message);
        } catch {
          this.closeSocket(ws, 1011, 'send failed');
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.method === 'POST' && url.pathname === '/close') {
      for (const ws of this.ctx.getWebSockets()) {
        this.closeSocket(ws, 1000, 'live_off');
      }
      await this.ctx.storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }

    if (request.method === 'GET' && url.pathname === '/connect') {
      if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
        return errorResponse('invalid', 'WebSocket upgrade required.');
      }
      // Recheck the live switch inside the single-threaded DO so an in-flight upgrade paused across `live = false` cannot open a socket after `/close`.
      if (!(await isOn(this.env.DB, 'live'))) {
        return errorResponse('feature_off', 'This feature is off.');
      }
      const keyId = request.headers.get('X-Lawh-Key-Id')?.trim() ?? '';
      if (!keyId) return errorResponse('unauthorized', 'Missing key id.');
      const rawExp = request.headers.get('X-Lawh-Expires-At');
      const requestedExp = rawExp === null ? NaN : Number(rawExp);
      if (!Number.isSafeInteger(requestedExp) || requestedExp <= now) {
        return errorResponse('unauthorized', 'Ticket or key expired.');
      }
      const expiresAt = Math.min(requestedExp, now + MAX_CONNECTION_MS);

      // Enforce at most 5 active connections per key in one project, pruning any expired ones first.
      const existing = this.ctx.getWebSockets(`key:${keyId}`);
      let active = 0;
      for (const ws of existing) {
        if (this.readMeta(ws).expiresAt <= now) {
          this.closeSocket(ws, 1000, 'expired');
        } else {
          active++;
        }
      }
      if (active >= MAX_PER_KEY) {
        return errorResponse('rate_limited', `At most ${MAX_PER_KEY} live connections per key in one project.`);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [`key:${keyId}`, `exp:${expiresAt}`]);
      server.serializeAttachment({ keyId, expiresAt } satisfies SocketMeta);
      await this.rescheduleAlarm(now);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response(null, { status: 404 });
  }

  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Incoming messages from clients are strictly ignored per docs/spec/security.md §7.
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.closeSocket(ws, code || 1000, reason || '');
  }

  override webSocketError(ws: WebSocket): void {
    this.closeSocket(ws, 1011, 'error');
  }

  override async alarm(): Promise<void> {
    await this.rescheduleAlarm(Date.now());
  }
}
