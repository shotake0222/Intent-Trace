import { sign, verify } from "hono/jwt";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Ctx, SessionUser } from "./app";
import { fail } from "./app";
import { sha256Hex } from "./crypto";
import { contractBlockReason } from "./platform";
import type { Role } from "../../shared/types";

const COOKIE = "it_session";
const OPS_COOKIE = "it_ops";

const cookieOpts = (c: Ctx, maxAge: number) => ({
  httpOnly: true,
  secure: new URL(c.req.url).protocol === "https:",
  sameSite: "Lax" as const,
  path: "/",
  maxAge
});

/**
 * テナントユーザーのセッション発行。
 * imp: 運営による代理ログイン時の運営アカウントID（監査・画面表示用、有効期限1時間）
 */
export async function issueSession(c: Ctx, user: SessionUser, opts: { tokenVersion?: number; impersonatedBy?: { id: string; name: string } } = {}) {
  // 作業員端末は長期ログイン（現場で毎回ログインさせない）、管理者は12時間
  const ttl = opts.impersonatedBy ? 3600 : user.role === "worker" ? 30 * 86400 : 12 * 3600;
  const token = await sign(
    {
      sub: user.id,
      org: user.orgId,
      role: user.role,
      name: user.name,
      tv: opts.tokenVersion ?? 0,
      ...(opts.impersonatedBy ? { imp: opts.impersonatedBy.id, impName: opts.impersonatedBy.name } : {}),
      exp: Math.floor(Date.now() / 1000) + ttl
    },
    c.env.JWT_SECRET,
    "HS256"
  );
  setCookie(c, COOKIE, token, cookieOpts(c, ttl));
  return token;
}

export function clearSession(c: Ctx) {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function readSession(c: Ctx): Promise<(SessionUser & { tv: number; imp?: string; impName?: string }) | null> {
  const bearer = c.req.header("authorization");
  const token = getCookie(c, COOKIE) ?? (bearer?.startsWith("Bearer ey") ? bearer.slice(7) : undefined);
  if (!token) return null;
  try {
    const p = (await verify(token, c.env.JWT_SECRET, "HS256")) as { sub: string; org: string; role: Role; name: string; tv?: number; imp?: string; impName?: string };
    return { id: p.sub, orgId: p.org, role: p.role, name: p.name, tv: p.tv ?? 0, imp: p.imp, impName: p.impName };
  } catch {
    return null;
  }
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const u = await readSession(c);
  if (!u) fail(401, "ログインが必要です", "unauthenticated");
  // 退職・無効化・パスワード変更済みのセッション、契約停止中の組織を遮断
  const row = await c.env.DB.prepare(
    "SELECT u.active, u.token_version, o.status, o.trial_ends_at FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?"
  )
    .bind(u.id)
    .first<{ active: number; token_version: number; status: "trial" | "active" | "suspended" | "cancelled"; trial_ends_at: number | null }>();
  if (!row || !row.active || row.token_version !== u.tv) fail(401, "セッションが無効です。再度ログインしてください", "unauthenticated");
  const blocked = contractBlockReason({ status: row.status, trialEndsAt: row.trial_ends_at });
  if (blocked && !u.imp) fail(403, blocked, "contract_blocked");
  c.set("user", { id: u.id, orgId: u.orgId, role: u.role, name: u.name, impersonatedBy: u.imp ?? null });
  await next();
});

// ===== 運営（スーパーアドミン）セッション =====
export interface OpsAdmin {
  id: string;
  name: string;
  email: string;
  role: "owner" | "staff";
}

export async function issueOpsSession(c: Ctx, a: OpsAdmin, tokenVersion: number) {
  const ttl = 8 * 3600;
  const token = await sign(
    { sub: a.id, name: a.name, email: a.email, prole: a.role, tv: tokenVersion, aud: "ops", exp: Math.floor(Date.now() / 1000) + ttl },
    c.env.JWT_SECRET,
    "HS256"
  );
  setCookie(c, OPS_COOKIE, token, { ...cookieOpts(c, ttl), sameSite: "Strict" });
}

export function clearOpsSession(c: Ctx) {
  deleteCookie(c, OPS_COOKIE, { path: "/" });
}

export const requireOps = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, OPS_COOKIE);
  if (!token) fail(401, "運営ログインが必要です", "ops_unauthenticated");
  let p: { sub: string; name: string; email: string; prole: "owner" | "staff"; tv: number; aud: string };
  try {
    p = (await verify(token, c.env.JWT_SECRET, "HS256")) as typeof p;
  } catch {
    fail(401, "運営ログインが必要です", "ops_unauthenticated");
  }
  if (p.aud !== "ops") fail(401, "運営ログインが必要です", "ops_unauthenticated");
  const row = await c.env.DB.prepare(
    "SELECT a.active, a.token_version, a.role, a.totp_enabled, (SELECT value FROM platform_settings WHERE key = 'require_ops_2fa') AS require2fa FROM platform_admins a WHERE a.id = ?"
  )
    .bind(p.sub)
    .first<{ active: number; token_version: number; role: "owner" | "staff"; totp_enabled: number; require2fa: string | null }>();
  if (!row || !row.active || row.token_version !== p.tv) fail(401, "セッションが無効です", "ops_unauthenticated");
  // 二段階認証が必須なのに未設定 → 設定画面以外は操作させない
  if (row.require2fa === "1" && !row.totp_enabled) {
    const path = new URL(c.req.url).pathname;
    if (!/^\/api\/ops\/(me|2fa\/|logout|change-password)/.test(path)) fail(403, "二段階認証の設定が必要です", "mfa_setup_required");
  }
  c.set("ops", { id: p.sub, name: p.name, email: p.email, role: row.role });
  await next();
});

export const requireOpsOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("ops").role !== "owner") fail(403, "オーナー権限が必要です");
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
  const org = await c.env.DB.prepare("SELECT status, trial_ends_at FROM organizations WHERE id = ?").bind(row.org_id).first<{ status: "trial" | "active" | "suspended" | "cancelled"; trial_ends_at: number | null }>();
  const blocked = org ? contractBlockReason({ status: org.status, trialEndsAt: org.trial_ends_at }) : "組織が見つかりません";
  if (blocked) fail(403, blocked, "contract_blocked");
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
