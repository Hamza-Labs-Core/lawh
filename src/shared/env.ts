/** Bindings both Workers have. */
export interface SharedEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export interface AppEnv extends SharedEnv {
  LIVE: DurableObjectNamespace;
  /** For the HMAC of agent keys. */
  PEPPER: SecretsStoreSecret | string;
  /** Requests for each agent key. */
  KEY_LIMIT: RateLimit;
  /** Failed sign-ins with a key, for each address. */
  AUTH_LIMIT: RateLimit;
}

export type ContentEnv = SharedEnv;
