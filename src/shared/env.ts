/** Bindings both Workers have. */
export interface SharedEnv {
  DB: D1Database;
  FILES: R2Bucket;
}

export interface AppEnv extends SharedEnv {
  LIVE: DurableObjectNamespace;
}

export type ContentEnv = SharedEnv;
