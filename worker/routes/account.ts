// テナント管理者向け: 契約・請求・お知らせ・サポート  /api/account/*
import { z } from "zod";
import { createRouter, body, fail, newId, now, audit } from "../lib/app";
import { requireAuth, requireRole } from "../lib/auth";
import { getContract, usage, computeInvoice, getSettings } from "../lib/platform";
import { renderInvoice } from "../lib/invoice";
import { getOrgPrefs, getNotifyConfig, notify, emailTemplate, sixDigitCode, type Message } from "../lib/notify";

const r = createRouter();
r.use("*", requireAuth);

// お知らせは全ロールに表示（作業員アプリにも出せるように）
r.get("/announcements", async (c) => {
  const u = c.get("user");
  const t = now();
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, body, level, published_at FROM announcements
      WHERE (org_id IS NULL OR org_id = ?) AND published_at <= ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY published_at DESC LIMIT 20`
  )
    .bind(u.orgId, t, t)
    .all();
  return c.json(results);
});

r.use("*", requireRole("admin", "manager"));

r.get("/contract", async (c) => {
  const u = c.get("user");
  const [contract, use, estimate, settings, org] = await Promise.all([
    getContract(c.env, u.orgId),
    usage(c.env, u.orgId),
    computeInvoice(c.env, u.orgId),
    getSettings(c.env),
    c.env.DB.prepare("SELECT code, name, contact_name, contact_email, contact_phone, billing_email, address, contract_started_at, created_at FROM organizations WHERE id = ?")
      .bind(u.orgId)
      .first()
  ]);
  const { results: plans } = await c.env.DB.prepare(
    "SELECT code, name, monthly_fee, fee_per_tag, fee_per_user, included_tags, included_users, max_tags, max_users, max_sites, features_json FROM plans WHERE active = 1 AND code != 'trial' ORDER BY sort"
  ).all();
  return c.json({ org, contract, usage: use, estimate, plans, support: { email: settings.support_email ?? "", company: settings.company_name ?? "" } });
});

r.patch("/org", requireRole("admin"), async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      contactName: z.string().max(100).nullish(),
      contactEmail: z.string().max(200).nullish(),
      contactPhone: z.string().max(50).nullish(),
      billingEmail: z.string().max(200).nullish(),
      address: z.string().max(300).nullish()
    })
  );
  await c.env.DB.prepare(
    "UPDATE organizations SET contact_name = COALESCE(?, contact_name), contact_email = COALESCE(?, contact_email), contact_phone = COALESCE(?, contact_phone), billing_email = COALESCE(?, billing_email), address = COALESCE(?, address) WHERE id = ?"
  )
    .bind(b.contactName ?? null, b.contactEmail ?? null, b.contactPhone ?? null, b.billingEmail ?? null, b.address ?? null, u.orgId)
    .run();
  return c.json({ ok: true });
});

r.get("/invoices", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, number, period, total, status, issued_at, due_at, paid_at FROM invoices WHERE org_id = ? AND status IN ('issued','paid') ORDER BY period DESC"
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

r.get("/invoices/:id/print", async (c) => c.html(await renderInvoice(c.env, c.req.param("id"), c.get("user").orgId)));

// ---------- 通知設定（メール・LINE） ----------
r.get("/notifications", async (c) => {
  const u = c.get("user");
  const [prefs, cfg, targets, me, org, admins] = await Promise.all([
    getOrgPrefs(c.env, u.orgId),
    getNotifyConfig(c.env),
    c.env.DB.prepare(
      "SELECT t.id, t.kind, t.display_name, t.min_severity, t.active, t.created_at, us.name AS user_name FROM line_targets t LEFT JOIN users us ON us.id = t.user_id WHERE t.org_id = ? ORDER BY t.created_at"
    )
      .bind(u.orgId)
      .all(),
    c.env.DB.prepare("SELECT email, notify_email FROM users WHERE id = ?").bind(u.id).first<{ email: string | null; notify_email: number }>(),
    c.env.DB.prepare("SELECT allow_qr_checkin FROM organizations WHERE id = ?").bind(u.orgId).first<{ allow_qr_checkin: number }>(),
    c.env.DB.prepare("SELECT name, email, notify_email FROM users WHERE org_id = ? AND role IN ('admin','manager') AND active = 1 AND email IS NOT NULL ORDER BY role, name")
      .bind(u.orgId)
      .all()
  ]);
  const { results: log } = await c.env.DB.prepare(
    "SELECT id, channel, to_label, to_address, event_type, subject, status, last_error, created_at FROM notification_outbox WHERE org_id = ? ORDER BY created_at DESC LIMIT 50"
  )
    .bind(u.orgId)
    .all();
  return c.json({
    prefs,
    me: { email: me?.email ?? null, notifyEmail: !!me?.notify_email },
    emailRecipients: admins.results,
    allowQrCheckin: !!org?.allow_qr_checkin,
    channels: { email: cfg.provider !== "none" && !!cfg.emailApiKey && !!cfg.from, line: !!cfg.lineToken, lineBasicId: cfg.lineBasicId },
    lineTargets: targets.results,
    log: log.map((l) => ({ ...l, to_address: (l as { channel: string }).channel === "line" ? "LINE" : (l as { to_address: string }).to_address }))
  });
});

// 自分がアラートメールを受け取るか（管理者・マネージャー各自）
r.put("/notifications/me", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ notifyEmail: z.boolean() }));
  await c.env.DB.prepare("UPDATE users SET notify_email = ? WHERE id = ?").bind(b.notifyEmail ? 1 : 0, u.id).run();
  return c.json({ ok: true });
});

r.put("/notifications", requireRole("admin"), async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      alertEmail: z.enum(["info", "warning", "danger", "off"]),
      alertLine: z.enum(["info", "warning", "danger", "off"]),
      extraEmails: z.array(z.string().email()).max(20),
      invoiceEmail: z.boolean(),
      allowQrCheckin: z.boolean().optional()
    })
  );
  const { allowQrCheckin, ...prefs } = b;
  await c.env.DB.prepare("UPDATE organizations SET notify_json = ?, allow_qr_checkin = COALESCE(?, allow_qr_checkin) WHERE id = ?")
    .bind(JSON.stringify(prefs), allowQrCheckin === undefined ? null : allowQrCheckin ? 1 : 0, u.orgId)
    .run();
  await audit(c.env, u.orgId, u.id, "org.notify_settings", "organization", u.orgId, b);
  return c.json({ ok: true });
});

/** LINE 連携コード発行: 公式アカウントを友だち追加（またはグループに招待）してこの6桁を送信 */
r.post("/line/link-code", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ personal: z.boolean().default(false) }));
  const cfg = await getNotifyConfig(c.env);
  if (!cfg.lineToken) fail(400, "LINE連携は運営側でまだ設定されていません");
  const code = sixDigitCode();
  await c.env.DB.prepare("DELETE FROM line_link_codes WHERE expires_at < ?").bind(now()).run();
  await c.env.DB.prepare("INSERT OR REPLACE INTO line_link_codes (code, org_id, user_id, created_by, expires_at) VALUES (?,?,?,?,?)")
    .bind(code, u.orgId, b.personal ? u.id : null, u.id, now() + 15 * 60_000)
    .run();
  return c.json({ code, expiresAt: now() + 15 * 60_000, addFriendUrl: cfg.lineBasicId ? `https://line.me/R/ti/p/@${encodeURIComponent(cfg.lineBasicId.replace(/^@/, ""))}` : null });
});

