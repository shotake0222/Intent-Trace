// テナント管理者向け: 契約・請求・お知らせ・サポート  /api/account/*
import { z } from "zod";
import { createRouter, body, fail, newId, now } from "../lib/app";
import { requireAuth, requireRole } from "../lib/auth";
import { getContract, usage, computeInvoice, getSettings } from "../lib/platform";
import { renderInvoice } from "../lib/invoice";

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
