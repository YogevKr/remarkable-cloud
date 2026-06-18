import { AwsClient } from "aws4fetch";
import type { Env } from "../types";

// Build R2 S3-compatible presigned URLs so the device transfers blob bytes
// directly to/from R2, bypassing the Worker (no request-size limit on blobs).

const EXPIRES_SECONDS = 300; // 5 min, matches the reference implementation

function r2Endpoint(env: Env, key: string): string {
  // S3 path-style endpoint for R2.
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
}

let cachedClient: { key: string; client: AwsClient } | null = null;
function client(env: Env): AwsClient {
  const cacheKey = env.R2_ACCESS_KEY_ID;
  if (cachedClient && cachedClient.key === cacheKey) return cachedClient.client;
  const c = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  cachedClient = { key: cacheKey, client: c };
  return c;
}

export async function presignGet(env: Env, key: string): Promise<string> {
  const url = `${r2Endpoint(env, key)}?X-Amz-Expires=${EXPIRES_SECONDS}`;
  const signed = await client(env).sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

export async function presignPut(env: Env, key: string): Promise<string> {
  const url = `${r2Endpoint(env, key)}?X-Amz-Expires=${EXPIRES_SECONDS}`;
  const signed = await client(env).sign(url, { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

// R2 object key for a user's content-addressed blob.
export function blobKey(uid: string, hash: string): string {
  return `users/${uid}/blobs/${hash}`;
}
