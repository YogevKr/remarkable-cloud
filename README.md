# reMarkable Cloud on Cloudflare

A serverless reimplementation of the **reMarkable cloud sync API**, running entirely on
**Cloudflare Workers + R2 + D1 + Durable Objects**. Pair a reMarkable tablet to your own
infrastructure instead of reMarkable's cloud — your notebooks live in your R2 bucket.

Working end-to-end against a reMarkable 2 on OS 3.27.

## Architecture

```
[reMarkable] → rmfakecloud-proxy (on device) → https://<worker>  (Cloudflare Worker, Hono)
                                                   ├─ auth (device/user JWTs), discovery
                                                   ├─ root pointer + generation CAS → D1
                                                   ├─ content-addressed blobs        → R2
                                                   └─ live-sync notifications        → Durable Object
[Obsidian] ──────────────────────────────────────┘ (planned: /ui/api)
```

- **Worker** = control plane (auth, discovery, root CAS, signed blob URLs). Only small JSON flows through it.
- **R2** = content-addressed blob store (`users/{uid}/blobs/{sha256}`), uid-scoped per tenant.
- **D1** = the one mutable thing: per-user root pointer + generation, with compare-and-set (412 on conflict).
- **Durable Object** = holds the per-user notification WebSocket; fans out `SyncComplete`.

The full wire protocol (endpoints, auth, hash-tree format, CAS rules) is documented in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Setup

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars        # fill in secrets for local dev
wrangler d1 create remarkable          # put the id in wrangler.jsonc
wrangler r2 bucket create remarkable-blobs
wrangler d1 migrations apply remarkable --remote
wrangler secret put JWT_SECRET         # + ADMIN_TOKEN
wrangler deploy
```

On the device, install the `rmfakecloud-proxy` Vellum package and point it at the Worker URL.

## Security

- Per-tenant isolation via uid-scoped R2 keys; all sync routes require a valid user JWT.
- Signed (HMAC) blob URLs; constant-time token comparisons; PBKDF2 password hashing.
- Per-IP rate limiting on `/token/*` and `/admin/*` (sync paths intentionally unthrottled).
- Secrets via Cloudflare secrets / local `.dev.vars` (gitignored). Never commit `.dev.vars`.

## Credits

The reMarkable cloud wire protocol was **reverse-engineered from
[ddvk/rmfakecloud](https://github.com/ddvk/rmfakecloud)** (AGPL-3.0), used purely as a
reference. This is an independent implementation in TypeScript/Cloudflare — no code is
derived from rmfakecloud. Huge thanks to that project and the reMarkable hacking community.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by reMarkable AS. "reMarkable" is a
trademark of reMarkable AS, used here only nominatively to describe interoperability.

This is an independent interoperability project. It reimplements a network protocol learned
from an existing open-source reference (`ddvk/rmfakecloud`) and contains **no reMarkable
source code, firmware, certificates, or assets**. Provided as-is, for personal and
educational use, with no warranty.

Running a third-party cloud and modifying your device may breach reMarkable's Terms of
Service and/or void your warranty — that is your decision and your risk. This is not legal
advice.
