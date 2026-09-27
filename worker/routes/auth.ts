import { z } from "zod";
import { createRouter, body, fail, newId, now, audit } from "../lib/app";
import { issueSession, clearSession, requireAuth } from "../lib/auth";
import { hashPassword, verifyPassword, timingSafeEqual, enc } from "../lib/crypto";
import { getContract, contractBlockReason } from "../lib/platform";
import { sendResetMail, consumeResetToken } from "../lib/mailers";

async function assertContract(env: Env, orgId: string) {
  const c = await getContract(env, orgId);
  const reason = contractBlockReason(c);
  if (reason) fail(403, reason, "contract_blocked");
}
import type { Me } from "../../shared/types";

const r = createRouter();

// 簡易レート制限（KV）: 同一キーで 10 回/15分 失敗したらロック
async function checkRate(env: Env, key: string) {
  const n = Number((await env.CACHE.get(`rl:${key}`)) ?? 0);
  if (n >= 10) fail(429, "試行回数が多すぎます。しばらく待ってから再度お試しください");
}
async function bumpRate(env: Env, key: string) {
  const n = Number((await env.CACHE.get(`rl:${key}`)) ?? 0);
  await env.CACHE.put(`rl:${key}`, String(n + 1), { expirationTtl: 900 });
}

r.post("/login", async (c) => {
  const b = await body(c, z.object({ email: z.string().email(), password: z.string().min(1) }));
  const email = b.email.toLowerCase();
  await checkRate(c.env, `login:${email}`);
  const u = await c.env.DB.prepare("SELECT id, org_id, role, name, password_hash, active, token_version FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; org_id: string; role: "admin" | "manager" | "worker"; name: string; password_hash: string; active: number; token_version: number }>();
  if (!u || !u.active || !(await verifyPassword(b.password, u.password_hash))) {
    await bumpRate(c.env, `login:${email}`);
    fail(401, "メールアドレスまたはパスワードが違います");
  }
  await assertContract(c.env, u.org_id);
  await issueSession(c, { id: u.id, orgId: u.org_id, role: u.role, name: u.name }, { tokenVersion: u.token_version });
  return c.json({ ok: true });
});

// 作業員ログイン: 会社コード + 社員番号 + PIN
r.post("/worker-login", async (c) => {
  const b = await body(c, z.object({ orgCode: z.string().min(1), employeeCode: z.string().min(1), pin: z.string().min(4).max(12) }));
  const rk = `wlogin:${b.orgCode}:${b.employeeCode}`;
  await checkRate(c.env, rk);
  const u = await c.env.DB.prepare(
    `SELECT u.id, u.org_id, u.role, u.name, u.password_hash, u.active, u.token_version FROM users u JOIN organizations o ON o.id = u.org_id
      WHERE o.code = ? AND u.employee_code = ?`
  )
    .bind(b.orgCode.toUpperCase(), b.employeeCode)
    .first<{ id: string; org_id: string; role: "admin" | "manager" | "worker"; name: string; password_hash: string; active: number; token_version: number }>();
  if (!u || !u.active || !(await verifyPassword(b.pin, u.password_hash))) {
    await bumpRate(c.env, rk);
    fail(401, "会社コード・社員番号・PINのいずれかが違います");
  }
  await assertContract(c.env, u.org_id);
  await issueSession(c, { id: u.id, orgId: u.org_id, role: u.role, name: u.name }, { tokenVersion: u.token_version });
  return c.json({ ok: true });
});

// 自分のパスワード/PIN変更（他端末のセッションも失効）
r.post("/change-password", requireAuth, async (c) => {
  const u = c.get("user");
  if (u.impersonatedBy) fail(403, "代理ログイン中はパスワードを変更できません");
  const b = await body(c, z.object({ current: z.string().min(1), next: z.string().min(4).max(128) }));
  const row = await c.env.DB.prepare("SELECT role, password_hash, token_version FROM users WHERE id = ?").bind(u.id).first<{ role: string; password_hash: string; token_version: number }>();
  if (!row || !(await verifyPassword(b.current, row.password_hash))) fail(401, "現在のパスワードが違います");
  if (row.role !== "worker" && b.next.length < 8) fail(422, "パスワードは8文字以上にしてください");
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(b.next), u.id).run();
  await issueSession(c, u, { tokenVersion: row.token_version + 1 });
  await audit(c.env, u.orgId, u.id, "user.change_password", "user", u.id);
  return c.json({ ok: true });
});

