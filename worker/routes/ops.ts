// 運営（スーパーアドミン）API  /api/ops/*
import { z } from "zod";
import { createRouter, body, fail, newId, now, audit, parseJson } from "../lib/app";
import { requireOps, requireOpsOwner, issueOpsSession, clearOpsSession, issueSession } from "../lib/auth";
import { sign, verify } from "hono/jwt";
import { hashPassword, verifyPassword, timingSafeEqual, enc, shortId, sealSecret, openSecret, bytesToHex, randomToken, sha256Hex } from "../lib/crypto";
import { newTotpSecret, verifyTotp, otpauthUri } from "../lib/totp";
import { qrSvg, tagQrUrl } from "../lib/qr";
import { notify, retryOutbox, getNotifyConfig, emailTemplate, rememberBaseUrl, putSecretSetting, SECRET_SETTINGS } from "../lib/notify";
import { sendResetMail, consumeResetToken, sendWelcomeMail, sendInvoiceMail } from "../lib/mailers";
import { getContract, usage, computeInvoice, platformAudit, getSettings, monthKey } from "../lib/platform";
import { renderInvoice } from "../lib/invoice";

const r = createRouter();
const DAY = 86400_000;
const tempPassword = () => randomToken(12).replace(/[-_]/g, "").slice(0, 14);

// ---------- 初期化・認証（未ログインで呼べるもの） ----------
r.get("/status", async (c) => {
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM platform_admins").first<{ n: number }>();
  return c.json({ initialized: (n?.n ?? 0) > 0 });
});

// 最初の運営オーナーを作成（SETUP_TOKEN が必要・一度だけ）
r.post("/bootstrap", async (c) => {
  const b = await body(c, z.object({ setupToken: z.string(), name: z.string().min(1), email: z.string().email(), password: z.string().min(10) }));
  if (!c.env.SETUP_TOKEN || !timingSafeEqual(enc.encode(b.setupToken), enc.encode(c.env.SETUP_TOKEN))) fail(403, "セットアップトークンが違います");
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM platform_admins").first<{ n: number }>();
  if ((n?.n ?? 0) > 0) fail(409, "既に初期化されています");
  const id = newId();
  await c.env.DB.prepare("INSERT INTO platform_admins (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, b.email.toLowerCase(), b.name, "owner", await hashPassword(b.password), now())
    .run();
  await platformAudit(c.env, id, "ops.bootstrap", "platform_admin", id);
  await issueOpsSession(c, { id, name: b.name, email: b.email.toLowerCase(), role: "owner" }, 0);
  return c.json({ ok: true });
});

r.post("/login", async (c) => {
  const b = await body(c, z.object({ email: z.string().email(), password: z.string().min(1) }));
  const key = `rl:ops:${b.email.toLowerCase()}`;
  const tries = Number((await c.env.CACHE.get(key)) ?? 0);
  if (tries >= 8) fail(429, "試行回数が多すぎます。しばらく待ってから再度お試しください");
  const a = await c.env.DB.prepare("SELECT id, name, email, role, password_hash, active, token_version FROM platform_admins WHERE email = ?")
    .bind(b.email.toLowerCase())
    .first<{ id: string; name: string; email: string; role: "owner" | "staff"; password_hash: string; active: number; token_version: number }>();
  if (!a || !a.active || !(await verifyPassword(b.password, a.password_hash))) {
    await c.env.CACHE.put(key, String(tries + 1), { expirationTtl: 900 });
    fail(401, "メールアドレスまたはパスワードが違います");
  }
  await c.env.CACHE.delete(key);
  await rememberBaseUrl(c.env, c.req.url);
  const mfa = await c.env.DB.prepare("SELECT totp_enabled FROM platform_admins WHERE id = ?").bind(a.id).first<{ totp_enabled: number }>();
  if (mfa?.totp_enabled) {
    // パスワードは正しい → 5分間有効の中間トークンで二段階目へ
    const mfaToken = await sign({ sub: a.id, aud: "ops-mfa", tv: a.token_version, exp: Math.floor(Date.now() / 1000) + 300 }, c.env.JWT_SECRET, "HS256");
    return c.json({ mfaRequired: true, mfaToken });
  }
  await c.env.DB.prepare("UPDATE platform_admins SET last_login_at = ? WHERE id = ?").bind(now(), a.id).run();
  await platformAudit(c.env, a.id, "ops.login", null, null, { mfa: false });
  await issueOpsSession(c, a, a.token_version);
  return c.json({ ok: true });
});

/** 二段階目: 認証アプリの6桁コード または リカバリーコード */
r.post("/login/mfa", async (c) => {
  const b = await body(c, z.object({ mfaToken: z.string(), code: z.string().optional(), recoveryCode: z.string().optional() }));
  let p: { sub: string; aud: string; tv: number };
  try {
    p = (await verify(b.mfaToken, c.env.JWT_SECRET, "HS256")) as typeof p;
  } catch {
    fail(401, "有効期限が切れました。もう一度ログインしてください", "mfa_expired");
  }
  if (p.aud !== "ops-mfa") fail(401, "不正なトークンです");
  const key = `rl:opsmfa:${p.sub}`;
  const tries = Number((await c.env.CACHE.get(key)) ?? 0);
  if (tries >= 6) fail(429, "試行回数が多すぎます。15分ほど待ってから再度お試しください");
  const a = await c.env.DB.prepare("SELECT id, name, email, role, active, token_version, totp_secret, totp_last_step, recovery_codes_json FROM platform_admins WHERE id = ?")
    .bind(p.sub)
    .first<{ id: string; name: string; email: string; role: "owner" | "staff"; active: number; token_version: number; totp_secret: string | null; totp_last_step: number; recovery_codes_json: string | null }>();
  if (!a || !a.active || a.token_version !== p.tv || !a.totp_secret) fail(401, "もう一度ログインしてください");
  let method = "totp";
  if (b.code) {
    const step = await verifyTotp(await openSecret(a.totp_secret, c.env.TAG_KEY_SECRET), b.code, a.totp_last_step);
    if (step === null) {
      await c.env.CACHE.put(key, String(tries + 1), { expirationTtl: 900 });
      fail(401, "確認コードが違います（端末の時刻がずれていないか確認してください）", "mfa_invalid");
    }
    await c.env.DB.prepare("UPDATE platform_admins SET totp_last_step = ? WHERE id = ?").bind(step, a.id).run();
  } else if (b.recoveryCode) {
    const h = await sha256Hex(b.recoveryCode.replace(/[\s-]/g, "").toUpperCase());
    const codes = parseJson<string[]>(a.recovery_codes_json, []);
    if (!codes.includes(h)) {
      await c.env.CACHE.put(key, String(tries + 1), { expirationTtl: 900 });
      fail(401, "リカバリーコードが違います", "mfa_invalid");
    }
    await c.env.DB.prepare("UPDATE platform_admins SET recovery_codes_json = ? WHERE id = ?").bind(JSON.stringify(codes.filter((x) => x !== h)), a.id).run();
    method = "recovery";
  } else fail(422, "確認コードを入力してください");
  await c.env.CACHE.delete(key);
  await c.env.DB.prepare("UPDATE platform_admins SET last_login_at = ? WHERE id = ?").bind(now(), a.id).run();
  await platformAudit(c.env, a.id, "ops.login", null, null, { mfa: method });
  await issueOpsSession(c, a, a.token_version);
  return c.json({ ok: true });
});

// パスワードを忘れた場合（メール送信サービス設定時のみ。二段階認証は引き続き必要）
r.post("/forgot", async (c) => {
  const b = await body(c, z.object({ email: z.string().email() }));
  const a = await c.env.DB.prepare("SELECT id, name, email FROM platform_admins WHERE email = ? AND active = 1").bind(b.email.toLowerCase()).first<{ id: string; name: string; email: string }>();
  if (a) await sendResetMail(c.env, c.req.url, "ops", a.id, a.email, a.name);
  // アカウントの有無は応答から分からないようにする
  return c.json({ ok: true });
});

r.post("/reset", async (c) => {
  const b = await body(c, z.object({ token: z.string().min(20), password: z.string().min(10) }));
  const accountId = await consumeResetToken(c.env, "ops", b.token);
  await c.env.DB.prepare("UPDATE platform_admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(b.password), accountId).run();
  await platformAudit(c.env, accountId, "ops.password_reset", "platform_admin", accountId);
  return c.json({ ok: true });
});

r.post("/logout", (c) => {
  clearOpsSession(c);
  return c.json({ ok: true });
});

// ---------- 以降は運営ログイン必須 ----------
r.use("*", requireOps);

r.get("/me", async (c) => {
  const o = c.get("ops");
  const a = await c.env.DB.prepare("SELECT totp_enabled, recovery_codes_json FROM platform_admins WHERE id = ?").bind(o.id).first<{ totp_enabled: number; recovery_codes_json: string | null }>();
  const settings = await getSettings(c.env);
  return c.json({
    ...o,
    totpEnabled: !!a?.totp_enabled,
    recoveryCodesLeft: parseJson<string[]>(a?.recovery_codes_json, []).length,
    mfaSetupRequired: settings.require_ops_2fa === "1" && !a?.totp_enabled
  });
});

// ---------- 二段階認証（TOTP） ----------
r.post("/2fa/setup", async (c) => {
  const o = c.get("ops");
  const secret = newTotpSecret();
  await c.env.DB.prepare("UPDATE platform_admins SET totp_pending = ? WHERE id = ?").bind(await sealSecret(secret, c.env.TAG_KEY_SECRET), o.id).run();
  const uri = otpauthUri(secret, o.email);
  return c.json({ secret, uri, qrSvg: qrSvg(uri, { size: 200, ecc: "M" }) });
});

function newRecoveryCodes() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 10 }, () => {
    const r = crypto.getRandomValues(new Uint8Array(8));
    const s = Array.from(r, (b) => alphabet[b % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

r.post("/2fa/enable", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ code: z.string() }));
  const a = await c.env.DB.prepare("SELECT totp_pending FROM platform_admins WHERE id = ?").bind(o.id).first<{ totp_pending: string | null }>();
  if (!a?.totp_pending) fail(400, "先にQRコードを表示してください");
  const secret = await openSecret(a.totp_pending, c.env.TAG_KEY_SECRET);
  const step = await verifyTotp(secret, b.code, 0);
  if (step === null) fail(401, "確認コードが違います。認証アプリに表示されている6桁を入力してください", "mfa_invalid");
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map((x) => sha256Hex(x.replace("-", ""))));
  await c.env.DB.prepare(
    "UPDATE platform_admins SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, recovery_codes_json = ? WHERE id = ?"
  )
    .bind(step, JSON.stringify(hashes), o.id)
    .run();
  await platformAudit(c.env, o.id, "ops.2fa_enable", "platform_admin", o.id);
  return c.json({ recoveryCodes: codes });
});

