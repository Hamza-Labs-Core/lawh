import type { AppEnv, WebhookMessage } from '../../shared/env';
import { isOn } from '../../shared/switches';
import { mustChange } from '../api/idempotency';
import { checkWebhookUrl, decryptWebhookSecret, readAllowedHosts, signWebhook } from './crypto';

const OUTBOX_BATCH = 100;
export const STALE_QUEUING_MS = 15_000;

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

async function readWebhooksSince(env: AppEnv): Promise<number> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'webhooks_since'").first<{ value_json: string }>();
  if (!row) return 0;
  const n = Number(row.value_json);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Fails the batch unless webhooks are currently on and `eventSeq` is strictly after the `webhooks_since` watermark. */
const stillAfterWatermark = (env: AppEnv, eventSeq: number): D1PreparedStatement =>
  env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'webhooks' AND value_json = 'true')
    AND ? > COALESCE((SELECT CAST(value_json AS INTEGER) FROM settings WHERE key = 'webhooks_since'), 0)
    THEN 1 ELSE json('stale') END`).bind(eventSeq);

async function enqueueClaimed(env: AppEnv, webhookId: string, eventSeq: number): Promise<void> {
  try {
    await env.WEBHOOKS.send({ webhookId, eventSeq });
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'queuing'")
      .bind(Date.now(), webhookId, eventSeq).run();
  } catch {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'queuing'")
      .bind(Date.now(), webhookId, eventSeq).run();
  }
}

/**
 * Claims pending events after the `webhooks_since` watermark and enqueues matching enabled webhooks.
 * Each `(webhookId, eventSeq)` is claimed atomically (`INSERT OR IGNORE` + `mustChange`) guarded by the live
 * switch and watermark, so concurrent dispatchers never duplicate sends and stale watermarks never replay
 * pre-switch events. Interrupted `'queuing'` rows older than `STALE_QUEUING_MS` are recovered via the
 * `webhook_deliveries_status` index regardless of whether the webhook was later paused or unsubscribed.
 */
export async function dispatchOutbox(env: AppEnv, now = Date.now()): Promise<void> {
  if (!(await isOn(env.DB, 'webhooks'))) return;
  const since = await readWebhooksSince(env);
  const { results: events } = await env.DB.prepare('SELECT seq, project_id, type FROM events WHERE enqueued_at IS NULL AND seq > ? ORDER BY seq LIMIT ?')
    .bind(since, OUTBOX_BATCH).all<OutboxEvent>();

  if (events.length > 0) {
    const byProject = new Map<string, { id: string; types: Set<string> }[]>();
    for (const projectId of new Set(events.map((e) => e.project_id))) {
      const { results } = await env.DB.prepare('SELECT id, event_types_json FROM webhooks WHERE project_id = ? AND enabled = 1')
        .bind(projectId).all<WebhookTarget>();
      byProject.set(projectId, results.map((w) => ({ id: w.id, types: new Set(JSON.parse(w.event_types_json) as string[]) })));
    }

    for (const event of events) {
      const targets = (byProject.get(event.project_id) ?? []).filter((w) => w.types.has(event.type)).map((w) => w.id);
      let stale = false;
      for (const webhookId of targets) {
        try {
          await env.DB.batch([
            stillAfterWatermark(env, event.seq),
            env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries(webhook_id, event_seq, attempts, status, updated_at) VALUES(?, ?, 0, 'queuing', ?)")
              .bind(webhookId, event.seq, now),
            mustChange(env),
          ]);
        } catch (error) {
          if (String(error).includes('malformed JSON')) {
            // Either webhooks turned off / watermark moved past this event, or another dispatcher already claimed it.
            if (!(await isOn(env.DB, 'webhooks')) || event.seq <= (await readWebhooksSince(env))) {
              stale = true;
              break;
            }
            continue;
          }
          throw error;
        }
        await enqueueClaimed(env, webhookId, event.seq);
      }
      if (stale) break;
      try {
        await env.DB.batch([
          stillAfterWatermark(env, event.seq),
          env.DB.prepare('UPDATE events SET enqueued_at = ? WHERE seq = ? AND enqueued_at IS NULL').bind(now, event.seq),
        ]);
      } catch (error) {
        if (String(error).includes('malformed JSON')) break;
        throw error;
      }
    }
  }

  // Recover any `'queuing'` deliveries left behind by an interrupted dispatcher (indexed by webhook_deliveries_status).
  const cutoff = now - STALE_QUEUING_MS;
  const { results: stranded } = await env.DB.prepare("SELECT webhook_id, event_seq, updated_at FROM webhook_deliveries WHERE status = 'queuing' AND updated_at <= ? ORDER BY updated_at LIMIT ?")
    .bind(cutoff, OUTBOX_BATCH).all<{ webhook_id: string; event_seq: number; updated_at: number }>();
  for (const row of stranded) {
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE webhook_deliveries SET updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'queuing' AND updated_at = ?")
          .bind(now, row.webhook_id, row.event_seq, row.updated_at),
        mustChange(env),
      ]);
    } catch (error) {
      if (String(error).includes('malformed JSON')) continue;
      throw error;
    }
    const [hook, evt] = await Promise.all([
      env.DB.prepare('SELECT enabled, event_types_json FROM webhooks WHERE id = ?').bind(row.webhook_id).first<{ enabled: number; event_types_json: string }>(),
      env.DB.prepare('SELECT type FROM events WHERE seq = ?').bind(row.event_seq).first<{ type: string }>(),
    ]);
    const stillSubscribed = Boolean(hook && evt && hook.enabled === 1 && (JSON.parse(hook.event_types_json) as string[]).includes(evt.type));
    if (!stillSubscribed) {
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'queuing'")
        .bind(Date.now(), row.webhook_id, row.event_seq).run();
      continue;
    }
    await enqueueClaimed(env, row.webhook_id, row.event_seq);
  }
}

/** Sends one webhook delivery. Always re-checks the switch and allowlist, and never overwrites a delivered row. */
export async function deliverOne(
  env: AppEnv,
  webhookId: string,
  eventSeq: number,
  _attempt: number,
  now = Date.now(),
): Promise<'ack' | 'retry'> {
  const existing = await env.DB.prepare('SELECT status FROM webhook_deliveries WHERE webhook_id = ? AND event_seq = ?')
    .bind(webhookId, eventSeq).first<{ status: string }>();
  if (!existing || existing.status === 'delivered') return 'ack';

  if (!(await isOn(env.DB, 'webhooks'))) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', last_code = NULL, updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
      .bind(now, webhookId, eventSeq).run();
    return 'ack';
  }

  const [webhook, event, hosts] = await Promise.all([
    env.DB.prepare('SELECT w.id, w.project_id, p.slug AS project_slug, w.url, w.secret_enc, w.enabled FROM webhooks w JOIN projects p ON p.id = w.project_id WHERE w.id = ?')
      .bind(webhookId).first<DeliveryTarget>(),
    env.DB.prepare('SELECT seq, project_id, page_id, type, subject_id, created_at, actor_type, actor_id FROM events WHERE seq = ?')
      .bind(eventSeq).first<EventPayloadRow>(),
    readAllowedHosts(env),
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
    await env.DB.prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, status = 'delivered', last_code = ?, updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
      .bind(statusCode, now, webhookId, eventSeq).run();
    return 'ack';
  }

  // Keep status = 'retrying' while returning 'retry'; only the DLQ consumer exposes 'failed' once automatic retries end.
  await env.DB.prepare("UPDATE webhook_deliveries SET attempts = attempts + 1, status = 'retrying', last_code = ?, updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status <> 'delivered'")
    .bind(statusCode, now, webhookId, eventSeq).run();
  return 'retry';
}

/** Cloudflare Queue consumer for both `lawh-webhooks` and its dead-letter queue `lawh-webhooks-dlq`. */
export async function handleWebhookQueue(batch: MessageBatch<WebhookMessage>, env: AppEnv, now = Date.now()): Promise<void> {
  if (batch.queue.endsWith('-dlq')) {
    for (const msg of batch.messages) {
      // Only transition an exhausted retry (or an unattempted pending row); never clobber a manual resend ('pending' with attempts > 0) or a delivered row.
      await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND (status = 'retrying' OR (status IN ('queuing', 'pending') AND attempts = 0))")
        .bind(now, msg.body.webhookId, msg.body.eventSeq).run();
      msg.ack();
    }
    return;
  }
  for (const msg of batch.messages) {
    const verdict = await deliverOne(env, msg.body.webhookId, msg.body.eventSeq, msg.attempts, now);
    if (verdict === 'ack') msg.ack();
    else msg.retry();
  }
}
