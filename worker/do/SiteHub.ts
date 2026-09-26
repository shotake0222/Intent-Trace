import { DurableObject } from "cloudflare:workers";
import type { LiveEvent } from "../../shared/types";

/**
 * 現場（サイト）ごとのリアルタイム配信ハブ。
 * WebSocket Hibernation API を使うため、接続中でも待機中は課金されない。
 */
export class SiteHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", at: Date.now() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(ev: LiveEvent): Promise<number> {
    const msg = JSON.stringify(ev);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        n++;
      } catch {
        /* 切断済み */
      }
    }
    return n;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {
      /* noop */
    }
  }
}
