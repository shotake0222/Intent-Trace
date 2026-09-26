// 運営（スーパーアドミン）API  /api/ops/*
import { z } from "zod";
import { createRouter, body, fail, newId, now, audit, parseJson } from "../lib/app";
import { requireOps, requireOpsOwner, issueOpsSession, clearOpsSession, issueSession } from "../lib/auth";
import { hashPassword, verifyPassword, timingSafeEqual, enc, shortId, sealSecret, openSecret, bytesToHex, randomToken } from "../lib/crypto";
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
  await c.env.DB.prepare("UPDATE platform_admins SET last_login_at = ? WHERE id = ?").bind(now(), a.id).run();
  await platformAudit(c.env, a.id, "ops.login", null, null);
  await issueOpsSession(c, a, a.token_version);
  return c.json({ ok: true });
});

r.post("/logout", (c) => {
  clearOpsSession(c);
  return c.json({ ok: true });
});

// ---------- 以降は運営ログイン必須 ----------
r.use("*", requireOps);

r.get("/me", (c) => c.json(c.get("ops")));

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
  await audit(c.env, orgId, null, "org.created_by_platform", "organization", orgId, { by: o.name });
  return c.json({ id: orgId, orgCode: b.code.toUpperCase(), adminEmail: b.admin.email.toLowerCase(), initialPassword: b.admin.password ? null : password });
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
  return c.json({ temporaryPassword: pw });
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
  const cells = results
    .map(
      (s) =>
        `<div class="l"><div class="b">Intent-Trace</div><div class="id">${s.id.slice(0, 5)}-${s.id.slice(5)}</div><div class="s">${s.item_type === "badge" ? "社員証" : "NFCタグ"}${s.org_name ? ` / ${s.org_name.replace(/[<>&]/g, "")}` : ""}</div></div>`
    )
    .join("");
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ラベル ${batch ?? ""}</title><style>
  body{margin:10mm;font-family:"Hiragino Sans","Noto Sans JP",sans-serif}.g{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm}
  .l{border:1px dashed #999;border-radius:3mm;padding:3mm;text-align:center;height:22mm;box-sizing:border-box}
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
  } else if (b.status === "paid") {
    await c.env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ?, issued_at = COALESCE(issued_at, ?) WHERE id = ?").bind(t, t, c.req.param("id")).run();
  } else {
    await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?").bind(b.status, c.req.param("id")).run();
  }
  await platformAudit(c.env, o.id, `invoice.${b.status}`, "invoice", c.req.param("id"));
  return c.json({ ok: true });
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

// ---------- 設定・運営アカウント ----------
r.get("/settings", async (c) => c.json(await getSettings(c.env)));

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
        tax_rate: z.string().regex(/^\d{1,2}$/)
      })
      .partial()
  );
  const entries = Object.entries(b).filter(([, v]) => v !== undefined) as [string, string][];
  if (!entries.length) return c.json({ ok: true });
  await c.env.DB.batch(entries.map(([k, v]) => c.env.DB.prepare("INSERT INTO platform_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v)));
  await platformAudit(c.env, o.id, "settings.update", "platform_settings", null, Object.keys(b));
  return c.json({ ok: true });
});

r.get("/admins", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, email, name, role, active, last_login_at, created_at FROM platform_admins ORDER BY created_at").all();
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
  return c.json({ id, temporaryPassword: pw });
});

r.patch("/admins/:id", requireOpsOwner, async (c) => {
  const o = c.get("ops");
  const b = await body(c, z.object({ active: z.boolean().optional(), role: z.enum(["owner", "staff"]).optional(), resetPassword: z.boolean().optional() }));
  if (c.req.param("id") === o.id && (b.active === false || b.role === "staff")) fail(400, "自分自身の権限は変更できません");
  let pw: string | null = null;
  if (b.active !== undefined) await c.env.DB.prepare("UPDATE platform_admins SET active = ?, token_version = token_version + 1 WHERE id = ?").bind(b.active ? 1 : 0, c.req.param("id")).run();
  if (b.role) await c.env.DB.prepare("UPDATE platform_admins SET role = ? WHERE id = ?").bind(b.role, c.req.param("id")).run();
  if (b.resetPassword) {
    pw = tempPassword();
    await c.env.DB.prepare("UPDATE platform_admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").bind(await hashPassword(pw), c.req.param("id")).run();
  }
  await platformAudit(c.env, o.id, "admin.update", "platform_admin", c.req.param("id"), { ...b, resetPassword: !!b.resetPassword });
  return c.json({ ok: true, temporaryPassword: pw });
});

r.get("/audit", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT l.*, a.name AS admin_name FROM platform_audit_logs l LEFT JOIN platform_admins a ON a.id = l.admin_id ORDER BY l.created_at DESC LIMIT 500"
  ).all();
  return c.json(results);
});

export default r;