r.patch("/line/targets/:id", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ minSeverity: z.enum(["info", "warning", "danger"]).optional(), active: z.boolean().optional() }));
  await c.env.DB.prepare("UPDATE line_targets SET min_severity = COALESCE(?, min_severity), active = COALESCE(?, active) WHERE id = ? AND org_id = ?")
    .bind(b.minSeverity ?? null, b.active === undefined ? null : b.active ? 1 : 0, c.req.param("id"), u.orgId)
    .run();
  return c.json({ ok: true });
});

r.delete("/line/targets/:id", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("DELETE FROM line_targets WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).run();
  await audit(c.env, u.orgId, u.id, "line.unlink", "line_target", c.req.param("id"));
  return c.json({ ok: true });
});

/** テスト通知: 現在の設定で届く宛先すべてに送る */
r.post("/notifications/test", async (c) => {
  const u = c.get("user");
  const cfg = await getNotifyConfig(c.env);
  const prefs = await getOrgPrefs(c.env, u.orgId);
  const msgs: Message[] = [];
  const tpl = emailTemplate(cfg, "Intent-Trace テスト通知", [`${u.name} さんが送信したテスト通知です。`, "アラート発生時はこの宛先に通知されます。"]);
  if (prefs.alertEmail !== "off") {
    const { results } = await c.env.DB.prepare("SELECT name, email FROM users WHERE org_id = ? AND role IN ('admin','manager') AND active = 1 AND notify_email = 1 AND email IS NOT NULL")
      .bind(u.orgId)
      .all<{ name: string; email: string }>();
    const to = new Map(results.map((x) => [x.email, x.name]));
    for (const e of prefs.extraEmails) to.set(e, "");
    for (const [email, name] of to) msgs.push({ orgId: u.orgId, channel: "email", to: email, toLabel: name, eventType: "test", subject: "【Intent-Trace】テスト通知", body: tpl.text, html: tpl.html });
  }
  if (prefs.alertLine !== "off") {
    const { results } = await c.env.DB.prepare("SELECT line_id, display_name FROM line_targets WHERE org_id = ? AND active = 1").bind(u.orgId).all<{ line_id: string; display_name: string | null }>();
    for (const t of results) msgs.push({ orgId: u.orgId, channel: "line", to: t.line_id, toLabel: t.display_name, eventType: "test", subject: "テスト通知", body: `✅ Intent-Trace テスト通知（${u.name} さんが送信）` });
  }
  const res = await notify(c.env, msgs, cfg);
  return c.json({ total: res.length, sent: res.filter((x) => x.status === "sent").length, skipped: res.filter((x) => x.status === "skipped").length, failed: res.filter((x) => x.status === "failed").length });
});

