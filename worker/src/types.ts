import type { UserHub } from "./hub";

// Workers native rate-limiting binding.
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  // Bindings
  DB: D1Database;
  BLOBS: R2Bucket;
  USER_HUB: DurableObjectNamespace<UserHub>;
  RL_TOKEN: RateLimit;
  RL_ADMIN: RateLimit;

  // Vars
  CLOUD_HOST: string;

  // Secrets
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
}

// Hono context variables we set in middleware.
export type Vars = {
  uid: string;
  deviceId: string;
  sync15: boolean;
};