async function requireCurrentTotp(env: Env, adminId: string, code: string) {
  const a = await env.DB.prepare("SELECT totp_secret, totp_last_step FROM platform_admins WHERE id = ?").bind(adminId).first<{ totp_secret: string | null; totp_last_step: number }>();
  if (!a?.totp_secret) fail(400, "二段階認証が有効ではありません");
  const step = await verifyTotp(await openSecret(a.totp_secret, env.TAG_KEY_SECRET), code, a.totp_last_step);
  if (step === null) fail(401, "確認コードが違います", "mfa_invalid");
  await env.DB.prepare("UPDATE platform_admins SET totp_last_step = ? WHERE id = ?").bind(step, adminId).run();
}

r.post("/2fa/recovery-codes", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ code: z.string() }));
  await requireCurrentTotp(c.env, o.id, b.code);
  const codes = newRecoveryCodes();
  await c.env.DB.prepare("UPDATE platform_admins SET recovery_codes_json = ? WHERE id = ?")
    .bind(JSON.stringify(await Promise.all(codes.map((x) => sha256Hex(x.replace("-", ""))))), o.id)
    .run();
  await platformAudit(c.env, o.id, "ops.2fa_recovery_regenerate", "platform_admin", o.id);
  return c.json({ recoveryCodes: codes });
});

r.post("/2fa/disable", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ code: z.string() }));
  const settings = await getSettings(c.env);
  if (settings.require_ops_2fa === "1") fail(403, "二段階認証が必須に設定されているため無効化できません");
  await requireCurrentTotp(c.env, o.id, b.code);
  await c.env.DB.prepare("UPDATE platform_admins SET totp_secret = NULL, totp_enabled = 0, recovery_codes_json = NULL WHERE id = ?").bind(o.id).run();
  await platformAudit(c.env, o.id, "ops.2fa_disable", "platform_admin", o.id);
  return c.json({ ok: true });
});


r.post("/change-password", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ current: z.string(), next: z.string().min(10) }));
  const a = await c.env.DB.prepare("SELECT password_hash, token_version FROM platform_admins WHERE id = ?").bind(o.id).first<{ password_hash: string; token_version: number }>();
  if (!a || !(await verifyPassword(b.current, a.password_hash))) fail(401, "現在のパスワードが違います");
  await c.env.DB.prepare("UPDATE platform_admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(b.next), o.id).run();
  await issueOpsSession(c, o, a.token_version + 1);
  await platformAudit(c.env, o.id, "ops.change_password", "platform_admin", o.id);
  return c.json({ ok: true });
});

