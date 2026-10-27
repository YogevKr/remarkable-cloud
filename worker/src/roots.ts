import type { Env } from "./types";

// ---- Root pointer (D1, compare-and-set) ----------------------------------
// Shared by the device sync API and the drive. Every successful write is also
// recorded in root_history, so any earlier tree can be restored (blobs are
// content-addressed and never change).

export async function getRoot(env: Env, uid: string) {
  return env.DB.prepare("SELECT hash, generation FROM roots WHERE uid = ?1")
    .bind(uid)
    .first<{ hash: string; generation: number }>();
}

// CAS rule: reject iff expectedGen != currentGen && currentGen > 0 && rootExists.
// First write (no row) always succeeds and lands at generation 1.
export async function casRoot(
  env: Env,
  uid: string,
  expectedGen: number,
  hash: string,
  source: string,
): Promise<{ ok: true; generation: number } | { ok: false; generation: number }> {
  const res = await casRootRaw(env, uid, expectedGen, hash);
  if (res.ok) await recordHistory(env, uid, res.generation, hash, source);
  return res;
}

async function casRootRaw(
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

// History is best-effort: a failed insert must never fail a sync that already committed.
async function recordHistory(env: Env, uid: string, generation: number, hash: string, source: string) {
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO root_history (uid, generation, hash, source, created) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(uid, generation, hash, source.slice(0, 200), Math.floor(Date.now() / 1000)).run();
  } catch (err) {
    console.error(`root_history insert failed uid=${uid} gen=${generation}: ${err}`);
  }
}
