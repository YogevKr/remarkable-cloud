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

`worker/wrangler.jsonc` is a template with placeholders. Keep your filled-in copy (D1 id,
hostnames, Access values) outside this public repo, and deploy with it:

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars        # fill in secrets for local dev
wrangler d1 create remarkable          # put the id in your config copy
wrangler r2 bucket create remarkable-blobs
wrangler d1 migrations apply remarkable --remote -c <your config>
wrangler secret put JWT_SECRET         # + ADMIN_TOKEN
wrangler deploy -c <your config>
```

On the device, install the `rmfakecloud-proxy` Vellum package and point it at the Worker URL.

### Deploy from a private repo

One way to keep the real config private: a private repo holds the filled-in `wrangler.jsonc`
and a pinned commit of this repo. Its CI checks out this repo at that commit, copies the
config into `worker/`, runs the tests, applies D1 migrations, and runs `wrangler deploy`.
Cloudflare credentials live only in that repo's CI secrets. When this repo adds a binding,
add it to the private config too.

## Drive (web UI)

A web page to see the library, upload, rename, move, and trash files, on its own hostname
behind Cloudflare Access. The tablet keeps syncing over `CLOUD_HOST`; it never uses the drive host.

- **Upload:** PDF and EPUB as they are. HTML files and web page URLs become PDF through
  Cloudflare Browser Rendering, with the page size of the reMarkable 2 screen.
- **Remove:** "Move to Trash" sets `parent: "trash"`, like the tablet does. Restore puts the item
  back at the top level. To delete permanently, empty the Trash on the tablet.
- **Writes:** build new blobs, then move the root pointer with CAS. On a concurrent tablet sync
  (CAS conflict) the change runs again on the new root. Then the tablet gets `SyncComplete`.
- **Auth:** Access in front, and the Worker also checks the Access JWT (`Cf-Access-Jwt-Assertion`:
  signature, `aud`, `iss`, expiry). `DRIVE_USERS` maps an Access identity to a reMarkable uid.

Setup:

```sh
# 1. Access app for the drive host (self-hosted, allow your email). In your config copy, set
#    DRIVE_HOST, ACCESS_TEAM_DOMAIN, ACCESS_AUD, and add the custom-domain route for DRIVE_HOST.
# 2. Map identities to accounts (Access email, or a service token client id):
printf '{"you@example.com":"<uid>"}' | wrangler secret put DRIVE_USERS -c <your config>
# 3. Migrate and deploy (adds the custom domain from `routes`):
wrangler d1 migrations apply remarkable --remote -c <your config>
wrangler deploy -c <your config>
```

Undo any change: every committed root is in `root_history`, and blobs never change.

```sh
wrangler d1 execute remarkable --remote --command \
  "SELECT generation, hash, source, created FROM root_history WHERE uid='<uid>' ORDER BY generation DESC LIMIT 20"
wrangler d1 execute remarkable --remote --command \
  "UPDATE roots SET hash='<old hash>', generation=generation+1 WHERE uid='<uid>'"
```

Tests:

- `npm test` - hash-tree unit tests (Node test runner).
- `node scripts/e2e-drive.mjs ...` - end to end, as a fake tablet and a drive user, on a
  **throwaway** account. Locally it signs its own Access JWTs (`--jwt-key`, with the public JWKS
  passed to `wrangler dev` as `ACCESS_JWKS`). In production it goes through Access with a service
  token (`--service-token`, `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`). See the script header.
- Local dev: run the template config (it has no `routes`; a custom-domain route makes
  `wrangler dev` rewrite every request host). Serve the drive on `localhost` and the device API
  on `127.0.0.1`:

  ```sh
  wrangler dev --port 8799 --ip 127.0.0.1 \
    --var DRIVE_HOST:localhost --var ACCESS_TEAM_DOMAIN:test.cloudflareaccess.com \
    --var ACCESS_AUD:test-aud --var "ACCESS_JWKS:$(cat test-jwks.json)" \
    --var 'DRIVE_USERS:{"e2e@example.test":"<throwaway uid>"}'
  ```

  Browser Rendering does not run in local dev (it stalls downloading a browser); test HTML and
  URL rendering against production with the throwaway account.

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