// ---------- ダッシュボード ----------
r.get("/dashboard", async (c) => {
  const since = now() - 30 * DAY;
  const [orgs, totals, stock, tickets, daily, trialsEnding] = await Promise.all([
    c.env.DB.prepare("SELECT id, status, plan FROM organizations").all<{ id: string; status: string; plan: string }>(),
    c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE active = 1) users,
              (SELECT COUNT(*) FROM tags WHERE active = 1) tags,
              (SELECT COUNT(*) FROM devices) devices,
              (SELECT COUNT(*) FROM tap_events WHERE occurred_at >= ?1) taps30,
              (SELECT COUNT(*) FROM incidents WHERE occurred_at >= ?1) incidents30,
              (SELECT COUNT(DISTINCT org_id) FROM tap_events WHERE occurred_at >= ?1) active_orgs`
    )
      .bind(since)
      .first<Record<string, number>>(),
    c.env.DB.prepare("SELECT status, item_type, COUNT(*) n FROM tag_stock GROUP BY status, item_type").all<{ status: string; item_type: string; n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) n FROM support_tickets WHERE status = 'open'").first<{ n: number }>(),
    c.env.DB.prepare(
      "SELECT strftime('%Y-%m-%d', occurred_at/1000, 'unixepoch', '+9 hours') d, COUNT(*) taps, COUNT(DISTINCT org_id) orgs FROM tap_events WHERE occurred_at >= ? GROUP BY d ORDER BY d"
    )
      .bind(since)
      .all<{ d: string; taps: number; orgs: number }>(),
    c.env.DB.prepare("SELECT id, name, trial_ends_at FROM organizations WHERE status = 'trial' AND trial_ends_at IS NOT NULL ORDER BY trial_ends_at LIMIT 10").all()
  ]);
  // MRR（税抜・現在の利用量で試算）
  let mrr = 0;
  for (const o of orgs.results.filter((o) => o.status === "active")) mrr += (await computeInvoice(c.env, o.id)).subtotal;
  const byStatus: Record<string, number> = {};
  const byPlan: Record<string, number> = {};
  for (const o of orgs.results) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    byPlan[o.plan] = (byPlan[o.plan] ?? 0) + 1;
  }
  return c.json({
    tenants: { total: orgs.results.length, byStatus, byPlan },
    totals,
    mrr,
    stock: stock.results,
    openTickets: tickets?.n ?? 0,
    daily: daily.results.map((d) => ({ date: d.d, taps: d.taps, orgs: d.orgs })),
    trialsEnding: trialsEnding.results
  });
});

// ---------- テナント ----------
r.get("/tenants", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.code, o.name, o.plan, o.status, o.trial_ends_at, o.contact_name, o.contact_email, o.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id AND u.active = 1) users,
            (SELECT COUNT(*) FROM tags t WHERE t.org_id = o.id AND t.active = 1) tags,
            (SELECT COUNT(*) FROM sites s WHERE s.org_id = o.id) sites,
            (SELECT COUNT(*) FROM tag_stock st WHERE st.org_id = o.id AND st.status = 'allocated') stock_unregistered,
            (SELECT MAX(occurred_at) FROM tap_events te WHERE te.org_id = o.id) last_tap_at,
            (SELECT COUNT(*) FROM tap_events te WHERE te.org_id = o.id AND te.occurred_at >= ?) taps30
       FROM organizations o ORDER BY o.created_at DESC`
  )
    .bind(now() - 30 * DAY)
    .all();
  return c.json(results);
});

const tenantSchema = z.object({
  name: z.string().min(1),
  code: z.string().regex(/^[A-Za-z0-9-]{2,20}$/, "会社コードは英数字とハイフン2〜20文字"),
  plan: z.string().min(1),
  status: z.enum(["trial", "active", "suspended", "cancelled"]).default("trial"),
  trialDays: z.number().int().min(1).max(180).default(30),
  contactName: z.string().nullish(),
  contactEmail: z.string().email().nullish().or(z.literal("")),
  contactPhone: z.string().nullish(),
  billingEmail: z.string().email().nullish().or(z.literal("")),
  address: z.string().nullish(),
  notes: z.string().nullish(),
  siteName: z.string().min(1).default("本社"),
  admin: z.object({ name: z.string().min(1), email: z.string().email(), password: z.string().min(8).optional() })
});

r.post("/tenants", async (c) => {
  const o = c.get("ops");
  const b = await body(c, tenantSchema);
  const plan = await c.env.DB.prepare("SELECT code FROM plans WHERE code = ?").bind(b.plan).first();
  if (!plan) fail(422, "プランが存在しません");
  const orgId = newId();
  const adminId = newId();
  const t = now();
  const password = b.admin.password ?? tempPassword();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO organizations (id, code, name, plan, status, trial_ends_at, contract_started_at, contact_name, contact_email, contact_phone, billing_email, address, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        orgId,
        b.code.toUpperCase(),
        b.name,
        b.plan,
        b.status,
        b.status === "trial" ? t + b.trialDays * DAY : null,
        b.status === "active" ? t : null,
        b.contactName || null,
        b.contactEmail || null,
        b.contactPhone || null,
        b.billingEmail || null,
        b.address || null,
        b.notes || null,
        t
      ),
      c.env.DB.prepare("INSERT INTO sites (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(newId(), orgId, b.siteName, t),
      c.env.DB.prepare("INSERT INTO users (id, org_id, role, name, email, employee_code, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)").bind(
        adminId,
        orgId,
        "admin",
        b.admin.name,
        b.admin.email.toLowerCase(),
        "admin",
        await hashPassword(password),
        t
      )
    ]);
  } catch {
    fail(409, "会社コードまたは管理者メールアドレスが既に使われています");
  }
  await platformAudit(c.env, o.id, "tenant.create", "organization", orgId, { code: b.code, plan: b.plan, status: b.status });
  const mail = await sendWelcomeMail(c.env, c.req.url, {
    orgId,
    to: b.admin.email.toLowerCase(),
    name: b.admin.name,
    orgName: b.name,
    orgCode: b.code.toUpperCase(),
    password: b.admin.password ? null : password,
    trialEndsAt: b.status === "trial" ? t + b.trialDays * DAY : null
  });
  await audit(c.env, orgId, null, "org.created_by_platform", "organization", orgId, { by: o.name });
  return c.json({ id: orgId, orgCode: b.code.toUpperCase(), adminEmail: b.admin.email.toLowerCase(), initialPassword: b.admin.password ? null : password, mailStatus: mail });
});

r.get("/tenants/:id", async (c) => {
  const id = c.req.param("id");
  const org = await c.env.DB.prepare("SELECT * FROM organizations WHERE id = ?").bind(id).first();
  if (!org) fail(404, "テナントが見つかりません");
  const [contract, use, sites, admins, invoices, tickets, stock, activity] = await Promise.all([
    getContract(c.env, id),
    usage(c.env, id),
    c.env.DB.prepare("SELECT id, name, address FROM sites WHERE org_id = ?").bind(id).all(),
    c.env.DB.prepare("SELECT id, name, email, role, active, created_at FROM users WHERE org_id = ? AND role IN ('admin','manager') ORDER BY role, created_at").bind(id).all(),
    c.env.DB.prepare("SELECT id, number, period, total, status, issued_at, paid_at FROM invoices WHERE org_id = ? ORDER BY period DESC LIMIT 24").bind(id).all(),
    c.env.DB.prepare("SELECT id, subject, status, updated_at FROM support_tickets WHERE org_id = ? ORDER BY updated_at DESC LIMIT 10").bind(id).all(),
    c.env.DB.prepare("SELECT item_type, status, COUNT(*) n FROM tag_stock WHERE org_id = ? GROUP BY item_type, status").bind(id).all(),
    c.env.DB.prepare(
      "SELECT strftime('%Y-%m-%d', occurred_at/1000, 'unixepoch', '+9 hours') d, COUNT(*) taps FROM tap_events WHERE org_id = ? AND occurred_at >= ? GROUP BY d ORDER BY d"
    )
      .bind(id, now() - 30 * DAY)
      .all()
  ]);
  const estimate = await computeInvoice(c.env, id);
  return c.json({
    org,
    contract,
    usage: use,
    estimate,
    sites: sites.results,
    admins: admins.results,
    invoices: invoices.results,
    tickets: tickets.results,
    stock: stock.results,
    daily: activity.results.map((d) => ({ date: (d as { d: string }).d, taps: (d as { taps: number }).taps }))
  });
});

