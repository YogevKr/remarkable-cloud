import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Vars } from "../types";
import { userAuth } from "../auth";

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
import { blobKey } from "../util/r2presign";
import { signedBlobUrl } from "./blobstorage";
import { crc32cHeader } from "../util/hash";

export const sync = new Hono<{ Bindings: Env; Variables: Vars }>();
sync.use("*", userAuth);

const rfc3339Nano = (ms: number) => new Date(ms).toISOString(); // RFC3339, UTC, 'Z'
const SCHEMA_VERSION = 3;
const MAX_UPLOAD_BYTES = 7_000_000_000;

// ---- Root pointer (D1, compare-and-set) ----------------------------------

async function getRoot(env: Env, uid: string) {
  return env.DB.prepare("SELECT hash, generation FROM roots WHERE uid = ?1")
    .bind(uid)
    .first<{ hash: string; generation: number }>();
}

// CAS rule: reject iff expectedGen != currentGen && currentGen > 0 && rootExists.
// First write (no row) always succeeds and lands at generation 1.
async function casRoot(
  env: Env,
  uid: string,
  expectedGen: number,
  hash: string,
): Promise<{ ok: true; generation: number } | { ok: false; generation: number }> {
  const now = Math.floor(Date.now() / 1000);
  const upd = await env.DB.prepare(
    "UPDATE roots SET hash = ?1, generation = generation + 1, updated = ?2 WHERE uid = ?3 AND generation = ?4",
  ).bind(hash, now, uid, expectedGen).run();
  if (upd.meta.changes && upd.meta.changes > 0) {
    return { ok: true, generation: expectedGen + 1 };
  }
  const cur = await getRoot(env, uid);
  if (!cur) {
    const ins = await env.DB.prepare(
      "INSERT INTO roots (uid, hash, generation, updated) VALUES (?1, ?2, 1, ?3) ON CONFLICT(uid) DO NOTHING",
    ).bind(uid, hash, now).run();
    if (ins.meta.changes && ins.meta.changes > 0) return { ok: true, generation: 1 };
    const cur2 = await getRoot(env, uid);
    return { ok: false, generation: cur2?.generation ?? 0 };
  }
  return { ok: false, generation: cur.generation };
}

sync.get("/sync/v3/root", async (c) => {
  const root = await getRoot(c.env, c.get("uid"));
  if (!root) return c.json({ message: "root not found" }, 404);
  c.header("x-goog-generation", String(root.generation));
  return c.json({ generation: root.generation, hash: root.hash });
});

sync.get("/sync/v4/root", async (c) => {
  const root = await getRoot(c.env, c.get("uid"));
  const payload = root
    ? { generation: root.generation, hash: root.hash, schemaVersion: SCHEMA_VERSION }
    : { generation: 0, schemaVersion: SCHEMA_VERSION };
  const body = JSON.stringify(payload);
  c.header("x-goog-hash", crc32cHeader(new TextEncoder().encode(body)));
  if (root) c.header("x-goog-generation", String(root.generation));
  return c.body(body, 200, { "content-type": "application/json" });
});

sync.put("/sync/v3/root", async (c) => {
  const req = await c.req.json<{ generation?: number; hash?: string; broadcast?: boolean }>().catch(() => null);
  if (!req?.hash) return c.json({ message: "missing hash" }, 400);
  const res = await casRoot(c.env, c.get("uid"), req.generation ?? 0, req.hash);
  if (!res.ok) {
    // 412 (reference returns 500 here — we fix it). Include current generation.
    c.header("x-goog-generation", String(res.generation));
    return c.json({ message: "wrong generation", generation: res.generation }, 412);
  }
  if (req.broadcast) {
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get("uid")));
    c.executionCtx.waitUntil(stub.notifySync(c.get("deviceId")));
  }
  c.header("x-goog-generation", String(res.generation));
  return c.json({ generation: res.generation, hash: req.hash });
});

// ---- Blobs (direct path through the Worker; prefer signed-urls below) ----

sync.get("/sync/v3/files/:file", async (c) => {
  const hash = c.req.param("file");
  const obj = await c.env.BLOBS.get(blobKey(c.get("uid"), hash));
  if (!obj) return c.json({ message: "not found" }, 404);
  const crc = obj.customMetadata?.crc32c;
  if (crc) c.header("x-goog-hash", `crc32c=${crc}`);
  if (hash === "root") c.header("x-goog-generation", "0");
  return c.body(obj.body, 200, { "content-type": "application/octet-stream" });
});

sync.put("/sync/v3/files/:file", async (c) => {
  const hash = c.req.param("file");
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const crc = crc32cHeader(bytes).slice("crc32c=".length);
  await c.env.BLOBS.put(blobKey(c.get("uid"), hash), bytes, { customMetadata: { crc32c: crc } });
  c.header("x-goog-hash", `crc32c=${crc}`);
  return c.body(null, 200);
});

// ---- Signed URLs -> R2 presigned (blob bytes bypass the Worker) ----------
// NOTE(verify-on-device): R2 presigned responses carry S3 headers, not the
// x-goog-hash the device may expect on downloads. Confirm via wrangler tail;
// if the device rejects, route downloads through /sync/v3/files instead.

interface BlobUrlReq { http_method?: string; initial_sync?: boolean; relative_path?: string }

async function signedUrls(c: Ctx, write: boolean) {
  const req = await c.req.json<BlobUrlReq>().catch(() => null);
  if (!req?.relative_path) return c.json({ message: "missing relative_path" }, 400);
  const { url, expires } = await signedBlobUrl(
    c.env,
    c.get("uid"),
    req.relative_path,
    write ? "write" : "read",
  );
  const body: Record<string, unknown> = {
    expires,
    method: write ? "PUT" : "GET",
    relative_path: req.relative_path,
    url,
  };
  if (write) body.maxuploadsize_bytes = MAX_UPLOAD_BYTES;
  return c.json(body);
}

sync.post("/sync/v2/signed-urls/downloads", (c) => signedUrls(c, false));
sync.post("/api/v1/signed-urls/downloads", (c) => signedUrls(c, false));
sync.post("/sync/v2/signed-urls/uploads", (c) => signedUrls(c, true));
sync.post("/api/v1/signed-urls/uploads", (c) => signedUrls(c, true));

// ---- Sync-complete + auxiliary -------------------------------------------

async function notify(c: Ctx) {
  const id = `rm-${Date.now()}`;
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get("uid")));
  c.executionCtx.waitUntil(stub.notifySync(c.get("deviceId")));
  return c.json({ id });
}
sync.post("/sync/v2/sync-complete", notify);
sync.post("/api/v1/sync-complete", notify);

sync.post("/sync/v3/check-files", async (c) => {
  const req = await c.req.json<{ files?: string[] }>().catch(() => null);
  const missing: string[] = [];
  for (const f of req?.files ?? []) {
    const head = await c.env.BLOBS.head(blobKey(c.get("uid"), f));
    if (!head) missing.push(f);
  }
  return c.json({ missingFiles: missing });
});

sync.get("/sync/v3/missing", (c) => c.json({ hashes: [] }));
sync.post("/sync/reports/v1", (c) => c.body(null, 200));
