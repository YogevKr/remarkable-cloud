import type { Context, MiddlewareHandler } from "hono";
import type { Env, Vars } from "./types";
import { signJwt, verifyJwt, bearer } from "./util/jwt";

export const TOKEN_VERSION = 10; // user JWT must carry version:10 or the device is rejected
const USER_TTL_SECONDS = 3 * 60 * 60; // 3h, matches reference

// ---- Token minting -------------------------------------------------------

export function mintDeviceToken(
  uid: string,
  deviceDesc: string,
  deviceId: string,
  secret: string,
): Promise<string> {
  return signJwt(
    {
      "auth0-userid": `auth0|${uid}`,
      "device-desc": deviceDesc,
      "device-id": deviceId,
      aud: "api",
      iss: "rM Device",
      iat: Math.floor(Date.now() / 1000),
    },
    secret,
  );
}

export function userScopes(sync15: boolean): string {
  const base = ["intgr", "screenshare", "docedit"];
  base.push(sync15 ? "sync:tortoise" : "sync:default");
  return base.join(" ");
}

export function mintUserToken(
  uid: string,
  deviceDesc: string,
  deviceId: string,
  email: string,
  sync15: boolean,
  cloudHost: string,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      "auth0-profile": {
        UserID: `auth0|${uid}`,
        IsSocial: false,
        Connection: "Username-Password-Authentication",
        Name: email,
        Nickname: email,
        Email: `${email} (via ${cloudHost})`,
        EmailVerified: true,
      },
      "device-desc": deviceDesc,
      "device-id": deviceId,
      scopes: userScopes(sync15),
      version: TOKEN_VERSION,
      level: "connect",
      tectonic: "eu",
      sub: `auth0|${uid}`,
      iss: "rM WebApp",
      aud: "api",
      iat: now,
      nbf: now,
      exp: now + USER_TTL_SECONDS,
    },
    secret,
  );
}

// ---- User-JWT middleware (device-facing sync routes) ---------------------

interface UserClaims {
  sub?: string;
  version?: number;
  scopes?: string;
  "device-id"?: string;
  "auth0-profile"?: { UserID?: string };
}

function stripAuth0(id: string): string {
  return id.startsWith("auth0|") ? id.slice("auth0|".length) : id;
}

export const userAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const token = bearer(c.req.header("Authorization"));
  if (!token) return c.json({ message: "missing token" }, 401);
  const claims = await verifyJwt<UserClaims>(token, c.env.JWT_SECRET);
  if (!claims) return c.json({ message: "invalid token" }, 401);
  if (claims.version !== TOKEN_VERSION) return c.json({ message: "bad token version" }, 401);

  const rawUid = claims.sub || claims["auth0-profile"]?.UserID || "";
  const uid = stripAuth0(rawUid);
  if (!uid) return c.json({ message: "no user" }, 401);

  const scopes = claims.scopes || "";
  c.set("uid", uid);
  c.set("deviceId", claims["device-id"] || "");
  c.set("sync15", scopes.includes("sync:tortoise") || scopes.includes("sync:fox"));
  await next();
};

// Device-token validation for POST /token/json/2/user/new
export async function deviceUid(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<string | null> {
  const token = bearer(c.req.header("Authorization"));
  if (!token) return null;
  const claims = await verifyJwt<{ "auth0-userid"?: string }>(token, c.env.JWT_SECRET);
  if (!claims || !claims["auth0-userid"]) return null;
  return stripAuth0(claims["auth0-userid"]);
}

// ---- Password hashing (PBKDF2-SHA256) ------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const iterations = 100_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return `${iterations}:${b64(salt)}:${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [iterStr, saltB64, hashB64] = stored.split(":");
  const iterations = parseInt(iterStr, 10);
  const salt = unb64(saltB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits)) === hashB64;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str: string): Uint8Array {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