r.patch("/tenants/:id", async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z.object({
      name: z.string().min(1).optional(),
      plan: z.string().optional(),
      status: z.enum(["trial", "active", "suspended", "cancelled"]).optional(),
      trialEndsAt: z.number().int().nullish(),
      contactName: z.string().nullish(),
      contactEmail: z.string().nullish(),
      contactPhone: z.string().nullish(),
      billingEmail: z.string().nullish(),
      address: z.string().nullish(),
      notes: z.string().nullish(),
      maxTagsOverride: z.number().int().min(0).nullish(),
      maxUsersOverride: z.number().int().min(0).nullish()
    })
  );
  if (b.plan && !(await c.env.DB.prepare("SELECT code FROM plans WHERE code = ?").bind(b.plan).first())) fail(422, "プランが存在しません");
  const map: Record<string, string> = {
    name: "name",
    plan: "plan",
    status: "status",
    trialEndsAt: "trial_ends_at",
    contactName: "contact_name",
    contactEmail: "contact_email",
    contactPhone: "contact_phone",
    billingEmail: "billing_email",
    address: "address",
    notes: "notes",
    maxTagsOverride: "max_tags_override",
    maxUsersOverride: "max_users_override"
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(v === "" ? null : v);
  }
  if (b.status === "active") sets.push("contract_started_at = COALESCE(contract_started_at, ?)"), vals.push(now());
  if (!sets.length) return c.json({ ok: true });
  const res = await c.env.DB.prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, c.req.param("id")).run();
  if (!res.meta.changes) fail(404, "テナントが見つかりません");
  await platformAudit(c.env, o.id, "tenant.update", "organization", c.req.param("id"), b);
  return c.json({ ok: true });
});

r.post("/tenants/:id/users/:userId/reset-password", async (c) => {
  const o = c.get("ops");
  const u = await c.env.DB.prepare("SELECT id, role FROM users WHERE id = ? AND org_id = ?").bind(c.req.param("userId"), c.req.param("id")).first<{ id: string; role: string }>();
  if (!u) fail(404, "ユーザーが見つかりません");
  const pw = u.role === "worker" ? String(Math.floor(100000 + Math.random() * 900000)) : tempPassword();
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(pw), u.id).run();
  await platformAudit(c.env, o.id, "tenant.reset_password", "user", u.id, { orgId: c.req.param("id") });
  await audit(c.env, c.req.param("id"), null, "user.password_reset_by_platform", "user", u.id, { by: o.name });
  const full = await c.env.DB.prepare("SELECT u.name, u.email, u.employee_code, o.name AS org_name, o.code FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.id = ?")
    .bind(u.id)
    .first<{ name: string; email: string | null; employee_code: string; org_name: string; code: string }>();
  let mailStatus: string | null = null;
  if (full?.email) {
    const cfg = await getNotifyConfig(c.env);
    const base = cfg.baseUrl || new URL(c.req.url).origin;
    const tpl = emailTemplate(
      cfg,
      "パスワードを再発行しました",
      [`${full.name} 様`, "", `${full.org_name} の Intent-Trace アカウントのパスワードを運営にて再発行しました。`, "", `仮パスワード: ${pw}`, "", "ログイン後、「契約・サポート」→「パスワード」から変更してください。"],
      { label: "ログインする", url: `${base}/login${u.role === "worker" ? "" : "?next=/admin"}` }
    );
    const [r0] = await notify(c.env, [{ orgId: c.req.param("id"), channel: "email", to: full.email, toLabel: full.name, eventType: "password_reset", refId: u.id, subject: "【Intent-Trace】パスワード再発行のお知らせ", body: tpl.text, html: tpl.html }], cfg);
    mailStatus = r0.status;
  }
  return c.json({ temporaryPassword: pw, mailStatus });
});

/** 代理ログイン（サポート用）: テナント管理者として1時間だけ操作。テナント側の監査ログにも記録 */
r.post("/tenants/:id/impersonate", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ userId: z.string().optional(), reason: z.string().min(2).max(200) }));
  const u = await c.env.DB.prepare(
    `SELECT id, org_id, role, name, token_version FROM users WHERE org_id = ? AND active = 1 AND (id = ? OR (? IS NULL AND role = 'admin')) ORDER BY created_at LIMIT 1`
  )
    .bind(c.req.param("id"), b.userId ?? null, b.userId ?? null)
    .first<{ id: string; org_id: string; role: "admin" | "manager" | "worker"; name: string; token_version: number }>();
  if (!u) fail(404, "代理ログインできるユーザーがいません");
  await issueSession(c, { id: u.id, orgId: u.org_id, role: u.role, name: u.name }, { tokenVersion: u.token_version, impersonatedBy: { id: o.id, name: o.name } });
  await platformAudit(c.env, o.id, "tenant.impersonate", "user", u.id, { orgId: u.org_id, reason: b.reason });
  await audit(c.env, u.org_id, null, "support.impersonation", "user", u.id, { by: o.name, reason: b.reason });
  return c.json({ ok: true, redirect: u.role === "worker" ? "/" : "/admin" });
});

// ---------- プラン ----------
r.get("/plans", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT p.*, (SELECT COUNT(*) FROM organizations o WHERE o.plan = p.code) AS tenants FROM plans p ORDER BY sort"
  ).all<Record<string, unknown> & { features_json: string }>();
  return c.json(results.map((p) => ({ ...p, features: parseJson(p.features_json, []) })));
});

r.put("/plans/:code", requireOpsOwner, async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z.object({
      name: z.string().min(1),
      monthlyFee: z.number().int().min(0),
      feePerTag: z.number().int().min(0),
      feePerUser: z.number().int().min(0),
      includedTags: z.number().int().min(0),
      includedUsers: z.number().int().min(0),
      maxTags: z.number().int().min(0).nullable(),
      maxUsers: z.number().int().min(0).nullable(),
      maxSites: z.number().int().min(0).nullable(),
      features: z.array(z.enum(["reports", "devices", "analytics", "sun"])),
      active: z.boolean().default(true),
      sort: z.number().int().default(0)
    })
  );
  const code = c.req.param("code");
  if (!/^[a-z0-9_-]{2,20}$/.test(code)) fail(422, "プランコードが不正です");
  await c.env.DB.prepare(
    `INSERT INTO plans (code, name, monthly_fee, fee_per_tag, fee_per_user, included_tags, included_users, max_tags, max_users, max_sites, features_json, active, sort)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, monthly_fee=excluded.monthly_fee, fee_per_tag=excluded.fee_per_tag, fee_per_user=excluded.fee_per_user,
       included_tags=excluded.included_tags, included_users=excluded.included_users, max_tags=excluded.max_tags, max_users=excluded.max_users,
       max_sites=excluded.max_sites, features_json=excluded.features_json, active=excluded.active, sort=excluded.sort`
  )
    .bind(code, b.name, b.monthlyFee, b.feePerTag, b.feePerUser, b.includedTags, b.includedUsers, b.maxTags, b.maxUsers, b.maxSites, JSON.stringify(b.features), b.active ? 1 : 0, b.sort)
    .run();
  await platformAudit(c.env, o.id, "plan.upsert", "plan", code, b);
  return c.json({ ok: true });
});