// ---------- サポート ----------
r.get("/tickets", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.subject, t.category, t.status, t.created_at, t.updated_at, us.name AS user_name,
            (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
       FROM support_tickets t LEFT JOIN users us ON us.id = t.user_id WHERE t.org_id = ? ORDER BY t.updated_at DESC`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

r.post("/tickets", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ subject: z.string().min(1).max(200), category: z.enum(["general", "tags", "billing", "bug", "request"]).default("general"), body: z.string().min(1).max(8000) }));
  const id = newId();
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO support_tickets (id, org_id, user_id, subject, category, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, u.orgId, u.id, b.subject, b.category, "open", t, t),
    c.env.DB.prepare("INSERT INTO support_messages (id, ticket_id, author_type, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)").bind(newId(), id, "tenant", u.id, u.name, b.body, t)
  ]);
  return c.json({ id });
});

r.get("/tickets/:id", async (c) => {
  const u = c.get("user");
  const t = await c.env.DB.prepare("SELECT * FROM support_tickets WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).first();
  if (!t) fail(404, "問い合わせが見つかりません");
  const { results } = await c.env.DB.prepare("SELECT id, author_type, author_name, body, created_at FROM support_messages WHERE ticket_id = ? ORDER BY created_at").bind(c.req.param("id")).all();
  return c.json({ ticket: t, messages: results });
});

r.post("/tickets/:id/reply", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ body: z.string().min(1).max(8000) }));
  const t = await c.env.DB.prepare("SELECT id FROM support_tickets WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).first();
  if (!t) fail(404, "問い合わせが見つかりません");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO support_messages (id, ticket_id, author_type, author_id, author_name, body, created_at) VALUES (?,?,?,?,?,?,?)").bind(newId(), c.req.param("id"), "tenant", u.id, u.name, b.body, now()),
    c.env.DB.prepare("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?").bind(now(), c.req.param("id"))
  ]);
  return c.json({ ok: true });
});

r.post("/tickets/:id/close", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ? AND org_id = ?").bind(now(), c.req.param("id"), u.orgId).run();
  return c.json({ ok: true });
});

export default r;
