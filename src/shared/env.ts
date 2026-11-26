/** Bindings both Workers have. */
export interface SharedEnv {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  /** Signs content addresses. */
  CONTENT_KEY: SecretsStoreSecret | string;
}

export interface WebhookMessage {
  webhookId: string;
  eventSeq: number;
  token?: string;
}

export interface AppEnv extends SharedEnv {
  LIVE: DurableObjectNamespace;
  /** For the HMACs of agent keys, device codes and session handles. */
  PEPPER: SecretsStoreSecret | string;
  /** Encrypts webhook signing secrets at rest (AES-256-GCM). */
  WEBHOOK_KEY: SecretsStoreSecret | string;
  /** Signs short-lived WebSocket tickets for live event pings. */
  LIVE_KEY: SecretsStoreSecret | string;
  /** Outbound webhook delivery queue. */
  WEBHOOKS: Queue<WebhookMessage>;
  /** Requests for each agent key. */
  KEY_LIMIT: RateLimit;
  /** Failed sign-ins with a key, for each address. */
  AUTH_LIMIT: RateLimit;
  /** People's sign-in, setup and device requests, for each address. */
  SIGNIN_LIMIT: RateLimit;
  /** Device codes typed, for each session. */
  CODE_LIMIT: RateLimit;
  ASSETS: Fetcher;
}

export type ContentEnv = SharedEnv;
