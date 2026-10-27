import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env, RateLimit, Vars } from "./types";
import { discovery } from "./routes/discovery";
import { tokens } from "./routes/tokens";
import { admin } from "./routes/admin";
import { sync } from "./routes/sync";
import { blobstorage } from "./routes/blobstorage";
import { userAuth } from "./auth";
import { drive } from "./drive/routes";

export { UserHub } from "./hub";

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Per-IP rate limiting for sensitive, low-frequency endpoints. Registered before
// the routers so it wraps them. Never applied to /sync/* or /blobstorage.
function rateLimit(pick: (env: Env) => RateLimit): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const key = c.req.header("CF-Connecting-IP") || "anon";
    const { success } = await pick(c.env).limit({ key });
    if (!success) return c.json({ message: "rate limited" }, 429);
    await next();
  };
}
app.use("/token/*", rateLimit((e) => e.RL_TOKEN));
app.use("/admin/*", rateLimit((e) => e.RL_ADMIN));

app.get("/health", (c) => c.text("ok"));

// Unauthenticated surfaces
app.route("/", discovery);
app.route("/", tokens);
app.route("/", admin);
app.route("/", blobstorage); // auth via signed query params

// Device-facing sync API (each route runs userAuth internally)
app.route("/", sync);

// Notification WebSocket — authed, then forwarded to the per-user Durable Object.
app.get("/notifications/ws/json/1", userAuth, async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.get("uid")));
  const url = new URL(c.req.url);
  url.searchParams.set("deviceId", c.get("deviceId"));
  return stub.fetch(new Request(url, c.req.raw));
});

// Catch-all: log unimplemented endpoints the real device hits (watch via `wrangler tail`).
app.all("*", (c) => {
  console.log(`UNHANDLED ${c.req.method} ${new URL(c.req.url).pathname}`);
  return c.json({ message: "not implemented" }, 404);
});

// The drive lives on its own hostname (behind Cloudflare Access); every other
// hostname gets the device API above. The drive also checks the Access JWT itself.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (env.DRIVE_HOST && new URL(request.url).hostname === env.DRIVE_HOST) return drive.fetch(request, env, ctx);
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
