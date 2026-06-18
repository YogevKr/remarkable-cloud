import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, Vars } from "../types";
import { mintDeviceToken, mintUserToken, deviceUid } from "../auth";

export const tokens = new Hono<{ Bindings: Env; Variables: Vars }>();

// Device registration: consume a one-time pairing code -> device JWT (raw text body).
tokens.post("/token/json/2/device/new", async (c) => {
  const body = await c.req.json<{ code?: string; deviceDesc?: string; deviceID?: string }>().catch(() => null);
  const code = body?.code?.toLowerCase().trim();
  if (!code) return c.json({ message: "missing code" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(
    "SELECT uid FROM pairing_codes WHERE code = ?1 AND expires > ?2",
  ).bind(code, now).first<{ uid: string }>();
  if (!row) return c.json({ message: "invalid code" }, 400);

  await c.env.DB.prepare("DELETE FROM pairing_codes WHERE code = ?1").bind(code).run();

  const token = await mintDeviceToken(
    row.uid,
    body?.deviceDesc ?? "remarkable",
    body?.deviceID ?? "",
    c.env.JWT_SECRET,
  );
  return c.text(token);
});

// Exchange a device token for a short-lived user token (raw text body).
tokens.post("/token/json/2/user/new", async (c) => {
  const uid = await deviceUid(c);
  if (!uid) return c.json({ message: "invalid device token" }, 401);

  const user = await c.env.DB.prepare(
    "SELECT email, sync15 FROM users WHERE uid = ?1",
  ).bind(uid).first<{ email: string; sync15: number }>();
  if (!user) return c.json({ message: "unknown user" }, 401);

  // device-desc/id ride along from the device token; re-read for the new token.
  const token = await mintUserToken(
    uid,
    "remarkable",
    "",
    user.email,
    user.sync15 === 1,
    c.env.CLOUD_HOST,
    c.env.JWT_SECRET,
  );
  return c.text(token);
});

// Unregister — no real revocation needed.
const del = (c: Context<{ Bindings: Env; Variables: Vars }>) => c.body(null, 204);
tokens.post("/token/json/2/device/delete", del);
tokens.post("/token/json/3/device/delete", del);
