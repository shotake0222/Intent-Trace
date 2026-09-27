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
import { recordError, runMonitor } from "./lib/monitor";

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

// トップページ: 未ログインの訪問者にはサービス紹介（LP）、ログイン中はアプリを表示
app.get("/", (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const path = /(?:^|;\s*)it_session=/.test(cookie) ? "/" : "/lp/";
  return c.env.ASSETS.fetch(new Request(new URL(path, c.req.url), c.req.raw));
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not Found" }, 404) : c.env.ASSETS.fetch(c.req.raw)));

// 画面側で起きた予期しないエラーの報告（ErrorBoundary / window.onerror から）
app.post("/api/client-errors", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rk = `rl:clienterr:${ip}`;
  const n = Number((await c.env.CACHE.get(rk)) ?? 0);
  if (n >= 30) return c.json({ ok: true, dropped: true });
  await c.env.CACHE.put(rk, String(n + 1), { expirationTtl: 3600 });
  let b: { message?: unknown; stack?: unknown; path?: unknown; componentStack?: unknown } = {};
  try {
    b = await c.req.json();
  } catch {
    /* noop */
  }
  const u = await readSession(c).catch(() => null);
  await recordError(c.env, {
    source: "client",
    path: typeof b.path === "string" ? b.path : null,
    message: typeof b.message === "string" ? b.message : "unknown",
    detail: [b.stack, b.componentStack].filter((x) => typeof x === "string").join("\n---\n") || null,
    orgId: u?.orgId ?? null,
    userId: u?.id ?? null,
    userAgent: c.req.header("user-agent") ?? null
  });
  return c.json({ ok: true });
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  // 想定外のエラーは記録し、cron で運営へまとめて通知する
  const u = (c.get as (k: string) => { id?: string; orgId?: string } | undefined)("user");
  const task = recordError(c.env, {
    source: "server",
    method: c.req.method,
    path: c.req.routePath && c.req.routePath !== "*" ? c.req.routePath : new URL(c.req.url).pathname,
    message: err instanceof Error ? err.message : String(err),
    detail: err instanceof Error ? (err.stack ?? null) : null,
    orgId: u?.orgId ?? null,
    userId: u?.id ?? null,
    userAgent: c.req.header("user-agent") ?? null
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    /* テスト環境など executionCtx が無い場合 */
  }
  return c.json({ error: "サーバーエラーが発生しました。時間をおいて再度お試しください（運営に自動で通知されています）", code: "server_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const fail = (path: string) => (e: unknown) =>
      recordError(env, { source: "server", path, message: e instanceof Error ? e.message : String(e), detail: e instanceof Error ? (e.stack ?? null) : null });
    // 再送・リマインダーと、エラー監視は互いに影響しないよう別々に実行
    ctx.waitUntil(
      runScheduled(env)
        .then((r) => console.log("scheduled", JSON.stringify(r)))
        .catch(fail("cron"))
        .then(() => runMonitor(env))
        .then((r) => console.log("monitor", JSON.stringify(r)))
        .catch(fail("cron.monitor"))
    );
  }
} satisfies ExportedHandler<Env>;
