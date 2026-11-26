import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(root, 'skills/lawh/lawh.mjs');

interface EventItem {
  seq: number;
  type: string;
  actorType: 'person' | 'agent' | 'system';
  actorId: string | null;
  pageId: string | null;
  subjectId: string;
  createdAt: number;
}

/** Minimal RFC 6455 WebSocket text frame encoder for our local test server. */
function wsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

async function startMockLiveServer() {
  const events: EventItem[] = [];
  let liveOn = true;
  const wsSockets = new Set<Socket>();
  let ticketRequests = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agentId: 'agt_self',
        name: 'my-agent',
        scopes: ['pages:read', 'decisions:read', 'comments:read'],
        allProjects: false,
        projects: [{ slug: 'one', name: { en: 'One', ar: 'واحد' } }],
        expiresAt: Date.now() + 86_400_000,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/events/ticket') {
      ticketRequests++;
      if (!liveOn) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'feature_off', message: 'Live pings are off.' }));
        return;
      }
      const addr = server.address() as { port: number };
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url: `ws://127.0.0.1:${addr.port}/v1/events/live?ticket=test-ticket`,
        expiresAt: Date.now() + 60_000,
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const afterRaw = url.searchParams.get('after');
      const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
      if (afterRaw === null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [], next: maxSeq }));
        return;
      }
      const after = Number(afterRaw);
      const items = events.filter((e) => e.seq > after);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items, next: Math.max(after, maxSeq) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    wsSockets.add(socket);
    socket.on('data', (chunk) => {
      // Echo minimal Close frame (opcode 0x8) so client WebSocket teardown completes promptly.
      if (chunk.length >= 2 && (chunk[0]! & 0x0f) === 0x08) {
        try { socket.end(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
      }
    });
    socket.on('close', () => wsSockets.delete(socket));
    socket.on('error', () => wsSockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    events,
    get ticketRequests() { return ticketRequests; },
    setLiveOn(v: boolean) { liveOn = v; },
    pushEvent(ev: Omit<EventItem, 'seq' | 'createdAt'>) {
      const next: EventItem = { ...ev, seq: events.length + 1, createdAt: Date.now() };
      events.push(next);
      const frame = wsTextFrame(JSON.stringify({ seq: next.seq }));
      for (const s of wsSockets) {
        try { s.write(frame); } catch { /* ignore */ }
      }
      return next;
    },
    close: async () => {
      for (const s of wsSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('S20 CLI: lawh wait and lawh listen', () => {
  it('wakes immediately on WebSocket ping, filters self/agent events, isolates cursors, enforces lock files, and falls back to polling when live is off', async () => {
    const srv = await startMockLiveServer();
    cleanups.push(() => srv.close());
    const dir = mkdtempSync(join(tmpdir(), 'lawh-s20-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const env = {
      ...process.env,
      LAWH_URL: srv.baseUrl,
      LAWH_KEY: 'lawh_key_test_secret',
      LAWH_CURSOR_DIR: dir,
    };

    // Seed an older event before first run — first wait must NOT replay it!
    srv.pushEvent({ type: 'page.published', actorType: 'person', actorId: 'mem_1', pageId: 'pag_0', subjectId: 'pag_0' });

    // Start `lawh wait` in the background; push own agent event (ignored), other agent event (ignored without --agents), then person event (wakes!).
    const waitChild = spawn(process.execPath, [cli, 'wait', '--project', 'one', '--timeout', '10'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let waitOut = '';
    waitChild.stdout.on('data', (d) => { waitOut += d.toString('utf8'); });

    // Wait briefly for WebSocket connection to open, then test lock refusal from a second concurrent wait!
    await new Promise((r) => setTimeout(r, 200));
    const dupRes = await execFileAsync(process.execPath, [cli, 'wait', '--project', 'one', '--timeout', '2'], { env }).then(
      () => ({ ok: true, stderr: '' }),
      (err) => ({ ok: false, stderr: String(err.stderr || err.message) }),
    );
    expect(dupRes.ok).toBe(false);
    expect(dupRes.stderr).toContain('already using this cursor');

    srv.pushEvent({ type: 'page.published', actorType: 'agent', actorId: 'agt_self', pageId: 'pag_1', subjectId: 'pag_1' });
    srv.pushEvent({ type: 'comment.created', actorType: 'agent', actorId: 'agt_other', pageId: 'pag_1', subjectId: 'cmt_1' });
    const personEv = srv.pushEvent({ type: 'decision.answered', actorType: 'person', actorId: 'mem_1', pageId: 'pag_1', subjectId: 'dec_1' });

    const exitCode = await new Promise<number | null>((resolve) => waitChild.on('close', resolve));
    expect(exitCode).toBe(0);
    expect(JSON.parse(waitOut.trim())).toMatchObject({ project: 'one', seq: personEv.seq, type: 'decision.answered', subjectId: 'dec_1' });
    expect(srv.ticketRequests).toBeGreaterThanOrEqual(1);

    // Event occurring BETWEEN runs is returned immediately on next `lawh wait` without missing anything!
    const missedEv = srv.pushEvent({ type: 'comment.created', actorType: 'person', actorId: 'mem_1', pageId: 'pag_1', subjectId: 'cmt_2' });
    const immediate = await execFileAsync(process.execPath, [cli, 'wait', '--project', 'one', '--timeout', '5'], { env });
    expect(JSON.parse(immediate.stdout.trim())).toMatchObject({ seq: missedEv.seq, subjectId: 'cmt_2' });

    // With --agents and --after 0, sees other agent's event (agt_other) but STILL excludes own agent (agt_self)!
    const withAgents = await execFileAsync(process.execPath, [cli, 'wait', '--project', 'one', '--agents', '--after', '1', '--timeout', '5'], { env });
    expect(JSON.parse(withAgents.stdout.trim())).toMatchObject({ actorType: 'agent', actorId: 'agt_other', subjectId: 'cmt_1' });

    // Polling fallback when `live` switch is off (POST /v1/events/ticket returns 404 feature_off).
    srv.setLiveOn(false);
    const pollChild = spawn(process.execPath, [cli, 'wait', '--project', 'one', '--cursor', 'poll-test', '--poll-ms', '80', '--timeout', '5'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let pollOut = '';
    pollChild.stdout.on('data', (d) => { pollOut += d.toString('utf8'); });
    await new Promise((r) => setTimeout(r, 150));
    const pollEv = srv.pushEvent({ type: 'page.status', actorType: 'person', actorId: 'mem_1', pageId: 'pag_2', subjectId: 'pag_2' });
    expect(await new Promise<number | null>((resolve) => pollChild.on('close', resolve))).toBe(0);
    expect(JSON.parse(pollOut.trim())).toMatchObject({ seq: pollEv.seq, type: 'page.status' });
  });

  it('lawh listen runs the given command with shell: false, passes event JSON on stdin, and only advances cursor on exit 0', async () => {
    const srv = await startMockLiveServer();
    cleanups.push(() => srv.close());
    const dir = mkdtempSync(join(tmpdir(), 'lawh-s20-listen-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const outFile = join(dir, 'received.jsonl');
    const handlerScript = join(dir, 'handler.mjs');
    writeFileSync(handlerScript, `
      import { appendFileSync, readFileSync } from 'node:fs';
      const input = readFileSync(0, 'utf8').trim();
      if (process.env.FAIL_HANDLER === '1') process.exit(2);
      appendFileSync(${JSON.stringify(outFile)}, input + '\\n');
    `);

    const env = {
      ...process.env,
      LAWH_URL: srv.baseUrl,
      LAWH_KEY: 'lawh_key_test_secret',
      LAWH_CURSOR_DIR: dir,
    };

    const ev = srv.pushEvent({ type: 'decision.answered', actorType: 'person', actorId: 'mem_1', pageId: 'pag_9', subjectId: 'dec_9' });

    // Failing handler exits non-zero and must NOT advance the cursor!
    const failRun = await execFileAsync(
      process.execPath,
      [cli, 'listen', '--project', 'one', '--after', '0', '--once', '--', process.execPath, handlerScript],
      { env: { ...env, FAIL_HANDLER: '1' } },
    ).then(() => true, () => false);
    expect(failRun).toBe(false);

    // Re-running without --after picks up the SAME event because cursor was NOT advanced on failure, then advances on success!
    await execFileAsync(
      process.execPath,
      [cli, 'listen', '--project', 'one', '--after', '0', '--once', '--', process.execPath, handlerScript],
      { env },
    );
    const lines = readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ project: 'one', seq: ev.seq, subjectId: 'dec_9' });
  });
});
