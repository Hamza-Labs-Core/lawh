import type { AppEnv, WebhookMessage } from '../../shared/env';
import { isOn } from '../../shared/switches';
import { mustChange } from '../api/idempotency';
import { checkWebhookUrl, decryptWebhookSecret, readAllowedHosts, signWebhook } from './crypto';

const OUTBOX_BATCH = 100;
const MAX_ATTEMPTS = 5;

interface OutboxEvent {
  seq: number;
  project_id: string;
  type: string;
}

interface WebhookTarget {
  id: string;
  event_types_json: string;
}

interface DeliveryTarget {
  id: string;
  project_id: string;
  project_slug: string;
  url: string;
  secret_enc: ArrayBuffer | Uint8Array | number[];
  enabled: number;
}

interface EventPayloadRow {
  seq: number;
  project_id: string;
  page_id: string | null;
  type: string;
  subject_id: string;
  created_at: number;
  actor_type: string;
  actor_id: string | null;
}

/** Claims pending events from the outbox and enqueues matching enabled webhooks. No-op while `webhooks` is off. */
export async function dispatchOutbox(env: AppEnv, now = Date.now()): Promise<void> {
  if (!(await isOn(env.DB, 'webhooks'))) return;
  const { results: events } = await env.DB.prepare('SELECT seq, project_id, type FROM events WHERE enqueued_at IS NULL ORDER BY seq LIMIT ?')
    .bind(OUTBOX_BATCH).all<OutboxEvent>();
  if (events.length === 0) return;

  const byProject = new Map<string, { id: string; types: Set<string> }[]>();
  for (const projectId of new Set(events.map((e) => e.project_id))) {
    const { results } = await env.DB.prepare('SELECT id, event_types_json FROM webhooks WHERE project_id = ? AND enabled = 1')
      .bind(projectId).all<WebhookTarget>();
    byProject.set(projectId, results.map((w) => ({ id: w.id, types: new Set(JSON.parse(w.event_types_json) as string[]) })));
  }

  for (const event of events) {
    const targets = (byProject.get(event.project_id) ?? []).filter((w) => w.types.has(event.type)).map((w) => w.id);
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE events SET enqueued_at = ? WHERE seq = ? AND enqueued_at IS NULL').bind(now, event.seq),
        mustChange(env),
        ...(targets.length > 0
          ? [env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries(webhook_id, event_seq, attempts, status, updated_at) SELECT value, ?, 0, 'pending', ? FROM json_each(?)")
            .bind(event.seq, now, JSON.stringify(targets))]
          : []),
      ]);
    } catch (error) {
      // Another worker claimed this event concurrently.
      if (String(error).includes('malformed JSON')) continue;
      throw error;
    }
    for (const webhookId of targets) {
      try {
        await env.WEBHOOKS.send({ webhookId, eventSeq: event.seq });
      } catch {
        await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'pending'")
          .bind(Date.now(), webhookId, event.seq).run();
      }
    }
  }
}

/** Sends one webhook delivery. Returns whether it should be retried by the queue. */
export async function deliverOne(
  env: AppEnv,
  webhookId: string,
  eventSeq: number,
  attempt: number,
  now = Date.now(),
  allowedHosts?: string[],
): Promise<'ack' | 'retry'> {
  if (!(await isOn(env.DB, 'webhooks'))) return 'ack';
  const existing = await env.DB.prepare('SELECT status FROM webhook_deliveries WHERE webhook_id = ? AND event_seq = ?')
    .bind(webhookId, eventSeq).first<{ status: string }>();
  if (!existing || existing.status === 'delivered') return 'ack';

  const [webhook, event, hosts] = await Promise.all([
    env.DB.prepare('SELECT w.id, w.project_id, p.slug AS project_slug, w.url, w.secret_enc, w.enabled FROM webhooks w JOIN projects p ON p.id = w.project_id WHERE w.id = ?')
      .bind(webhookId).first<DeliveryTarget>(),
    env.DB.prepare('SELECT seq, project_id, page_id, type, subject_id, created_at, actor_type, actor_id FROM events WHERE seq = ?')
      .bind(eventSeq).first<EventPayloadRow>(),
    allowedHosts ? Promise.resolve(allowedHosts) : readAllowedHosts(env),
  ]);

  if (!webhook || !event || webhook.enabled !== 1 || webhook.project_id !== event.project_id) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
      .bind(now, webhookId, eventSeq).run();
    return 'ack';
  }
  try {
    checkWebhookUrl(webhook.url, hosts);
  } catch {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', last_code = NULL, updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
      .bind(now, webhookId, eventSeq).run();
    return 'ack';
  }

  // Bodies carry only ids and event types, never notes, comments or answers (security.md §7).
  const body = JSON.stringify({
    seq: event.seq,
    project: webhook.project_slug,
    type: event.type,
    pageId: event.page_id,
    subjectId: event.subject_id,
    actorType: event.actor_type,
    actorId: event.actor_id,
    createdAt: event.created_at,
  });
  const secret = await decryptWebhookSecret(env, webhook.id, webhook.secret_enc);
  const signature = await signWebhook(secret, Math.floor(now / 1000), body);

  let statusCode: number | null = null;
  let ok = false;
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'Lawh-Signature': signature,
        'Lawh-Event': event.type,
        'Lawh-Delivery': `${webhook.id}:${event.seq}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = response.status;
    ok = response.status >= 200 && response.status < 300;
  } catch {
    statusCode = null;
    ok = false;
  }

  if (ok) {
    await env.DB.prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, status = 'delivered', last_code = ?, updated_at = ? WHERE webhook_id = ? AND event_seq = ?")
      .bind(statusCode, now, webhookId, eventSeq).run();
    return 'ack';
  }

  const final = attempt >= MAX_ATTEMPTS;
  await env.DB.prepare('UPDATE webhook_deliveries SET attempts = attempts + 1, status = ?, last_code = ?, updated_at = ? WHERE webhook_id = ? AND event_seq = ?')
    .bind(final ? 'failed' : 'retrying', statusCode, now, webhookId, eventSeq).run();
  return 'retry';
}

/** Cloudflare Queue consumer for both `lawh-webhooks` and its dead-letter queue `lawh-webhooks-dlq`. */
export async function handleWebhookQueue(batch: MessageBatch<WebhookMessage>, env: AppEnv, now = Date.now()): Promise<void> {
  if (batch.queue.endsWith('-dlq')) {
    for (const msg of batch.messages) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
        .bind(now, msg.body.webhookId, msg.body.eventSeq).run();
      msg.ack();
    }
    return;
  }
  if (!(await isOn(env.DB, 'webhooks'))) {
    for (const msg of batch.messages) msg.ack();
    return;
  }
  const hosts = await readAllowedHosts(env);
  for (const msg of batch.messages) {
    const verdict = await deliverOne(env, msg.body.webhookId, msg.body.eventSeq, msg.attempts, now, hosts);
    if (verdict === 'ack') msg.ack();
    else msg.retry();
  }
}
