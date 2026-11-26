import { randomToken } from '../../shared/crypto';
import type { AppEnv } from '../../shared/env';
import { ApiError, conflict, invalid, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { isOn } from '../../shared/switches';
import { onlyKeys, readJson } from '../api/body';
import { EVENT_TYPES, type EventType } from '../api/events';
import { mustChange } from '../api/idempotency';
import { checkWebhookUrl, encryptWebhookSecret, readAllowedHosts } from '../webhooks/crypto';
import { levelOn, openProject, visibleProjects } from './access';
import type { SignedIn } from './router';
import { auditStatement } from './session';

const MANAGER = 4, MAX_WEBHOOKS_PER_PROJECT = 20;
const refuse = () => new ApiError('forbidden', 'Your level does not allow this.');
const featureOff = () => new ApiError('feature_off', 'This feature is off.');

const stillWebhooksOn = (env: AppEnv): D1PreparedStatement =>
  env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'webhooks' AND value_json = 'true') THEN 1 ELSE json('off') END");

const stillManager = (env: AppEnv, memberId: string, projectId: string): D1PreparedStatement =>
  env.DB.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM members m WHERE m.id = ?1 AND m.removed_at IS NULL AND (
      m.role = 'owner' OR EXISTS (SELECT 1 FROM project_access x WHERE x.member_id = m.id AND x.project_id = ?2 AND x.level = 4)
    )
  ) THEN 1 ELSE json('forbidden') END`).bind(memberId, projectId);

const hostStillAllowed = (env: AppEnv, host: string): D1PreparedStatement =>
  env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM settings s, json_each(s.value_json) j WHERE s.key = 'webhook_hosts' AND j.value = ?) THEN 1 ELSE json('host') END").bind(host);

async function requireWebhooksOn(env: AppEnv): Promise<void> {
  if (!(await isOn(env.DB, 'webhooks'))) throw featureOff();
}

function readEventTypes(value: unknown): EventType[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || !value.every((t) => EVENT_TYPES.includes(t as EventType))) {
    throw invalid('eventTypes must be a non-empty list of event types.');
  }
  return EVENT_TYPES.filter((t) => (value as string[]).includes(t));
}

interface WebhookListRow {
  id: string;
  project_id: string;
  p_slug: string;
  p_name_en: string;
  p_name_ar: string;
  url: string;
  event_types_json: string;
  enabled: number;
  created_at: number;
  creator_name: string | null;
}

interface FailedDeliveryRow {
  webhook_id: string;
  event_seq: number;
  attempts: number;
  last_code: number | null;
  updated_at: number;
  url: string;
  p_slug: string;
  p_name_en: string;
  p_name_ar: string;
  event_type: string;
  event_at: number;
}

export async function listWebhooks(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  await requireWebhooksOn(env);
  const managed = person.isOwner ? null : (await visibleProjects(env, person)).filter((p) => p.level >= MANAGER);
  if (managed !== null && managed.length === 0) throw refuse();

  const hosts = await readAllowedHosts(env);
  let webhooks: WebhookListRow[] = [];
  let failed: FailedDeliveryRow[] = [];

  if (person.isOwner) {
    const [wRes, fRes] = await env.DB.batch([
      env.DB.prepare(`SELECT w.id, w.project_id, p.slug AS p_slug, p.name_en AS p_name_en, p.name_ar AS p_name_ar, w.url, w.event_types_json, w.enabled, w.created_at, m.name AS creator_name
        FROM webhooks w CROSS JOIN projects p ON p.id = w.project_id CROSS JOIN members m ON m.id = w.created_by WHERE w.id > '' ORDER BY w.id LIMIT 200`),
      env.DB.prepare(`SELECT d.webhook_id, d.event_seq, d.attempts, d.last_code, d.updated_at, w.url, p.slug AS p_slug, p.name_en AS p_name_en, p.name_ar AS p_name_ar, e.type AS event_type, e.created_at AS event_at
        FROM webhook_deliveries d CROSS JOIN webhooks w ON w.id = d.webhook_id CROSS JOIN projects p ON p.id = w.project_id CROSS JOIN events e ON e.seq = d.event_seq
        WHERE d.status = 'failed' ORDER BY d.updated_at DESC LIMIT 50`),
    ]);
    webhooks = wRes!.results as WebhookListRow[];
    failed = fRes!.results as FailedDeliveryRow[];
  } else {
    const byProject = new Map(managed!.map((p) => [p.id, p]));
    const wBatch = await env.DB.batch<{ id: string; project_id: string; url: string; event_types_json: string; enabled: number; created_at: number; creator_name: string | null }>(
      managed!.map((p) => env.DB.prepare('SELECT w.id, w.project_id, w.url, w.event_types_json, w.enabled, w.created_at, m.name AS creator_name FROM webhooks w JOIN members m ON m.id = w.created_by WHERE w.project_id = ?').bind(p.id)),
    );
    webhooks = wBatch.flatMap((r) => r.results).map((w) => {
      const p = byProject.get(w.project_id)!;
      return { ...w, p_slug: p.slug, p_name_en: p.name_en, p_name_ar: p.name_ar };
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (webhooks.length > 0) {
      const fBatch = await env.DB.batch<FailedDeliveryRow>(
        webhooks.map((w) => env.DB.prepare(`SELECT d.webhook_id, d.event_seq, d.attempts, d.last_code, d.updated_at, ?1 AS url, ?2 AS p_slug, ?3 AS p_name_en, ?4 AS p_name_ar, e.type AS event_type, e.created_at AS event_at
          FROM webhook_deliveries d CROSS JOIN events e ON e.seq = d.event_seq
          WHERE d.webhook_id = ?5 AND d.status = 'failed' ORDER BY d.event_seq DESC LIMIT 20`).bind(w.url, w.p_slug, w.p_name_en, w.p_name_ar, w.id)),
      );
      failed = fBatch.flatMap((r) => r.results).sort((a, b) => b.updated_at - a.updated_at || b.event_seq - a.event_seq).slice(0, 50);
    }
  }

  return Response.json({
    hosts,
    items: webhooks.map((w) => ({
      id: w.id,
      project: { slug: w.p_slug, name: { en: w.p_name_en, ar: w.p_name_ar } },
      url: w.url,
      eventTypes: JSON.parse(w.event_types_json) as EventType[],
      enabled: w.enabled === 1,
      createdBy: w.creator_name,
      createdAt: w.created_at,
    })),
    failed: failed.map((f) => ({
      webhookId: f.webhook_id,
      eventSeq: f.event_seq,
      url: f.url,
      project: { slug: f.p_slug, name: { en: f.p_name_en, ar: f.p_name_ar } },
      eventType: f.event_type,
      attempts: f.attempts,
      lastCode: f.last_code,
      updatedAt: f.updated_at,
      eventAt: f.event_at,
    })),
  });
}

export async function addWebhook(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx;
  await requireWebhooksOn(env);
  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['project', 'url', 'eventTypes', 'enabled']);
  if (typeof body.project !== 'string') throw invalid('project is required.');
  const { project, level } = await openProject(env, person, body.project, 1);
  if (level < MANAGER) throw refuse();
  const hosts = await readAllowedHosts(env);
  const { url, host } = checkWebhookUrl(body.url, hosts);
  const eventTypes = readEventTypes(body.eventTypes);
  const enabled = body.enabled === undefined ? true : body.enabled;
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false.');

  const now = Date.now(), id = newId('whk', now), secret = `whsec_${randomToken()}`;
  const encrypted = await encryptWebhookSecret(env, id, secret);
  try {
    await env.DB.batch([
      stillWebhooksOn(env),
      stillManager(env, person.memberId, project.id),
      hostStillAllowed(env, host),
      env.DB.prepare("SELECT CASE WHEN (SELECT COUNT(*) FROM webhooks WHERE project_id = ?) < ? THEN 1 ELSE json('full') END").bind(project.id, MAX_WEBHOOKS_PER_PROJECT),
      env.DB.prepare('INSERT INTO webhooks(id, project_id, url, event_types_json, secret_enc, enabled, created_by, created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id, project.id, url, JSON.stringify(eventTypes), encrypted, enabled ? 1 : 0, person.memberId, now),
      auditStatement(env, person.memberId, 'webhook.add', id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'webhooks'))) throw featureOff();
      const latestLevel = await levelOn(env, person, project.id);
      if (latestLevel < 1) throw notFound();
      if (latestLevel < MANAGER) throw refuse();
      if (!(await readAllowedHosts(env)).includes(host)) throw invalid('That host is not on the allowed list.');
      throw conflict('Too many webhooks on this project.');
    }
    throw error;
  }
  return Response.json({
    id,
    project: { slug: project.slug, name: { en: project.name_en, ar: project.name_ar } },
    url,
    eventTypes,
    enabled,
    createdBy: person.name,
    createdAt: now,
    secret,
  }, { status: 201 });
}

interface WebhookRow {
  id: string;
  project_id: string;
  url: string;
  event_types_json: string;
  enabled: number;
}

export async function updateWebhook(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!;
  await requireWebhooksOn(env);
  const webhook = await env.DB.prepare('SELECT id, project_id, url, event_types_json, enabled FROM webhooks WHERE id = ?').bind(id).first<WebhookRow>();
  const level = webhook ? await levelOn(env, person, webhook.project_id) : 0;
  if (!webhook || level < 1) throw notFound();
  if (level < MANAGER) throw refuse();

  const { body } = await readJson(ctx.request);
  onlyKeys(body, ['enabled', 'eventTypes']);
  if (body.enabled === undefined && body.eventTypes === undefined) throw invalid('Nothing to change.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw invalid('enabled must be true or false.');
  const hasEnabled = body.enabled !== undefined;
  const hasTypes = body.eventTypes !== undefined;
  const nextTypes = hasTypes ? readEventTypes(body.eventTypes) : null;

  const updateStmt = hasEnabled && hasTypes
    ? env.DB.prepare('UPDATE webhooks SET enabled = ?, event_types_json = ? WHERE id = ?').bind(body.enabled ? 1 : 0, JSON.stringify(nextTypes), id)
    : hasEnabled
      ? env.DB.prepare('UPDATE webhooks SET enabled = ? WHERE id = ?').bind(body.enabled ? 1 : 0, id)
      : env.DB.prepare('UPDATE webhooks SET event_types_json = ? WHERE id = ?').bind(JSON.stringify(nextTypes), id);

  let updated: { enabled: number; event_types_json: string } | undefined;
  try {
    const results = await env.DB.batch([
      stillWebhooksOn(env),
      stillManager(env, person.memberId, webhook.project_id),
      updateStmt,
      mustChange(env),
      auditStatement(env, person.memberId, 'webhook.update', id),
      env.DB.prepare('SELECT enabled, event_types_json FROM webhooks WHERE id = ?').bind(id),
    ]);
    updated = (results[5]?.results as { enabled: number; event_types_json: string }[] | undefined)?.[0];
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'webhooks'))) throw featureOff();
      const latestLevel = await levelOn(env, person, webhook.project_id);
      if (latestLevel < 1) throw notFound();
      if (latestLevel < MANAGER) throw refuse();
      throw notFound();
    }
    throw error;
  }
  return Response.json({
    id,
    enabled: (updated?.enabled ?? webhook.enabled) === 1,
    eventTypes: JSON.parse(updated?.event_types_json ?? webhook.event_types_json) as EventType[],
  });
}

export async function deleteWebhook(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!;
  await requireWebhooksOn(env);
  const webhook = await env.DB.prepare('SELECT id, project_id FROM webhooks WHERE id = ?').bind(id).first<{ id: string; project_id: string }>();
  const level = webhook ? await levelOn(env, person, webhook.project_id) : 0;
  if (!webhook || level < 1) throw notFound();
  if (level < MANAGER) throw refuse();

  try {
    await env.DB.batch([
      stillWebhooksOn(env),
      stillManager(env, person.memberId, webhook.project_id),
      env.DB.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').bind(id),
      env.DB.prepare('DELETE FROM webhooks WHERE id = ?').bind(id),
      mustChange(env),
      auditStatement(env, person.memberId, 'webhook.delete', id),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'webhooks'))) throw featureOff();
      const latestLevel = await levelOn(env, person, webhook.project_id);
      if (latestLevel < 1) throw notFound();
      if (latestLevel < MANAGER) throw refuse();
      throw notFound();
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}

export async function resendDelivery(ctx: SignedIn): Promise<Response> {
  const { env, person } = ctx, id = ctx.params[0]!, seq = Number(ctx.params[1]);
  await requireWebhooksOn(env);
  if (!Number.isSafeInteger(seq) || seq < 1) throw notFound();

  const webhook = await env.DB.prepare('SELECT id, project_id, url, enabled FROM webhooks WHERE id = ?')
    .bind(id).first<{ id: string; project_id: string; url: string; enabled: number }>();
  const level = webhook ? await levelOn(env, person, webhook.project_id) : 0;
  if (!webhook || level < 1) throw notFound();
  if (level < MANAGER) throw refuse();
  if (webhook.enabled !== 1) throw conflict('This webhook is off.');
  const { host } = checkWebhookUrl(webhook.url, await readAllowedHosts(env));

  const now = Date.now();
  try {
    await env.DB.batch([
      stillWebhooksOn(env),
      stillManager(env, person.memberId, webhook.project_id),
      hostStillAllowed(env, host),
      env.DB.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM webhooks WHERE id = ? AND enabled = 1) THEN 1 ELSE json('disabled') END").bind(id),
      env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'failed'").bind(now, id, seq),
      mustChange(env),
      auditStatement(env, person.memberId, 'webhook.resend', `${id}:${seq}`),
    ]);
  } catch (error) {
    if (String(error).includes('malformed JSON')) {
      if (!(await isOn(env.DB, 'webhooks'))) throw featureOff();
      const latestLevel = await levelOn(env, person, webhook.project_id);
      if (latestLevel < 1) throw notFound();
      if (latestLevel < MANAGER) throw refuse();
      const latest = await env.DB.prepare('SELECT enabled FROM webhooks WHERE id = ?').bind(id).first<{ enabled: number }>();
      if (!latest) throw notFound();
      if (latest.enabled !== 1) throw conflict('This webhook is off.');
      if (!(await readAllowedHosts(env)).includes(host)) throw invalid('That host is not on the allowed list.');
      throw notFound();
    }
    throw error;
  }

  try {
    await env.WEBHOOKS.send({ webhookId: id, eventSeq: seq });
  } catch (error) {
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE webhook_id = ? AND event_seq = ? AND status = 'pending'")
      .bind(Date.now(), id, seq).run();
    throw error;
  }
  return new Response(null, { status: 202 });
}
