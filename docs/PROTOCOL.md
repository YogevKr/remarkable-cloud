# reMarkable Cloud — Protocol Spec & Cloudflare Design

Ground truth reverse-engineered from `ddvk/rmfakecloud` (Go reference impl), targeting a
**reMarkable 2 on OS 3.27** synced through a **Cloudflare Worker + R2 + D1 + Durable Object**.

Goal: reimplement the reMarkable cloud sync API as a serverless Worker so the device + Obsidian
sync against our infra. Blobs live in R2; the Worker is the control plane.

---

## 1. Architecture

```
[reMarkable] → rmfakecloud-proxy (on device) → https://rm.<domain> (Cloudflare)
                                                    │
                                            ┌───────▼─────────┐
                                            │  Worker (Hono)  │  control plane: auth, discovery,
                                            │                 │  root CAS, signed-URL minting
                                            └──┬───────┬───┬──┘
                          presigned R2 PUT/GET│       │   │ ping on change
       blob bytes  ◄──────device↔R2 direct────┘       │   ▼
                                                       │  Durable Object (per user)
                                            ┌──────────▼──┐   - holds /notifications WebSocket(s)
                                            │     D1      │   - fan-out SyncComplete to other devices
                                            │ users,roots │
                                            └─────────────┘
       R2 bucket:  users/{uid}/blobs/{sha256hex}   (immutable, content-addressed)
[Obsidian] ──── decision pending (§9) ────► same Worker
```

**Why this maps cleanly:** the reMarkable cloud is a Git-like content-addressed blob store — blobs
keyed by `sha256(bytes)`, with a single mutable **root pointer + generation**. Blobs → R2. The
mutable root + CAS → D1. Live "re-sync" push → Durable Object WebSocket.

**The 100 MB win:** in sync-1.5 the device asks for a *signed URL* then transfers the blob directly
to storage. We return **R2 S3 presigned URLs**, so large blobs go **device ↔ R2 directly, bypassing
the Worker** — no Cloudflare request-size limit on blob bytes. Only the tiny root pointer goes
through the Worker (for CAS).

---

## 2. Auth flow

All JWTs are **HS256, one shared secret** (`JWT_SECRET`). Audiences distinguish token types:
`api` (device), (user token has profile+scopes), `web` (UI/Obsidian), `storage` (legacy 1.0 only).

**Token bodies are returned as raw text/plain JWT strings, NOT JSON.**

### 2.1 Pairing code → device token — `POST /token/json/2/device/new`
- Request JSON: `{ "code": "<8 lowercase letters>", "deviceDesc": "...", "deviceID": "..." }`
- `code` is a one-time pairing code (we mint via the UI; 5-min TTL). Resolves to a `uid`.
- Response: **raw device JWT** (text/plain). Claims (`DeviceClaims`):
  - `auth0-userid` = uid, `device-desc`, `device-id`, audience `api`, **no expiry**.

### 2.2 Device token → user token — `POST /token/json/2/user/new`
- Auth: `Authorization: Bearer <deviceJWT>`. Body ignored.
- Response: **raw user JWT** (text/plain), **3h expiry**. Claims (`UserClaims`) — load-bearing fields:
  - `auth0-profile` object: `{ UserID: "auth0|<uid>", Name, Email, EmailVerified:true, Connection:"Username-Password-Authentication", ... }`
  - `device-desc`, `device-id`
  - **`version` = 10** ← middleware rejects any other value. MUST set.
  - `level` = `"connect"`, `tectonic` = `"eu"`
  - **`scopes`** = space-separated; **must include `sync:tortoise`** to enable sync-1.5
    (else `sync:default` = legacy 1.0). Also `intgr screenshare docedit`.
  - Standard: `sub` = `auth0|<uid>`, `iss` = `"rM WebApp"`, `exp` = now+3h.
- Auth middleware on every sync route: verify HS256, require `version==10`, derive `uid`
  (strip `auth0|`), pick sync version from scopes.

### 2.3 Device delete — `POST /token/json/{2,3}/device/delete` → 204 (no real revocation needed).

---

## 3. Discovery (unauthenticated)

- `GET /discovery/v1/endpoints` → `{ "notifications": "<host>", "webapp": "<host>", "mqttbroker": "<host>" }`
  - `notifications` = host of our WebSocket. We can **omit `mqttbroker`** (MQTT is screen-share only; skip).
- `GET /discovery/v1/webapp` → `{ "Host": "<host>", "Status": "OK" }`
- `GET /service/json/1/:service` (legacy) → `{ "Host": "<host>", "Status": "OK" }`;
  for `:service == "blob-storage"`, Host is `https://<host>`.

`<host>` = our domain (e.g. `rm.<domain>`). Newer OS uses `/discovery/v1/*`.

---

## 4. Sync-1.5 endpoints (the ones we implement first)

Endpoint *path* selects protocol (no version sniffing). Sync-1.5 families: `/api/v1/*`,
`/sync/v2/*`, `/sync/v3/*`, `/sync/v4/*` (all behind user-JWT auth).

