import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { LiveEvent, Role, Severity } from "../../shared/types";
import { notifyAlert } from "./notify";

export interface SessionUser {
  id: string;
  orgId: string;
  role: Role;
  name: string;
  /** 運営による代理ログイン中なら運営アカウントID */
  impersonatedBy?: string | null;
}

export interface OpsUser {
  id: string;
  name: string;
  email: string;
  role: "owner" | "staff";
}

export interface DeviceCtx {
  id: string;
  orgId: string;
  siteId: string;
  kind: "ble_receiver" | "nfc_reader";
  name: string;
  equipmentId: string | null;
  tagId: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; device: DeviceCtx; ops: OpsUser };
};

export type Ctx = Context<AppEnv>;

export const createRouter = () => new Hono<AppEnv>();

export const newId = () => crypto.randomUUID();
export const now = () => Date.now();

export function fail(status: 400 | 401 | 403 | 404 | 409 | 422 | 423 | 429 | 500, message: string, code?: string): never {
  throw new HTTPException(status, { message, res: Response.json({ error: message, code: code ?? null }, { status }) });
}

/** JSON ボディを zod スキーマで検証して返す */
export async function body<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, "JSONの形式が不正です");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join(", ");
    fail(422, `入力が不正です: ${msg}`, "validation");
  }
  return r.data;
}

export async function audit(env: Env, orgId: string, actorId: string | null, action: string, targetType: string | null, targetId: string | null, detail?: unknown) {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, org_id, actor_id, action, target_type, target_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(newId(), orgId, actorId, action, targetType, targetId, detail === undefined ? null : JSON.stringify(detail), now())
    .run();
}

export async function raiseAlert(
  env: Env,
  a: { orgId: string; siteId: string; type: string; severity: Severity; userId?: string | null; refId?: string | null; message: string }
) {
  const id = newId();
  const at = now();
  await env.DB.prepare(
    "INSERT INTO alerts (id, org_id, site_id, type, severity, user_id, ref_id, message, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(id, a.orgId, a.siteId, a.type, a.severity, a.userId ?? null, a.refId ?? null, a.message, at)
    .run();
  await broadcast(env, { type: "alert", siteId: a.siteId, at, data: { id, type: a.type, severity: a.severity, message: a.message, userId: a.userId ?? null } });
  // メール・LINE 通知（失敗しても本処理は止めない。失敗分は cron で再送）
  try {
    await notifyAlert(env, { orgId: a.orgId, siteId: a.siteId, severity: a.severity, type: a.type, message: a.message, alertId: id });
  } catch (e) {
    console.error("notifyAlert failed", e);
  }
  return id;
}

/** 現場ダッシュボードへリアルタイム配信（失敗しても本処理は止めない） */
export async function broadcast(env: Env, ev: LiveEvent) {
  try {
    const stub = env.SITE_HUB.get(env.SITE_HUB.idFromName(ev.siteId));
    await stub.broadcast(ev);
  } catch (e) {
    console.error("broadcast failed", e);
  }
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** ユーザーが対象サイトの組織に属することを確認 */
export async function assertSiteInOrg(env: Env, siteId: string, orgId: string) {
  const s = await env.DB.prepare("SELECT id FROM sites WHERE id = ? AND org_id = ?").bind(siteId, orgId).first();
  if (!s) fail(404, "現場が見つかりません");
}
