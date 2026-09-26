import { sign, verify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Ctx, SessionUser } from "./app";
import { fail } from "./app";
import { sha256Hex } from "./crypto";
import type { Role } from "../../shared/types";

const COOKIE = "it_session";

export async function issueSession(c: Ctx, user: SessionUser) {
  // 作業員端末は長期ログイン（現場で毎回ログインさせない）、管理者は12時間
  const ttl = user.role === "worker" ? 30 * 86400 : 12 * 3600;
  const token = await sign(
    { sub: user.id, org: user.orgId, role: user.role, name: user.name, exp: Math.floor(Date.now() / 1000) + ttl },
    c.env.JWT_SECRET,
    "HS256"
  );
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: ttl
  });
  return token;
}

export function clearSession(c: Ctx) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function readSession(c: Ctx): Promise<SessionUser | null> {
  const bearer = c.req.header("authorization");
  const token = getCookie(c, COOKIE) ?? (bearer?.startsWith("Bearer ey") ? bearer.slice(7) : undefined);
  if (!token) return null;
  try {
    const p = (await verify(token, c.env.JWT_SECRET, "HS256")) as { sub: string; org: string; role: Role; name: string };
    return { id: p.sub, orgId: p.org, role: p.role, name: p.name };
  } catch {
    return null;
  }
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const u = await readSession(c);
  if (!u) fail(401, "ログインが必要です", "unauthenticated");
  // 退職・無効化されたユーザーの長期セッションを遮断
  const row = await c.env.DB.prepare("SELECT active FROM users WHERE id = ?").bind(u.id).first<{ active: number }>();
  if (!row || !row.active) fail(401, "アカウントが無効です", "unauthenticated");
  c.set("user", u);
  await next();
});

export const requireRole = (...roles: Role[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!roles.includes(c.get("user").role)) fail(403, "権限がありません");
    await next();
  });

/** IoTデバイス認証: Authorization: Device <deviceId>.<token> */
export const requireDevice = createMiddleware<AppEnv>(async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const m = /^Device\s+([^.\s]+)\.(\S+)$/.exec(h);
  if (!m) fail(401, "デバイス認証が必要です");
  const [, deviceId, token] = m;
  const row = await c.env.DB.prepare(
    "SELECT id, org_id, site_id, kind, name, equipment_id, tag_id, token_hash FROM devices WHERE id = ?"
  )
    .bind(deviceId)
    .first<{ id: string; org_id: string; site_id: string; kind: "ble_receiver" | "nfc_reader"; name: string; equipment_id: string | null; tag_id: string | null; token_hash: string }>();
  if (!row || row.token_hash !== (await sha256Hex(token))) fail(401, "デバイス認証に失敗しました");
  c.set("device", {
    id: row.id,
    orgId: row.org_id,
    siteId: row.site_id,
    kind: row.kind,
    name: row.name,
    equipmentId: row.equipment_id,
    tagId: row.tag_id
  });
  c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), row.id).run());
  await next();
});