// ---------- NFC ハードウェア在庫 ----------
r.get("/stock/summary", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.batch, s.item_type, s.chip, s.status, COUNT(*) n, SUM(s.uid IS NOT NULL) with_uid, MIN(s.created_at) created_at
       FROM tag_stock s GROUP BY s.batch, s.item_type, s.chip, s.status ORDER BY created_at DESC`
  ).all();
  return c.json(results);
});

r.get("/stock", async (c) => {
  const q = c.req.query();
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.item_type, s.chip, s.uid, s.batch, s.status, s.org_id, s.allocated_at, s.shipment_note, s.registered_at, s.note, s.created_at,
            (s.sun_meta_key IS NOT NULL) AS has_keys, o.name AS org_name, t.label AS tag_label, u.name AS user_name
       FROM tag_stock s LEFT JOIN organizations o ON o.id = s.org_id LEFT JOIN tags t ON t.id = s.id LEFT JOIN users u ON u.id = s.registered_user_id
      WHERE (? IS NULL OR s.batch = ?) AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.org_id = ?) AND (? IS NULL OR s.id LIKE ? OR s.uid LIKE ?)
      ORDER BY s.created_at DESC, s.id LIMIT 1000`
  )
    .bind(q.batch ?? null, q.batch ?? null, q.status ?? null, q.status ?? null, q.orgId ?? null, q.orgId ?? null, q.q ?? null, `%${q.q ?? ""}%`, `%${(q.q ?? "").toUpperCase()}%`)
    .all();
  return c.json(results);
});

/** 在庫の発行: 公開ID（URLに使う）を採番。NTAG424 はタグ固有の SUN 鍵も生成 */
r.post("/stock/generate", async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z.object({
      count: z.number().int().min(1).max(500),
      itemType: z.enum(["location_tag", "badge"]),
      chip: z.enum(["ntag213", "ntag215", "ntag216", "ntag424", "mifare", "other"]),
      batch: z.string().min(1).max(60),
      note: z.string().max(200).nullish()
    })
  );
  const t = now();
  const ids: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < b.count; i++) {
    const id = shortId(10);
    ids.push(id);
    let meta: string | null = null;
    let file: string | null = null;
    if (b.chip === "ntag424") {
      meta = await sealSecret(bytesToHex(crypto.getRandomValues(new Uint8Array(16))), c.env.TAG_KEY_SECRET);
      file = await sealSecret(bytesToHex(crypto.getRandomValues(new Uint8Array(16))), c.env.TAG_KEY_SECRET);
    }
    stmts.push(
      c.env.DB.prepare("INSERT INTO tag_stock (id, item_type, chip, sun_meta_key, sun_file_key, batch, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(
        id,
        b.itemType,
        b.chip,
        meta,
        file,
        b.batch,
        "in_stock",
        b.note ?? null,
        t
      )
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  await platformAudit(c.env, o.id, "stock.generate", "tag_stock", b.batch, { count: b.count, chip: b.chip, itemType: b.itemType });
  return c.json({ created: ids.length, ids });
});

/** エンコード後の物理UIDを取り込み（CSV: id,uid） */
r.post("/stock/import-uids", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ rows: z.array(z.object({ id: z.string().min(4), uid: z.string().regex(/^[0-9A-Fa-f:]{8,32}$/) })).min(1).max(2000) }));
  let updated = 0;
  const errors: string[] = [];
  for (const row of b.rows) {
    try {
      const res = await c.env.DB.prepare("UPDATE tag_stock SET uid = ? WHERE id = ?").bind(row.uid.replace(/:/g, "").toUpperCase(), row.id.trim()).run();
      if (res.meta.changes) updated++;
      else errors.push(`${row.id}: 在庫にありません`);
    } catch {
      errors.push(`${row.id}: UIDが重複しています`);
    }
  }
  await platformAudit(c.env, o.id, "stock.import_uids", "tag_stock", null, { updated, errors: errors.length });
  return c.json({ updated, errors });
});

function stockUrl(origin: string, id: string, chip: string) {
  return chip === "ntag424" ? `${origin}/t/${id}?picc=00000000000000000000000000000000&cmac=0000000000000000` : `${origin}/t/${id}`;
}

/** エンコード業者・書込みツール向けCSV。鍵を含む場合はオーナーのみ */
r.get("/stock/export.csv", async (c) => {
  const o = c.get("ops");
  const batch = c.req.query("batch");
  const withKeys = c.req.query("keys") === "1";
  if (withKeys && o.role !== "owner") fail(403, "鍵の書き出しはオーナーのみ可能です");
  if (!batch) fail(400, "batch を指定してください");
  const { results } = await c.env.DB.prepare("SELECT id, item_type, chip, uid, sun_meta_key, sun_file_key FROM tag_stock WHERE batch = ? ORDER BY id")
    .bind(batch)
    .all<{ id: string; item_type: string; chip: string; uid: string | null; sun_meta_key: string | null; sun_file_key: string | null }>();
  const origin = new URL(c.req.url).origin;
  const header = ["id", "url", "item_type", "chip", "uid", ...(withKeys ? ["sdm_meta_read_key", "sdm_file_read_key"] : [])];
  const lines = [header.join(",")];
  for (const s of results) {
    const row = [s.id, stockUrl(origin, s.id, s.chip), s.item_type, s.chip, s.uid ?? ""];
    if (withKeys) {
      row.push(s.sun_meta_key ? await openSecret(s.sun_meta_key, c.env.TAG_KEY_SECRET) : "", s.sun_file_key ? await openSecret(s.sun_file_key, c.env.TAG_KEY_SECRET) : "");
    }
    lines.push(row.join(","));
  }
  await platformAudit(c.env, o.id, withKeys ? "stock.export_with_keys" : "stock.export", "tag_stock", batch, { rows: results.length });
  return new Response("﻿" + lines.join("\r\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="tag-stock-${encodeURIComponent(batch)}.csv"`, "cache-control": "no-store" }
  });
});

