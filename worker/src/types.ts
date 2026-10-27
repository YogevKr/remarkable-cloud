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
  BROWSER: Fetcher; // Browser Rendering, for HTML -> PDF in the drive

  // Vars
  CLOUD_HOST: string;
  DRIVE_HOST: string; // hostname that serves the drive (behind Cloudflare Access)
  ACCESS_TEAM_DOMAIN: string; // e.g. "team.cloudflareaccess.com"
  ACCESS_AUD: string; // Access application audience tag
  ACCESS_JWKS?: string; // local tests only: inline JWKS instead of the team certs URL

  // Secrets
  JWT_SECRET: string;
  ADMIN_TOKEN: string;
  DRIVE_USERS: string; // JSON {"<Access email or service-token client id>": "<uid>"}
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
