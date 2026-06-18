import { Hono } from "hono";
import type { Env, Vars } from "../types";

export const discovery = new Hono<{ Bindings: Env; Variables: Vars }>();

// Newer OS uses /discovery/v1/*. We omit mqttbroker (MQTT is screen-share only).
discovery.get("/discovery/v1/endpoints", (c) => {
  const host = c.env.CLOUD_HOST;
  return c.json({ notifications: host, webapp: host });
});

discovery.get("/discovery/v1/webapp", (c) => {
  return c.json({ Host: c.env.CLOUD_HOST, Status: "OK" });
});

// Legacy service locator (<3.x clients). blob-storage wants an https:// prefix.
discovery.get("/service/json/1/:service", (c) => {
  const service = c.req.param("service");
  const host = service === "blob-storage" ? `https://${c.env.CLOUD_HOST}` : c.env.CLOUD_HOST;
  return c.json({ Host: host, Status: "OK" });
});