| Endpoint | Purpose | Our impl |
|---|---|---|
| `GET /sync/v3/root` | read root | D1 lookup → `{generation, hash}`; **404** `{"message":"root not found"}` if none |
| `GET /sync/v4/root` | read root (v4) | like v3 but **200** `{generation,hash,schemaVersion:3}` when empty; add `x-goog-hash: crc32c=…` header |
| `PUT /sync/v3/root` | **CAS** write root | D1 conditional update; body `{generation, hash, broadcast}`; return `{generation,hash}`; **412 on conflict** (rmfakecloud returns 500 here — we fix to 412); if `broadcast` → ping DO |
| `GET /sync/v3/files/:hash` | read blob | R2 get; 404 if absent; `x-goog-hash` header; `application/octet-stream` |
| `PUT /sync/v3/files/:hash` | write blob (direct) | R2 put (Worker-streamed; 100MB cap applies here — prefer signed-URL path) |
| `POST /sync/v2/signed-urls/downloads` | get blob GET url | mint **R2 presigned GET**; resp `{expires,method:"GET",relative_path,url}` |
| `POST /sync/v2/signed-urls/uploads` | get blob PUT url | mint **R2 presigned PUT**; resp `{…,method:"PUT",url,maxuploadsize_bytes}` |
| `POST /api/v1/signed-urls/{downloads,uploads}` | older aliases | same handlers |
| `POST /sync/v2/sync-complete` | notify | body `{generation}`; ping DO; resp `{id}` |
| `POST /api/v1/sync-complete` | notify | resp `{id}` |
| `POST /sync/v3/check-files` | which blobs missing | body `{filename,files[],reason}`; resp `{missingFiles:[]}` (R2 head per hash) |
| `GET /sync/v3/missing` | stub | `{hashes:[]}` |
| `POST /sync/reports/v1` | telemetry sink | 200 |

**signed-urls request** (single object, not array): `{ "http_method": "...", "initial_sync": bool, "relative_path": "<hash>" }`.
`relative_path` carries the blob hash.

**signed-urls response** (single object): `{ "expires": "<RFC3339Nano UTC>", "method": "GET|PUT", "relative_path": "<hash>", "url": "<presigned R2 url>", "maxuploadsize_bytes": <int, uploads only> }`.

---

## 5. Content-addressing & hash-tree format (EXACT — load-bearing)

- **Blob key = lowercase hex `sha256(rawbytes)`.** R2 object key: `users/{uid}/blobs/{hash}`.
- Field delimiter `:`  (single colon). Line terminator `\n`.
- **Tree/doc hashing (Merkle):** sort children by `EntryName`/docid; hash = `hex(sha256( concat of hex-DECODED child hashes ))`. It hashes the **raw child hashes**, not the index text.

