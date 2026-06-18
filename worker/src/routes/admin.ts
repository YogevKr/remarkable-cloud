import { Hono } from "hono";
import type { Env, Vars } from "../types";
import { hashPassword } from "../auth";
import { timingSafeEqual } from "../util/sign";

// Temporary bootstrap routes (bearer ADMIN_TOKEN) to create a user and mint a
// pairing code, so we can pair the device before the full /ui/api exists.
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

admin.use("/admin/*", async (c, next) => {
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  // Require a configured admin token; constant-time compare to avoid timing leaks.
  if (!c.env.ADMIN_TOKEN || !timingSafeEqual(token, c.env.ADMIN_TOKEN)) {
    return c.json({ message: "unauthorized" }, 401);
  }
  await next();
});

admin.post("/admin/users", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  const email = body?.email;
  const password = body?.password;
  if (!email || !password) return c.json({ message: "email and password required" }, 400);
  const uid = crypto.randomUUID().replace(/-/g, "");
  const passHash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (uid, email, pass_hash, sync15, created) VALUES (?1, ?2, ?3, 1, ?4)",
    ).bind(uid, email, passHash, Math.floor(Date.now() / 1000)).run();
  } catch {
    return c.json({ message: "email already exists" }, 409);
  }
  return c.json({ uid, email });
});

admin.post("/admin/codes", async (c) => {
  const body = await c.req.json<{ uid?: string; email?: string }>().catch(() => null);
  const { uid, email } = body ?? {};
  let resolvedUid = uid;
  if (!resolvedUid && email) {
    const row = await c.env.DB.prepare("SELECT uid FROM users WHERE email = ?1").bind(email).first<{ uid: string }>();
    resolvedUid = row?.uid;
  }
  if (!resolvedUid) return c.json({ message: "uid or known email required" }, 400);

  const code = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => String.fromCharCode(97 + (b % 26)))
    .join("");
  const expires = Math.floor(Date.now() / 1000) + 5 * 60;
  await c.env.DB.prepare("INSERT INTO pairing_codes (code, uid, expires) VALUES (?1, ?2, ?3)")
    .bind(code, resolvedUid, expires).run();
  return c.json({ code, expires });
});
