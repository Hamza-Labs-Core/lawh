/** Bindings both Workers have. */
export interface SharedEnv {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ORIGIN: string;
  CONTENT_ORIGIN: string;
  /** Signs content addresses. */
  CONTENT_KEY: SecretsStoreSecret | string;
}

export interface AppEnv extends SharedEnv {
  LIVE: DurableObjectNamespace;
  /** For the HMAC of agent keys. */
  PEPPER: SecretsStoreSecret | string;
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