/** ラベル印刷シート（タグ表面に貼る登録コード） */
r.get("/stock/labels", async (c) => {
  const batch = c.req.query("batch");
  const orgId = c.req.query("orgId");
  const { results } = await c.env.DB.prepare(
    "SELECT s.id, s.item_type, o.name AS org_name FROM tag_stock s LEFT JOIN organizations o ON o.id = s.org_id WHERE (? IS NULL OR s.batch = ?) AND (? IS NULL OR s.org_id = ?) ORDER BY s.id LIMIT 1000"
  )
    .bind(batch ?? null, batch ?? null, orgId ?? null, orgId ?? null)
    .all<{ id: string; item_type: string; org_name: string | null }>();
  const origin = new URL(c.req.url).origin;
  const withQr = c.req.query("qr") !== "0";
  const cells = results
    .map(
      (s) =>
        `<div class="l">${withQr && s.item_type !== "badge" ? `<div class="q">${qrSvg(tagQrUrl(origin, s.id), { margin: 1 })}</div>` : ""}<div class="t"><div class="b">Intent-Trace</div><div class="id">${s.id.slice(0, 5)}-${s.id.slice(5)}</div><div class="s">${s.item_type === "badge" ? "社員証" : "NFCタグ / QR"}${s.org_name ? `<br>${s.org_name.replace(/[<>&]/g, "")}` : ""}</div></div></div>`
    )
    .join("");
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ラベル ${batch ?? ""}</title><style>
  body{margin:10mm;font-family:"Hiragino Sans","Noto Sans JP",sans-serif}.g{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm}
  .l{border:1px dashed #999;border-radius:3mm;padding:2mm;height:26mm;box-sizing:border-box;display:flex;align-items:center;gap:2mm;overflow:hidden}
  .q{width:21mm;height:21mm;flex:none}.q svg{width:100%;height:100%}.t{text-align:left;min-width:0}
  .b{font-size:8pt;color:#b45309;font-weight:bold}.id{font-family:ui-monospace,monospace;font-size:15pt;font-weight:bold;letter-spacing:.05em;margin:1mm 0}.s{font-size:7pt;color:#555}
  @media print{.np{display:none}}</style></head><body><button class="np" onclick="print()">印刷</button><p class="np">${results.length}枚</p><div class="g">${cells}</div></body></html>`);
});

/** テナントへの出荷割当 */
r.post("/stock/allocate", async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z.object({
      orgId: z.string(),
      ids: z.array(z.string()).max(1000).optional(),
      batch: z.string().optional(),
      itemType: z.enum(["location_tag", "badge"]).optional(),
      count: z.number().int().min(1).max(1000).optional(),
      shipmentNote: z.string().max(200).nullish()
    })
  );
  const org = await c.env.DB.prepare("SELECT id, name FROM organizations WHERE id = ?").bind(b.orgId).first<{ id: string; name: string }>();
  if (!org) fail(404, "テナントが見つかりません");
  let ids = b.ids ?? [];
  if (!ids.length) {
    if (!b.count) fail(422, "ids か count を指定してください");
    const { results } = await c.env.DB.prepare(
      "SELECT id FROM tag_stock WHERE status = 'in_stock' AND (? IS NULL OR batch = ?) AND (? IS NULL OR item_type = ?) ORDER BY created_at, id LIMIT ?"
    )
      .bind(b.batch ?? null, b.batch ?? null, b.itemType ?? null, b.itemType ?? null, b.count)
      .all<{ id: string }>();
    ids = results.map((x) => x.id);
    if (ids.length < b.count) fail(409, `在庫が不足しています（在庫 ${ids.length} / 要求 ${b.count}）`);
  }
  const t = now();
  let allocated = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const res = await c.env.DB.batch(
      ids
        .slice(i, i + 50)
        .map((id) =>
          c.env.DB.prepare("UPDATE tag_stock SET status = 'allocated', org_id = ?, allocated_at = ?, shipment_note = ? WHERE id = ? AND status = 'in_stock'").bind(b.orgId, t, b.shipmentNote ?? null, id)
        )
    );
    allocated += res.reduce((s, r0) => s + (r0.meta.changes ?? 0), 0);
  }
  await platformAudit(c.env, o.id, "stock.allocate", "organization", b.orgId, { allocated, shipmentNote: b.shipmentNote });
  await audit(c.env, b.orgId, null, "stock.received", "organization", b.orgId, { count: allocated, note: b.shipmentNote });
  return c.json({ allocated, ids });
});

r.post("/stock/unallocate", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ ids: z.array(z.string()).min(1).max(1000) }));
  let n = 0;
  for (const id of b.ids) {
    const res = await c.env.DB.prepare("UPDATE tag_stock SET status = 'in_stock', org_id = NULL, allocated_at = NULL, shipment_note = NULL WHERE id = ? AND status = 'allocated'").bind(id).run();
    n += res.meta.changes ?? 0;
  }
  await platformAudit(c.env, o.id, "stock.unallocate", "tag_stock", null, { count: n });
  return c.json({ unallocated: n });
});

r.post("/stock/retire", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ ids: z.array(z.string()).min(1).max(1000), note: z.string().max(200).optional() }));
  let n = 0;
  for (const id of b.ids) {
    const res = await c.env.DB.prepare("UPDATE tag_stock SET status = 'retired', note = COALESCE(?, note) WHERE id = ? AND status IN ('in_stock','allocated')").bind(b.note ?? null, id).run();
    n += res.meta.changes ?? 0;
  }
  await platformAudit(c.env, o.id, "stock.retire", "tag_stock", null, { count: n });
  return c.json({ retired: n });
});

// ---------- 請求 ----------
r.get("/invoices", async (c) => {
  const period = c.req.query("period") ?? null;
  const status = c.req.query("status") ?? null;
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.number, i.org_id, o.name AS org_name, i.period, i.plan_code, i.subtotal, i.tax, i.total, i.status, i.issued_at, i.due_at, i.paid_at
       FROM invoices i JOIN organizations o ON o.id = i.org_id WHERE (? IS NULL OR i.period = ?) AND (? IS NULL OR i.status = ?) ORDER BY i.period DESC, o.name LIMIT 500`
  )
    .bind(period, period, status, status)
    .all();
  return c.json(results);
});

r.post("/invoices/generate", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).default(monthKey()), orgIds: z.array(z.string()).optional() }));
  const { results: orgs } = await c.env.DB.prepare("SELECT id FROM organizations WHERE status = 'active'").all<{ id: string }>();
  const targets = b.orgIds?.length ? b.orgIds : orgs.map((x) => x.id);
  const seq = await c.env.DB.prepare("SELECT COUNT(*) n FROM invoices WHERE period = ?").bind(b.period).first<{ n: number }>();
  let n = seq?.n ?? 0;
  const created: string[] = [];
  const skipped: string[] = [];
  for (const orgId of targets) {
    const exists = await c.env.DB.prepare("SELECT id FROM invoices WHERE org_id = ? AND period = ?").bind(orgId, b.period).first();
    if (exists) {
      skipped.push(orgId);
      continue;
    }
    const inv = await computeInvoice(c.env, orgId);
    n++;
    const id = newId();
    await c.env.DB.prepare(
      "INSERT INTO invoices (id, number, org_id, period, plan_code, items_json, subtotal, tax, total, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, `INV-${b.period.replace("-", "")}-${String(n).padStart(4, "0")}`, orgId, b.period, inv.plan.code, JSON.stringify(inv.items), inv.subtotal, inv.tax, inv.total, "draft", now())
      .run();
    created.push(id);
  }
  await platformAudit(c.env, o.id, "invoice.generate", "invoice", b.period, { created: created.length, skipped: skipped.length });
  return c.json({ created: created.length, skipped: skipped.length });
});

