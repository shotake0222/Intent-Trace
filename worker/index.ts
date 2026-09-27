import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./lib/app";
import { fail } from "./lib/app";
import { readSession } from "./lib/auth";
import auth from "./routes/auth";
import field from "./routes/field";
import files from "./routes/files";
import device from "./routes/device";
import admin from "./routes/admin";
import analytics from "./routes/analytics";
import reports from "./routes/reports";
import ops from "./routes/ops";
import account from "./routes/account";
import line from "./routes/line";
import { runScheduled } from "./cron";

export { EquipmentLock } from "./do/EquipmentLock";
export { DeadmanTimer } from "./do/DeadmanTimer";
export { SiteHub } from "./do/SiteHub";

const app = new Hono<AppEnv>();

app.use("/api/*", secureHeaders());

// CSRF 対策: 状態変更リクエストは同一オリジンのみ（デバイスAPIは除外）
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.path.startsWith("/api/device/")) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) fail(403, "不正なオリジンです");
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME, time: Date.now() }));
app.route("/api/auth", auth);
app.route("/api/files", files);
app.route("/api/device", device);
app.route("/api/admin", admin);
app.route("/api/analytics", analytics);
app.route("/api/reports", reports);
app.route("/api/ops", ops);
app.route("/api/account", account);
app.route("/api/line", line);
app.route("/api", field);

// ダッシュボードのリアルタイム購読
app.get("/ws/sites/:siteId", async (c) => {
  const u = await readSession(c);
  if (!u || u.role === "worker") return c.text("unauthorized", 401);
  const site = await c.env.DB.prepare("SELECT id FROM sites WHERE id = ? AND org_id = ?").bind(c.req.param("siteId"), u.orgId).first();
  if (!site) return c.text("not found", 404);
  const stub = c.env.SITE_HUB.get(c.env.SITE_HUB.idFromName(c.req.param("siteId")));
  return stub.fetch(c.req.raw);
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not Found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "サーバーエラーが発生しました" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env).then((r) => console.log("scheduled", JSON.stringify(r))));
  }
} satisfies ExportedHandler<Env>;
