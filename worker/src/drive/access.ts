import type { Env } from "../types";

// Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion header) that
// Access adds to every request it lets through. Fails closed: the drive never
// trusts the hostname alone, so a request that skips Access gets nothing.

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let keyCache: { keys: Map<string, CryptoKey>; fetched: number } | null = null;
const KEY_TTL_MS = 10 * 60 * 1000;

async function loadKeys(env: Env, force: boolean): Promise<Map<string, CryptoKey>> {
  if (!force && keyCache && Date.now() - keyCache.fetched < KEY_TTL_MS) return keyCache.keys;
  let jwks: { keys: Jwk[] };
  if (env.ACCESS_JWKS) {
    jwks = JSON.parse(env.ACCESS_JWKS); // local tests only; never set in production
  } else {
    const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
    jwks = await res.json();
  }
  const keys = new Map<string, CryptoKey>();
  for (const k of jwks.keys) {
    if (k.kty !== "RSA") continue;
    keys.set(
      k.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  keyCache = { keys, fetched: Date.now() };
  return keys;
}

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  common_name?: string; // set instead of email for an Access service token
}

// Returns the Access identity (email, or service-token client id), or null.
export async function accessIdentity(env: Env, token: string | undefined): Promise<string | null> {
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let key = (await loadKeys(env, false)).get(header.kid);
  if (!key) key = (await loadKeys(env, true)).get(header.kid); // keys rotated
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
  return (claims.email || claims.common_name || "").toLowerCase() || null;
}

// DRIVE_USERS maps an Access identity to the reMarkable account it may manage.
export function driveUid(env: Env, identity: string): string | null {
  let map: Record<string, string>;
  try {
    map = JSON.parse(env.DRIVE_USERS || "{}");
  } catch {
    return null;
  }
  for (const [who, uid] of Object.entries(map)) if (who.toLowerCase() === identity) return uid;
  return null;
}