**Root index file** (stored as its own blob; its hash is the root pointer's `hash`):
```
<schemaVersion>\n                         # "3" or "4"
[ 0:.:<numDocs>:<totalSize>\n ]           # v4 ONLY: summary line
<docHash>:80000000:<docId>:<numFiles>:<size>\n   # one per document
...
```

**Per-document index file** (stored as its own blob; always schema `"3"`):
```
3\n
<fileHash>:0:<entryName>:0:<size>\n       # one per component file
...
```
`entryName`s look like `<docid>.metadata`, `<docid>.content`, `<docid>.pdf|.epub|.rm`, etc.

Line field order (5 fields): `Hash : Type : EntryName : Subfiles : Size`
(`Type`=`80000000` for doc, `0` for file; `Subfiles`=`0` for files).

---

## 6. Root pointer & generation CAS (the only strongly-consistent bit)

- Root = `{ uid, hash (=root index blob hash), generation (int) }` → **D1 row per user**.
- **CAS rule:** reject iff `expectedGen != currentGen && currentGen > 0 && rootExists`; the very
  first write (no row / gen 0) always succeeds. On success `generation += 1`.
- Implement with `UPDATE roots SET hash=?, generation=generation+1 WHERE uid=? AND generation=?`
  → `meta.changes==0` means conflict → **HTTP 412** + current generation.
- (Reference uses a `.root.history` file size/86 hack for generation — **do NOT copy**; use an
  explicit integer column.)

**GCS-style headers (the device's GCS client expects these):**
- `x-goog-hash: crc32c=<base64 big-endian Castagnoli>` on blob/root reads.
- `x-goog-generation: <int>` on root reads + uploads.
- `x-goog-if-generation-match: <int>` honored on root upload (CAS precondition).

---

## 7. Signed-URL / blob-bytes flow → R2 presigned

1. Device `POST /sync/v2/signed-urls/uploads {relative_path:<hash>}` → Worker mints **R2 S3
   presigned PUT** (via `aws4fetch`/SigV4 with R2 S3 creds), returns it.
2. Device PUTs blob bytes **directly to R2** (bypasses Worker → no size limit, multipart ok).
3. Downloads symmetric (presigned GET).
4. **Exception — the root:** the root pointer's CAS cannot be enforced by a presigned R2 PUT, so the
   root update always goes through the **Worker** (`PUT /sync/v3/root`, tiny payload). Large blobs →
   R2 direct; tiny root → Worker+D1.

R2 S3 endpoint: `https://<account_id>.r2.cloudflarestorage.com/<bucket>`; presign with R2 access
key/secret (S3 API token). 5-min expiry (matches reference).

---

## 8. Live-sync signaling — `GET /notifications/ws/json/1` (WebSocket)

- This is the ONLY document-sync notification channel — **a persistent WebSocket** (no REST/long-poll
  alternative). 3.27's "REST signaling" is **screen-share only** (we skip screen-share for now).
- Cloudflare: a **Durable Object per user** accepts the WS (WebSocket Hibernation API → ~free when
  idle). On a successful root CAS with `broadcast:true` (or `sync-complete`), the Worker pings the
  user's DO, which sends a `SyncComplete` message to all the user's *other* connected devices.
- Message shape (`WsMessage`): `{ "message": { "attributes": { "event":"SyncComplete",
  "auth0UserID":"...", "sourceDeviceID":"...", ... }, "messageId":"...", "publishTime":"..." } }`.
- **MVP:** DO can just hold the socket open (no fan-out) — single device + Obsidian polling still
  works because the device syncs on its own. Real fan-out is a fast follow.

---

## 9. UI / client API (for Obsidian) — DECISION PENDING

rmfakecloud exposes a **separate** web API under `/ui/api/*` (web-JWT, audience `web`):
- `POST /ui/api/login {email,password}` → raw JWT.
- `GET /ui/api/documents` → document tree (`{Entries[],Trash[]}`, folders nest `children`).
- `GET /ui/api/documents/:id?type=rmdoc` → **raw `.rmdoc` zip** (notebook source); default `type=pdf` → rendered PDF.
- `POST /ui/api/documents/upload` (multipart), `POST /ui/api/folders`, `PUT/DELETE` docs.
- `GET /ui/api/newcode` → device pairing code.

**The Obsidian "Remarkable Synchronizer" plugin can target either the official cloud device API OR
rmfakecloud's `/ui/api`.** Two options for us:
- **(A)** Implement the `/ui/api` surface too → the existing Obsidian plugin (rmfakecloud mode) works
  as-is. More endpoints, but reuses a maintained plugin. **Leaning A.**
- **(B)** Skip `/ui/api`; have Obsidian read R2/D1 directly via a small custom script. Less compatible.

We also need a minimal **web UI** (or CLI) to: create a user, mint a pairing code. Could be one
authenticated Worker route + `wrangler`/curl instead of a full React app.

---

## 10. Cloudflare resources

- **R2 bucket** `remarkable-blobs` — objects `users/{uid}/blobs/{hash}`. + S3 API token for presigning.
- **D1** `remarkable`:
  - `users(uid TEXT PK, email TEXT UNIQUE, pass_hash TEXT, sync15 INT DEFAULT 1, created INT)`
  - `roots(uid TEXT PK, hash TEXT, generation INT DEFAULT 0)`
  - `pairing_codes(code TEXT PK, uid TEXT, expires INT)`
- **Durable Object** `UserHub` — one per uid; holds notification WebSockets, fan-out.
- **Secrets:** `JWT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`.
- **Worker** (Hono router) bound to all of the above; custom domain `rm.<domain>`.

---

## 11. Open questions — verify against the REAL 3.27 device (not just rmfakecloud)

1. **Does 3.27 use signed-urls or the direct `/sync/v3/files/:hash` path?** (We'll implement both;
   capture real traffic during first pairing to confirm.)
2. **Root via `PUT /sync/v3/root` (JSON) or `/blobstorage?blobid=root` (x-goog-if-generation-match)?**
   Implement both; the device picks one.
3. **Schema v3 vs v4 root index** — does 3.27 send/expect v4 summary line? Default to handling both.
4. **Exact discovery sequence** on first connect (which `/discovery` + `/service` calls, order).
5. **Does the device require a valid TLS chain on our domain only, or also pin anything?** (Cloudflare
   gives valid TLS; rmfakecloud-proxy on-device handles the hostname redirect.)
6. **`rmfakecloud-proxy` (Vellum pkg) config** — exact field for "cloud URL" pointing at our Worker.

→ Plan: capture real device requests via the Worker's logs (`wrangler tail`) during a test pairing
on a **throwaway account**, with real notes backed up.

---

## 12. Build phases

1. **Scaffold** — Hono Worker + wrangler bindings (R2, D1, DO), `aws4fetch`, D1 schema, secrets.
2. **Auth + discovery** — pairing code, device/user tokens (version=10, sync:tortoise), JWT verify, `/discovery/*`.
3. **Sync core** — `/sync/v3/root` (D1 CAS, 412), `/sync/v3/files/:hash` (R2), signed-urls→presigned R2, sync-complete, check-files.
4. **Notifications** — `UserHub` DO holding the WS (hold-open first, fan-out next).
5. **Device test** — point `rmfakecloud-proxy` at the Worker on a test account; `wrangler tail`; iterate on the §11 unknowns.
6. **Obsidian** — implement `/ui/api/*` (option A) + minimal user/code admin; wire the plugin.
```