r.patch("/invoices/:id", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ status: z.enum(["draft", "issued", "paid", "void"]), dueAt: z.number().int().optional() }));
  const t = now();
  const inv = await c.env.DB.prepare("SELECT period FROM invoices WHERE id = ?").bind(c.req.param("id")).first<{ period: string }>();
  if (!inv) fail(404, "請求書が見つかりません");
  // 支払期限の既定: 翌月末
  const [y, m] = inv.period.split("-").map(Number);
  const defaultDue = Date.UTC(y, m + 1, 0, 14, 59) ;
  if (b.status === "issued") {
    await c.env.DB.prepare("UPDATE invoices SET status = 'issued', issued_at = COALESCE(issued_at, ?), due_at = COALESCE(?, due_at, ?) WHERE id = ?").bind(t, b.dueAt ?? null, defaultDue, c.req.param("id")).run();
    await sendInvoiceMail(c.env, c.req.url, c.req.param("id"));
  } else if (b.status === "paid") {
    await c.env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, issued_at = COALESCE(issued_at, ?) WHERE id = ?").bind(t, t, c.req.param("id")).run();
  } else {
    await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?").bind(b.status, c.req.param("id")).run();
  }
  await platformAudit(c.env, o.id, `invoice.${b.status}`, "invoice", c.req.param("id"));
  return c.json({ ok: true });
});

r.post("/invoices/:id/send", async (c) => {
  const o = c.get("ops");
  const n = await sendInvoiceMail(c.env, c.req.url, c.req.param("id"), true);
  await platformAudit(c.env, o.id, "invoice.send", "invoice", c.req.param("id"), { recipients: n });
  return c.json({ recipients: n });
});

r.post("/invoices/:id/recalculate", async (c) => {
  const o = c.get("ops");
  const inv = await c.env.DB.prepare("SELECT org_id, status FROM invoices WHERE id = ?").bind(c.req.param("id")).first<{ org_id: string; status: string }>();
  if (!inv) fail(404, "請求書が見つかりません");
  if (inv.status !== "draft") fail(409, "下書きのみ再計算できます");
  const x = await computeInvoice(c.env, inv.org_id);
  await c.env.DB.prepare("UPDATE invoices SET items_json = ?, subtotal = ?, tax = ?, total = ?, plan_code = ? WHERE id = ?")
    .bind(JSON.stringify(x.items), x.subtotal, x.tax, x.total, x.plan.code, c.req.param("id"))
    .run();
  await platformAudit(c.env, o.id, "invoice.recalculate", "invoice", c.req.param("id"));
  return c.json({ ok: true });
});

r.get("/invoices/:id/print", async (c) => c.html(await renderInvoice(c.env, c.req.param("id"))));

// ---------- お知らせ ----------
r.get("/announcements", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT a.*, o.name AS org_name FROM announcements a LEFT JOIN organizations o ON o.id = a.org_id ORDER BY a.published_at DESC LIMIT 200"
  ).all();
  return c.json(results);
});

r.post("/announcements", async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(4000),
      level: z.enum(["info", "maintenance", "important"]).default("info"),
      orgId: z.string().nullish(),
      publishedAt: z.number().int().optional(),
      expiresAt: z.number().int().nullish()
    })
  );
  const id = newId();
  await c.env.DB.prepare("INSERT INTO announcements (id, title, body, level, org_id, published_at, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, b.title, b.body, b.level, b.orgId || null, b.publishedAt ?? now(), b.expiresAt ?? null, o.id, now())
    .run();
  await platformAudit(c.env, o.id, "announcement.create", "announcement", id, { title: b.title, orgId: b.orgId });
  return c.json({ id });
});

r.delete("/announcements/:id", async (c) => {
  const o = c.get("ops");
  await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(c.req.param("id")).run();
  await platformAudit(c.env, o.id, "announcement.delete", "announcement", c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- サポート ----------
r.get("/tickets", async (c) => {
  const status = c.req.query("status") ?? null;
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, o.name AS org_name, u.name AS user_name,
            (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
       FROM support_tickets t JOIN organizations o ON o.id = t.org_id LEFT JOIN users u ON u.id = t.user_id
      WHERE (? IS NULL OR t.status = ?) ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 300`
  )
    .bind(status, status)
    .all();
  return c.json(results);
});

r.get("/tickets/:id", async (c) => {
  const t = await c.env.DB.prepare("SELECT t.*, o.name AS org_name FROM support_tickets t JOIN organizations o ON o.id = t.org_id WHERE t.id = ?").bind(c.req.param("id")).first();
  if (!t) fail(404, "問い合わせが見つかりません");
  const { results } = await c.env.DB.prepare("SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at").bind(c.req.param("id")).all();
  return c.json({ ticket: t, messages: results });
});

r.post("/tickets/:id/reply", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ body: z.string().min(1).max(8000), close: z.boolean().default(false) }));
  const t = await c.env.DB.prepare("SELECT id FROM support_tickets WHERE id = ?").bind(c.req.param("id")).first();
  if (!t) fail(404, "問い合わせが見つかりません");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO support_messages (id, ticket_id, author_type, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)").bind(
      newId(),
      c.req.param("id"),
      "platform",
      o.id,
      `${o.name}（運営）`,
      b.body,
      now()
    ),
    c.env.DB.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").bind(b.close ? "closed" : "answered", now(), c.req.param("id"))
  ]);
  await platformAudit(c.env, o.id, "ticket.reply", "support_ticket", c.req.param("id"));
  return c.json({ ok: true });
});

r.patch("/tickets/:id", async (c) => {
  const b = await body(c, z.object({ status: z.enum(["open", "answered", "closed"]) }));
  await c.env.DB.prepare("UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?").bind(b.status, now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

// ---------- 通知（送信履歴・テスト送信） ----------
// ===== システムエラー =====
r.get("/errors", async (c) => {
  const days = Math.min(90, Number(c.req.query("days") ?? 7));
  const since = now() - days * 86400_000;
  const [groups, recent] = await Promise.all([
    c.env.DB.prepare(
      `SELECT e.source, e.path, e.message, COUNT(*) n, MAX(e.created_at) last_at, COUNT(DISTINCT e.org_id) orgs
         FROM error_events e WHERE e.created_at > ? GROUP BY e.source, e.path, e.message ORDER BY last_at DESC LIMIT 100`
    )
      .bind(since)
      .all(),
    c.env.DB.prepare(
      `SELECT e.id, e.source, e.method, e.path, e.message, e.detail, e.user_agent, e.created_at, e.reported_at, o.name AS org_name
         FROM error_events e LEFT JOIN organizations o ON o.id = e.org_id WHERE e.created_at > ? ORDER BY e.created_at DESC LIMIT 200`
    )
      .bind(since)
      .all()
  ]);
  const undelivered = await c.env.DB.prepare(
    `SELECT n.id, o.name AS org_name, n.channel, n.to_label, n.to_address, n.subject, n.attempts, n.last_error, n.created_at, n.escalated_at
       FROM notification_outbox n LEFT JOIN organizations o ON o.id = n.org_id
      WHERE n.status = 'failed' AND n.created_at > ? ORDER BY n.created_at DESC LIMIT 100`
  )
    .bind(since)
    .all();
  return c.json({ groups: groups.results, recent: recent.results, undelivered: undelivered.results });
});

r.get("/notifications", async (c) => {
  const status = c.req.query("status") ?? null;
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.org_id, o.name AS org_name, n.channel, n.to_address, n.to_label, n.event_type, n.subject, n.status, n.attempts, n.last_error, n.created_at, n.sent_at
       FROM notification_outbox n LEFT JOIN organizations o ON o.id = n.org_id WHERE (? IS NULL OR n.status = ?) ORDER BY n.created_at DESC LIMIT 300`
  )
    .bind(status, status)
    .all();
  return c.json(results);
});

r.get("/notifications/:id", async (c) => {
  const n = await c.env.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(c.req.param("id")).first();
  if (!n) fail(404, "見つかりません");
  return c.json(n);
});

r.post("/notifications/:id/retry", async (c) => {
  await c.env.DB.prepare("UPDATE notification_outbox SET status = 'pending', attempts = 0 WHERE id = ?").bind(c.req.param("id")).run();
  await retryOutbox(c.env);
  const n = await c.env.DB.prepare("SELECT status, last_error FROM notification_outbox WHERE id = ?").bind(c.req.param("id")).first();
  return c.json(n);
});

r.post("/notifications/test", async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ channel: z.enum(["email", "line"]), to: z.string().min(3) }));
  const cfg = await getNotifyConfig(c.env);
  const tpl = emailTemplate(cfg, "Intent-Trace テスト通知", ["このメッセージは運営コンソールからのテスト送信です。", `送信者: ${o.name}`]);
  const [res] = await notify(c.env, [{ orgId: null, channel: b.channel, to: b.to, eventType: "test", subject: "Intent-Trace テスト通知", body: b.channel === "line" ? "✅ Intent-Trace テスト通知です" : tpl.text, html: tpl.html }], cfg);
  const row = await c.env.DB.prepare("SELECT status, last_error FROM notification_outbox WHERE id = ?").bind(res.id).first();
  return c.json(row);
});

