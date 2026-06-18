import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

// One UserHub per user (addressed by uid). Holds the device notification
// WebSocket(s) using the Hibernation API (idle sockets cost ~nothing), and
// fans out "SyncComplete" to the user's OTHER devices on a sync change.
export class UserHub extends DurableObject<Env> {
  // Accept the WebSocket upgrade forwarded by the Worker. The deviceId is
  // passed as a query param so we can tag the socket and skip the originator.
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const deviceId = new URL(request.url).searchParams.get("deviceId") || "";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Tag with deviceId so notifySync can exclude the source device.
    this.ctx.acceptWebSocket(server, [deviceId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  // RPC: notify all of the user's other devices that they should re-sync.
  notifySync(sourceDeviceId: string): void {
    const msg = JSON.stringify({
      message: {
        attributes: {
          auth0UserID: "",
          event: "SyncComplete",
          sourceDeviceID: sourceDeviceId,
          sourceDeviceDesc: "",
        },
        messageId: `${Date.now()}`,
        publishTime: new Date().toISOString(),
      },
    });
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes(sourceDeviceId)) continue; // don't echo to the originator
      try {
        ws.send(msg);
      } catch {
        // socket going away; ignore
      }
    }
  }

  // Device -> server frames are not used for sync; ignore.
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code);
    } catch {
      // already closed
    }
  }
}