// パスワードを忘れた場合（管理者・マネージャー。作業員のPINは管理者が再設定）
r.post("/forgot", async (c) => {
  const b = await body(c, z.object({ email: z.string().email() }));
  const email = b.email.toLowerCase();
  const rk = `forgot:${email}`;
  const n = Number((await c.env.CACHE.get(`rl:${rk}`)) ?? 0);
  if (n < 5) {
    await c.env.CACHE.put(`rl:${rk}`, String(n + 1), { expirationTtl: 3600 });
    const u = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE email = ? AND active = 1 AND role IN ('admin','manager')").bind(email).first<{ id: string; name: string; email: string }>();
    if (u) await sendResetMail(c.env, c.req.url, "user", u.id, u.email, u.name);
  }
  // アカウントの有無は応答から分からないようにする
  return c.json({ ok: true });
});

r.post("/reset", async (c) => {
  const b = await body(c, z.object({ token: z.string().min(20), password: z.string().min(8).max(128) }));
  const userId = await consumeResetToken(c.env, "user", b.token);
  const u = await c.env.DB.prepare("SELECT org_id FROM users WHERE id = ?").bind(userId).first<{ org_id: string }>();
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(b.password), userId).run();
  if (u) await audit(c.env, u.org_id, userId, "user.password_reset_self", "user", userId);
  return c.json({ ok: true });
});

r.post("/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

r.get("/me", requireAuth, async (c) => {
  const u = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.employee_code, o.id AS org_id, o.name AS org_name, o.plan
       FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?`
  )
    .bind(u.id)
    .first<{ id: string; name: string; role: Me["role"]; employee_code: string; org_id: string; org_name: string; plan: string }>();
  if (!row) fail(401, "ユーザーが見つかりません");
  const { results: quals } = await c.env.DB.prepare(
    `SELECT q.code, q.name, uq.expires_at FROM user_qualifications uq JOIN qualifications q ON q.id = uq.qualification_id WHERE uq.user_id = ?`
  )
    .bind(u.id)
    .all<{ code: string; name: string; expires_at: number | null }>();
  const contract = await getContract(c.env, u.orgId);
  const me: Me = {
    id: row.id,
    name: row.name,
    role: row.role,
    orgId: row.org_id,
    orgName: row.org_name,
    plan: row.plan,
    employeeCode: row.employee_code,
    qualifications: quals.map((q) => ({ code: q.code, name: q.name, expiresAt: q.expires_at })),
    features: contract.plan.features,
    planName: contract.plan.name,
    orgStatus: contract.status,
    trialEndsAt: contract.trialEndsAt,
    impersonatedBy: u.impersonatedBy ?? null
  };
  return c.json(me);
});

/**
 * テナント（組織）と最初の管理者を作成する。SaaS 運営者のみが SETUP_TOKEN を持つ。
 */
r.post("/setup", async (c) => {
  const b = await body(
    c,
    z.object({
      token: z.string(),
      orgName: z.string().min(1),
      orgCode: z.string().regex(/^[A-Za-z0-9-]{2,20}$/),
      siteName: z.string().min(1).default("本社"),
      plan: z.enum(["standard", "pro"]).default("standard"),
      adminName: z.string().min(1),
      email: z.string().email(),
      password: z.string().min(8)
    })
  );
  const expected = enc.encode(c.env.SETUP_TOKEN ?? "");
  if (!c.env.SETUP_TOKEN || !timingSafeEqual(enc.encode(b.token), expected)) fail(403, "セットアップトークンが違います");
  const orgId = newId();
  const adminId = newId();
  const t = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO organizations (id, code, name, plan, created_at) VALUES (?,?,?,?,?)").bind(orgId, b.orgCode.toUpperCase(), b.orgName, b.plan, t),
      c.env.DB.prepare("INSERT INTO sites (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(newId(), orgId, b.siteName, t),
      c.env.DB.prepare(
        "INSERT INTO users (id, org_id, role, name, email, employee_code, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(adminId, orgId, "admin", b.adminName, b.email.toLowerCase(), "admin", await hashPassword(b.password), t)
    ]);
  } catch (e) {
    fail(409, "会社コードまたはメールアドレスが既に使われています");
  }
  await audit(c.env, orgId, adminId, "org.setup", "organization", orgId);
  return c.json({ ok: true, orgId, orgCode: b.orgCode.toUpperCase() });
});

export default r;