// ---------- 設定・運営アカウント ----------
r.get("/settings", async (c) => {
  const all = await getSettings(c.env);
  const out: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("secret:")) secrets[k.slice(7)] = !!v;
    else out[k] = v;
  }
  const lineWebhookUrl = `${new URL(c.req.url).origin}/api/line/webhook`;
  return c.json({ ...out, secrets, lineWebhookUrl });
});

r.put("/settings", requireOpsOwner, async (c) => {
  const o = c.get("ops");
  const b = await body(
    c,
    z
      .object({
        company_name: z.string().max(200),
        company_address: z.string().max(500),
        invoice_registration_no: z.string().max(20),
        bank_info: z.string().max(1000),
        support_email: z.string().max(200),
        tax_rate: z.string().regex(/^\d{1,2}$/),
        email_provider: z.enum(["none", "resend", "brevo", "sendgrid"]),
        email_from: z.string().max(200),
        email_from_name: z.string().max(100),
        line_bot_basic_id: z.string().max(40),
        app_base_url: z.string().max(200),
        require_ops_2fa: z.enum(["0", "1"]),
        // 秘密情報（空文字で削除、undefined で変更なし）
        email_api_key: z.string().max(500),
        line_channel_secret: z.string().max(200),
        line_channel_token: z.string().max(1000)
      })
      .partial()
  );
  for (const k of SECRET_SETTINGS) {
    const v = (b as Record<string, string | undefined>)[k];
    if (v !== undefined) await putSecretSetting(c.env, k, v.trim());
    delete (b as Record<string, string | undefined>)[k];
  }
  const entries = Object.entries(b).filter(([, v]) => v !== undefined) as [string, string][];
  if (!entries.length) return c.json({ ok: true });
  await c.env.DB.batch(entries.map(([k, v]) => c.env.DB.prepare("INSERT INTO platform_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v)));
  await platformAudit(c.env, o.id, "settings.update", "platform_settings", null, Object.keys(b));
  return c.json({ ok: true });
});

r.get("/admins", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, email, name, role, active, totp_enabled, last_login_at, created_at FROM platform_admins ORDER BY created_at").all();
  return c.json(results);
});

r.post("/admins", requireOpsOwner, async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ name: z.string().min(1), email: z.string().email(), role: z.enum(["owner", "staff"]) }));
  const pw = tempPassword();
  const id = newId();
  try {
    await c.env.DB.prepare("INSERT INTO platform_admins (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, b.email.toLowerCase(), b.name, b.role, await hashPassword(pw), now())
      .run();
  } catch {
    fail(409, "このメールアドレスは既に登録されています");
  }
  await platformAudit(c.env, o.id, "admin.create", "platform_admin", id, { email: b.email, role: b.role });
  const cfg = await getNotifyConfig(c.env);
  const base = cfg.baseUrl || new URL(c.req.url).origin;
  const tpl = emailTemplate(cfg, "運営コンソールのアカウントを作成しました", [`${b.name} 様`, "", `${o.name} さんが Intent-Trace 運営コンソールのアカウントを作成しました。`, "", `メール: ${b.email}`, `仮パスワード: ${pw}`, "", "ログイン後、パスワードの変更と二段階認証の設定を行ってください。"], { label: "運営コンソールを開く", url: `${base}/ops/login` });
  const [m] = await notify(c.env, [{ orgId: null, channel: "email", to: b.email.toLowerCase(), toLabel: b.name, eventType: "invite", refId: id, subject: "【Intent-Trace】運営コンソールへのご招待", body: tpl.text, html: tpl.html }], cfg);
  return c.json({ id, temporaryPassword: pw, mailStatus: m.status });
});

r.patch("/admins/:id", requireOpsOwner, async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ active: z.boolean().optional(), role: z.enum(["owner", "staff"]).optional(), resetPassword: z.boolean().optional(), reset2fa: z.boolean().optional() }));
  if (b.reset2fa) {
    if (c.req.param("id") === o.id) fail(400, "自分の二段階認証は「二段階認証」の画面から変更してください");
    await c.env.DB.prepare("UPDATE platform_admins SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, recovery_codes_json = NULL, token_version = token_version + 1 WHERE id = ?").bind(c.req.param("id")).run();
  }
  if (c.req.param("id") === o.id && (b.active === false || b.role === "staff")) fail(400, "自分自身の権限は変更できません");
  let pw: string | null = null;
  if (b.active !== undefined) await c.env.DB.prepare("UPDATE platform_admins SET active = ?, token_version = token_version + 1 WHERE id = ?").bind(b.active ? 1 : 0, c.req.param("id")).run();
  if (b.role) await c.env.DB.prepare("UPDATE platform_admins SET role = ? WHERE id = ?").bind(b.role, c.req.param("id")).run();
  if (b.resetPassword) {
    pw = tempPassword();
    await c.env.DB.prepare("UPDATE platform_admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(pw), c.req.param("id")).run();
  }
  await platformAudit(c.env, o.id, "admin.update", "platform_admin", c.req.param("id"), { ...b, resetPassword: !!b.resetPassword, reset2fa: !!b.reset2fa });
  return c.json({ ok: true, temporaryPassword: pw });
});

r.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT l.*, a.name AS admin_name FROM platform_audit_logs l LEFT JOIN platform_admins a ON a.id = l.admin_id ORDER BY l.created_at DESC LIMIT 500"
  ).all();
  return c.json(results);
});

export default r;
