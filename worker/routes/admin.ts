// 管理者ダッシュボード向け API（マスタ管理・履歴参照）
import { z } from "zod";
import { createRouter, body, fail, newId, now, audit, assertSiteInOrg, parseJson } from "../lib/app";
import { requireAuth, requireRole } from "../lib/auth";
import { hashPassword, randomToken, sha256Hex, sealSecret, openSecret, shortId } from "../lib/crypto";
import { invalidateTag, invalidateTagsForEquipment } from "../lib/tags";
import { lockStub, deadmanStub } from "../lib/domain";
import { assertLimit, assertFeature } from "../lib/platform";
import { verifySun, SunError } from "../lib/sun";
import { sendUserInviteMail } from "../lib/mailers";
import { qrSvg, tagQrUrl } from "../lib/qr";

const r = createRouter();
r.use("*", requireAuth, requireRole("admin", "manager"));
const adminOnly = requireRole("admin");

const optStr = z.string().trim().max(500).nullish().transform((v) => (v ? v : null));

// ===== サイト / ゾーン =====
r.get("/sites", async (c) => {
  const u = c.get("user");
  const { results: sites } = await c.env.DB.prepare("SELECT * FROM sites WHERE org_id = ? ORDER BY created_at").bind(u.orgId).all();
  const { results: zones } = await c.env.DB.prepare("SELECT z.* FROM zones z JOIN sites s ON s.id = z.site_id WHERE s.org_id = ? ORDER BY z.floor, z.name").bind(u.orgId).all();
  return c.json({ sites, zones });
});

r.post("/sites", adminOnly, async (c) => {
  const u = c.get("user");
  await assertLimit(c.env, u.orgId, "sites");
  const b = await body(c, z.object({ name: z.string().min(1), address: optStr }));
  const id = newId();
  await c.env.DB.prepare("INSERT INTO sites (id, org_id, name, address, created_at) VALUES (?,?,?,?,?)").bind(id, u.orgId, b.name, b.address, now()).run();
  return c.json({ id });
});

r.post("/zones", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ siteId: z.string(), name: z.string().min(1), floor: optStr, posX: z.number().min(0).max(1).nullish(), posY: z.number().min(0).max(1).nullish() }));
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  const id = newId();
  await c.env.DB.prepare("INSERT INTO zones (id, site_id, name, floor, pos_x, pos_y) VALUES (?,?,?,?,?,?)").bind(id, b.siteId, b.name, b.floor, b.posX ?? null, b.posY ?? null).run();
  return c.json({ id });
});

// ===== 資格 =====
r.get("/qualifications", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM qualifications WHERE org_id = ? ORDER BY code").bind(c.get("user").orgId).all();
  return c.json(results);
});

r.post("/qualifications", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), name: z.string().min(1) }));
  const id = newId();
  try {
    await c.env.DB.prepare("INSERT INTO qualifications (id, org_id, code, name) VALUES (?,?,?,?)").bind(id, u.orgId, b.code.toUpperCase(), b.name).run();
  } catch {
    fail(409, "同じコードの資格が既にあります");
  }
  return c.json({ id });
});

// ===== ユーザー =====
r.get("/users", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.role, u.name, u.email, u.employee_code, u.badge_uid, u.ble_id, u.active, u.created_at,
            (SELECT json_group_array(json_object('id', q.id, 'code', q.code, 'name', q.name, 'expiresAt', uq.expires_at))
               FROM user_qualifications uq JOIN qualifications q ON q.id = uq.qualification_id WHERE uq.user_id = u.id) AS quals
       FROM users u WHERE u.org_id = ? ORDER BY u.role, u.employee_code`
  )
    .bind(u.orgId)
    .all<Record<string, unknown> & { quals: string }>();
  return c.json(results.map((r0) => ({ ...r0, quals: parseJson(r0.quals, []) })));
});

const userSchema = z.object({
  role: z.enum(["admin", "manager", "worker"]),
  name: z.string().min(1),
  employeeCode: z.string().min(1).max(32),
  email: z.string().email().nullish(),
  secret: z.string().min(4).max(64), // 管理者: パスワード(8文字以上推奨) / 作業員: PIN
  badgeUid: optStr,
  bleId: optStr
});

r.post("/users", adminOnly, async (c) => {
  const u = c.get("user");
  const b = await body(c, userSchema);
  await assertLimit(c.env, u.orgId, "users");
  if (b.role !== "worker" && !b.email) fail(422, "管理者・マネージャーにはメールアドレスが必要です");
  if (b.role !== "worker" && b.secret.length < 8) fail(422, "パスワードは8文字以上にしてください");
  const id = newId();
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, org_id, role, name, email, employee_code, password_hash, badge_uid, ble_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, u.orgId, b.role, b.name, b.email?.toLowerCase() ?? null, b.employeeCode, await hashPassword(b.secret), b.badgeUid?.replace(/[^0-9a-fA-F]/g, "").toUpperCase() || null, b.bleId, now())
      .run();
  } catch {
    fail(409, "社員番号またはメールアドレスが重複しています");
  }
  await audit(c.env, u.orgId, u.id, "user.create", "user", id, { role: b.role });
  let mailStatus: string | null = null;
  if (b.email) {
    const org = await c.env.DB.prepare("SELECT name, code FROM organizations WHERE id = ?").bind(u.orgId).first<{ name: string; code: string }>();
    mailStatus = await sendUserInviteMail(c.env, c.req.url, {
      orgId: u.orgId,
      userId: id,
      to: b.email.toLowerCase(),
      name: b.name,
      role: b.role,
      orgName: org?.name ?? "",
      orgCode: org?.code ?? "",
      employeeCode: b.employeeCode,
      secret: b.secret,
      invitedBy: u.name
    });
  }
  return c.json({ id, mailStatus });
});

r.patch("/users/:id", adminOnly, async (c) => {
  const u = c.get("user");
  const b = await body(c, userSchema.partial().extend({ active: z.boolean().optional() }));
  const id = c.req.param("id");
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.name !== undefined) (sets.push("name = ?"), vals.push(b.name));
  if (b.role !== undefined) (sets.push("role = ?"), vals.push(b.role));
  if (b.email !== undefined) (sets.push("email = ?"), vals.push(b.email?.toLowerCase() ?? null));
  if (b.employeeCode !== undefined) (sets.push("employee_code = ?"), vals.push(b.employeeCode));
  if (b.secret) (sets.push("password_hash = ?", "token_version = token_version + 1"), vals.push(await hashPassword(b.secret)));
  if (b.badgeUid !== undefined) (sets.push("badge_uid = ?"), vals.push(b.badgeUid?.replace(/[^0-9a-fA-F]/g, "").toUpperCase() || null));
  if (b.bleId !== undefined) (sets.push("ble_id = ?"), vals.push(b.bleId));
  if (b.active !== undefined) {
    if (b.active) await assertLimit(c.env, u.orgId, "users");
    sets.push("active = ?");
    vals.push(b.active ? 1 : 0);
  }
  if (!sets.length) return c.json({ ok: true });
  const res = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`).bind(...vals, id, u.orgId).run();
  if (!res.meta.changes) fail(404, "ユーザーが見つかりません");
  await audit(c.env, u.orgId, u.id, "user.update", "user", id, { fields: Object.keys(b).filter((k) => k !== "secret") });
  return c.json({ ok: true });
});

r.put("/users/:id/qualifications/:qid", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ certifiedAt: z.number().int().nullish(), expiresAt: z.number().int().nullish() }));
  const ok = await c.env.DB.prepare(
    "SELECT 1 AS x FROM users u, qualifications q WHERE u.id = ? AND q.id = ? AND u.org_id = ? AND q.org_id = ?"
  )
    .bind(c.req.param("id"), c.req.param("qid"), u.orgId, u.orgId)
    .first();
  if (!ok) fail(404, "ユーザーまたは資格が見つかりません");
  await c.env.DB.prepare(
    "INSERT INTO user_qualifications (user_id, qualification_id, certified_at, expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id, qualification_id) DO UPDATE SET certified_at = excluded.certified_at, expires_at = excluded.expires_at"
  )
    .bind(c.req.param("id"), c.req.param("qid"), b.certifiedAt ?? null, b.expiresAt ?? null)
    .run();
  await audit(c.env, u.orgId, u.id, "qualification.grant", "user", c.req.param("id"), { qualificationId: c.req.param("qid"), expiresAt: b.expiresAt });
  return c.json({ ok: true });
});

r.delete("/users/:id/qualifications/:qid", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare(
    "DELETE FROM user_qualifications WHERE user_id = ? AND qualification_id = ? AND user_id IN (SELECT id FROM users WHERE org_id = ?)"
  )
    .bind(c.req.param("id"), c.req.param("qid"), u.orgId)
    .run();
  await audit(c.env, u.orgId, u.id, "qualification.revoke", "user", c.req.param("id"), { qualificationId: c.req.param("qid") });
  return c.json({ ok: true });
});

// ===== 設備 =====
const equipmentSchema = z.object({
  siteId: z.string(),
  zoneId: optStr,
  name: z.string().min(1),
  category: optStr,
  model: optStr,
  serialNo: optStr,
  locationNote: optStr,
  requiredQualificationId: optStr,
  lockable: z.boolean().default(false),
  inspectionIntervalDays: z.number().int().min(1).max(3650).nullish(),
  checklist: z.array(z.string().min(1)).default([])
});

r.get("/equipment", async (c) => {
  const u = c.get("user");
  const siteId = c.req.query("siteId");
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, s.name AS site_name, z.name AS zone_name, q.name AS qualification_name,
            (SELECT MAX(completed_at) FROM inspections i WHERE i.equipment_id = e.id) AS last_inspected_at,
            (SELECT result FROM inspections i WHERE i.equipment_id = e.id ORDER BY completed_at DESC LIMIT 1) AS last_result,
            (SELECT COUNT(*) FROM documents d WHERE d.equipment_id = e.id AND d.kind = 'manual') AS manuals
       FROM equipment e JOIN sites s ON s.id = e.site_id LEFT JOIN zones z ON z.id = e.zone_id
       LEFT JOIN qualifications q ON q.id = e.required_qualification_id
      WHERE e.org_id = ? AND (? IS NULL OR e.site_id = ?) ORDER BY s.name, e.name`
  )
    .bind(u.orgId, siteId ?? null, siteId ?? null)
    .all<Record<string, unknown> & { lockable: number; id: string; checklist_json: string | null }>();
  const withLocks = await Promise.all(
    results.map(async (e) => ({ ...e, checklist: parseJson(e.checklist_json, []), lock: e.lockable ? await lockStub(c.env, e.id).status() : null }))
  );
  return c.json(withLocks);
});

r.post("/equipment", async (c) => {
  const u = c.get("user");
  const b = await body(c, equipmentSchema);
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO equipment (id, org_id, site_id, zone_id, name, category, model, serial_no, location_note, required_qualification_id, lockable, inspection_interval_days, checklist_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, u.orgId, b.siteId, b.zoneId, b.name, b.category, b.model, b.serialNo, b.locationNote, b.requiredQualificationId, b.lockable ? 1 : 0, b.inspectionIntervalDays ?? null, JSON.stringify(b.checklist), now())
    .run();
  return c.json({ id });
});

r.patch("/equipment/:id", async (c) => {
  const u = c.get("user");
  const b = await body(c, equipmentSchema.partial());
  const map: Record<string, [string, (v: unknown) => unknown]> = {
    zoneId: ["zone_id", (v) => v],
    name: ["name", (v) => v],
    category: ["category", (v) => v],
    model: ["model", (v) => v],
    serialNo: ["serial_no", (v) => v],
    locationNote: ["location_note", (v) => v],
    requiredQualificationId: ["required_qualification_id", (v) => v],
    lockable: ["lockable", (v) => (v ? 1 : 0)],
    inspectionIntervalDays: ["inspection_interval_days", (v) => v ?? null],
    checklist: ["checklist_json", (v) => JSON.stringify(v)]
  };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || !map[k]) continue;
    sets.push(`${map[k][0]} = ?`);
    vals.push(map[k][1](v));
  }
  if (sets.length) {
    const res = await c.env.DB.prepare(`UPDATE equipment SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`).bind(...vals, c.req.param("id"), u.orgId).run();
    if (!res.meta.changes) fail(404, "設備が見つかりません");
    await invalidateTagsForEquipment(c.env, c.req.param("id"));
  }
  return c.json({ ok: true });
});

r.get("/equipment/:id/documents", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare("SELECT id, kind, filename, content_type, size, created_at FROM documents WHERE equipment_id = ? AND org_id = ? ORDER BY created_at DESC")
    .bind(c.req.param("id"), u.orgId)
    .all();
  return c.json(results);
});

// ===== NFCタグ =====
r.get("/tags", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.site_id, t.zone_id, t.kind, t.label, t.equipment_id, t.security, t.uid, t.sun_last_ctr, t.active, t.created_at,
            s.name AS site_name, z.name AS zone_name, e.name AS equipment_name,
            (SELECT MAX(occurred_at) FROM tap_events te WHERE te.tag_id = t.id) AS last_tap_at
       FROM tags t JOIN sites s ON s.id = t.site_id LEFT JOIN zones z ON z.id = t.zone_id LEFT JOIN equipment e ON e.id = t.equipment_id
      WHERE t.org_id = ? ORDER BY s.name, t.kind, t.label`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

const hex32 = z.string().regex(/^[0-9A-Fa-f]{32}$/, "16バイト(32桁)のhexで入力してください");
const tagSchema = z.object({
  siteId: z.string(),
  zoneId: optStr,
  kind: z.enum(["checkpoint", "equipment", "procedure_step", "deadman"]),
  label: z.string().min(1),
  equipmentId: optStr,
  uid: z.string().regex(/^[0-9A-Fa-f:]{8,32}$/).nullish(),
  security: z.enum(["static", "sun"]).default("static"),
  sunMetaKey: hex32.optional(),
  sunFileKey: hex32.optional()
});

r.post("/tags", async (c) => {
  const u = c.get("user");
  const b = await body(c, tagSchema);
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  await assertLimit(c.env, u.orgId, "tags");
  if (b.security === "sun") await assertFeature(c.env, u.orgId, "sun", "暗号タグ鍵の手動登録");
  if (b.kind === "equipment" && !b.equipmentId) fail(422, "設備タグには設備の指定が必要です");
  if (b.security === "sun" && (!b.sunMetaKey || !b.sunFileKey)) fail(422, "SUNタグには SDMMetaReadKey と SDMFileReadKey が必要です");
  const id = shortId(10);
  await c.env.DB.prepare(
    `INSERT INTO tags (id, org_id, site_id, zone_id, kind, label, equipment_id, security, uid, sun_meta_key, sun_file_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id,
      u.orgId,
      b.siteId,
      b.zoneId,
      b.kind,
      b.label,
      b.equipmentId,
      b.security,
      b.uid ? b.uid.replace(/:/g, "").toUpperCase() : null,
      b.sunMetaKey ? await sealSecret(b.sunMetaKey.toUpperCase(), c.env.TAG_KEY_SECRET) : null,
      b.sunFileKey ? await sealSecret(b.sunFileKey.toUpperCase(), c.env.TAG_KEY_SECRET) : null,
      now()
    )
    .run();
  await audit(c.env, u.orgId, u.id, "tag.create", "tag", id, { kind: b.kind, security: b.security });
  return c.json({ id, url: tagUrl(c.req.url, id, b.security) });
});

function tagUrl(reqUrl: string, id: string, security: string) {
  const origin = new URL(reqUrl).origin;
  return security === "sun" ? `${origin}/t/${id}?picc=00000000000000000000000000000000&cmac=0000000000000000` : `${origin}/t/${id}`;
}

r.patch("/tags/:id", async (c) => {
  const u = c.get("user");
  const b = await body(c, tagSchema.partial().extend({ active: z.boolean().optional() }));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.label !== undefined) (sets.push("label = ?"), vals.push(b.label));
  if (b.zoneId !== undefined) (sets.push("zone_id = ?"), vals.push(b.zoneId));
  if (b.equipmentId !== undefined) (sets.push("equipment_id = ?"), vals.push(b.equipmentId));
  if (b.uid !== undefined) (sets.push("uid = ?"), vals.push(b.uid ? b.uid.replace(/:/g, "").toUpperCase() : null));
  if (b.active !== undefined) (sets.push("active = ?"), vals.push(b.active ? 1 : 0));
  if (b.security !== undefined) (sets.push("security = ?"), vals.push(b.security));
  if (b.sunMetaKey) (sets.push("sun_meta_key = ?", "sun_last_ctr = -1"), vals.push(await sealSecret(b.sunMetaKey.toUpperCase(), c.env.TAG_KEY_SECRET)));
  if (b.sunFileKey) (sets.push("sun_file_key = ?"), vals.push(await sealSecret(b.sunFileKey.toUpperCase(), c.env.TAG_KEY_SECRET)));
  if (!sets.length) return c.json({ ok: true });
  const res = await c.env.DB.prepare(`UPDATE tags SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`).bind(...vals, c.req.param("id"), u.orgId).run();
  if (!res.meta.changes) fail(404, "タグが見つかりません");
  await invalidateTag(c.env, c.req.param("id"));
  await audit(c.env, u.orgId, u.id, "tag.update", "tag", c.req.param("id"), { fields: Object.keys(b).filter((k) => !k.startsWith("sun")) });
  return c.json({ ok: true });
});

/** 登録済みタグのラベル（QRコード付き）印刷 */
r.get("/tags/labels", async (c) => {
  const u = c.get("user");
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
  const siteId = c.req.query("siteId") ?? null;
  const size = c.req.query("size") === "l" ? "l" : "s";
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.label, t.kind, s.name AS site_name, z.name AS zone_name, o.name AS org_name, o.allow_qr_checkin
       FROM tags t JOIN sites s ON s.id = t.site_id LEFT JOIN zones z ON z.id = t.zone_id JOIN organizations o ON o.id = t.org_id
      WHERE t.org_id = ? AND t.active = 1 AND (? IS NULL OR t.site_id = ?) ORDER BY s.name, t.label`
  )
    .bind(u.orgId, siteId, siteId)
    .all<{ id: string; label: string; kind: string; site_name: string; zone_name: string | null; org_name: string; allow_qr_checkin: number }>();
  const rows = ids.length ? results.filter((r0) => ids.includes(r0.id)) : results;
  const origin = new URL(c.req.url).origin;
  const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  const KIND: Record<string, string> = { checkpoint: "チェックポイント", equipment: "設備", procedure_step: "作業手順", deadman: "生存確認" };
  const cells = rows
    .map(
      (t) => `<div class="l"><div class="q">${qrSvg(tagQrUrl(origin, t.id), { margin: 1 })}</div><div class="t">
<div class="k">${esc(KIND[t.kind] ?? "")}</div><div class="n">${esc(t.label)}</div><div class="s">${esc(t.site_name)}${t.zone_name ? ` / ${esc(t.zone_name)}` : ""}</div>
<div class="c">${t.id.slice(0, 5)}-${t.id.slice(5)}</div><div class="h">NFCにタッチ${rows[0]?.allow_qr_checkin ? "／QRを読取" : ""}</div></div></div>`
    )
    .join("");
  return c.html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>タグラベル</title><style>
body{margin:8mm;font-family:"Hiragino Sans","Noto Sans JP",sans-serif}
.g{display:grid;grid-template-columns:repeat(${size === "l" ? 2 : 3},1fr);gap:3mm}
.l{border:1px dashed #999;border-radius:3mm;padding:2.5mm;display:flex;gap:3mm;align-items:center;break-inside:avoid;height:${size === "l" ? 50 : 32}mm;box-sizing:border-box;overflow:hidden}
.q{flex:none;width:${size === "l" ? 42 : 26}mm;height:${size === "l" ? 42 : 26}mm}.q svg{width:100%;height:100%}
.t{min-width:0}.k{font-size:7pt;color:#b45309;font-weight:bold}.n{font-size:${size === "l" ? 15 : 10}pt;font-weight:bold;line-height:1.25;margin:.5mm 0}
.s{font-size:7pt;color:#555}.c{font-family:ui-monospace,monospace;font-size:8pt;margin-top:1mm}.h{font-size:6.5pt;color:#777;margin-top:.5mm}
.bar{margin-bottom:4mm;font-size:12px}@media print{.bar{display:none}}
</style></head><body><div class="bar"><button onclick="print()">印刷</button> ${rows.length}枚 ／ サイズ: <a href="?${new URLSearchParams({ ...(siteId ? { siteId } : {}), ...(ids.length ? { ids: ids.join(",") } : {}), size: "s" })}">小</a> <a href="?${new URLSearchParams({ ...(siteId ? { siteId } : {}), ...(ids.length ? { ids: ids.join(",") } : {}), size: "l" })}">大</a></div><div class="g">${cells}</div></body></html>`);
});

// ===== 受領タグ（運営から出荷されたハードウェア）の登録 =====
const normCode = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

r.get("/tag-stock", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.item_type, s.chip, s.uid, s.status, s.allocated_at, s.shipment_note, s.registered_at, s.registered_user_id, us.name AS user_name, t.label AS tag_label
       FROM tag_stock s LEFT JOIN users us ON us.id = s.registered_user_id LEFT JOIN tags t ON t.id = s.id
      WHERE s.org_id = ? AND s.status IN ('allocated','registered') ORDER BY s.status, s.allocated_at DESC, s.id`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

r.get("/tag-stock/:code", async (c) => {
  const u = c.get("user");
  const s = await c.env.DB.prepare("SELECT id, item_type, chip, uid, status FROM tag_stock WHERE id = ? AND org_id = ?").bind(normCode(c.req.param("code")), u.orgId).first();
  if (!s) fail(404, "この登録コードのタグは貴社に出荷されていません");
  return c.json(s);
});

interface StockRow {
  id: string;
  item_type: "location_tag" | "badge";
  chip: string;
  uid: string | null;
  sun_meta_key: string | null;
  sun_file_key: string | null;
  status: string;
}

async function loadStock(env: Env, code: string, orgId: string) {
  const s = await env.DB.prepare("SELECT id, item_type, chip, uid, sun_meta_key, sun_file_key, status FROM tag_stock WHERE id = ? AND org_id = ?")
    .bind(normCode(code), orgId)
    .first<StockRow>();
  if (!s) fail(404, "この登録コードのタグは貴社に出荷されていません");
  if (s.status === "registered") fail(409, "このタグは既に登録済みです");
  if (s.status !== "allocated") fail(409, "このタグは使用できません（廃棄済み）");
  return s;
}

const registerSchema = z.object({
  stockId: z.string().min(4),
  siteId: z.string(),
  zoneId: optStr,
  kind: z.enum(["checkpoint", "equipment", "procedure_step", "deadman"]),
  label: z.string().min(1),
  equipmentId: optStr,
  // 現地でタッチして登録する場合の SUN パラメータ（暗号タグの実在確認）
  sun: z.object({ picc: z.string().regex(/^[0-9A-Fa-f]{32}$/), cmac: z.string().regex(/^[0-9A-Fa-f]{16}$/) }).optional(),
  serial: z.string().max(64).optional()
});

/** 受領済みタグを設置場所・設備に紐付けて稼働させる（現場でのタッチ登録にも使用） */
r.post("/tags/register", async (c) => {
  const u = c.get("user");
  const b = await body(c, registerSchema);
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  if (b.kind === "equipment" && !b.equipmentId) fail(422, "設備タグには設備の指定が必要です");
  const s = await loadStock(c.env, b.stockId, u.orgId);
  if (s.item_type !== "location_tag") fail(422, "社員証は「作業員・資格」画面でユーザーに割り当ててください");
  await assertLimit(c.env, u.orgId, "tags");
  let uid = s.uid;
  let lastCtr = -1;
  if (b.sun && s.sun_meta_key && s.sun_file_key) {
    try {
      const v = await verifySun(b.sun.picc, b.sun.cmac, await openSecret(s.sun_meta_key, c.env.TAG_KEY_SECRET), await openSecret(s.sun_file_key, c.env.TAG_KEY_SECRET));
      if (uid && uid !== v.uid) fail(403, "登録情報と異なる物理タグです");
      uid = v.uid;
      lastCtr = v.counter;
    } catch (e) {
      if (e instanceof SunError) fail(403, `タグの真正性を確認できません: ${e.message}`, "sun_invalid");
      throw e;
    }
  }
  if (b.serial) {
    const serial = b.serial.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (uid && serial && uid !== serial) fail(409, "登録コードと物理タグが一致しません。別のタグをかざしていないか確認してください");
    if (!uid && serial) {
      const dup = await c.env.DB.prepare("SELECT id FROM tag_stock WHERE uid = ? AND id != ?").bind(serial, s.id).first();
      if (dup) fail(409, "このタグ（UID）は別の登録コードで管理されています");
      uid = serial;
    }
  }
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tags (id, org_id, site_id, zone_id, kind, label, equipment_id, security, uid, sun_meta_key, sun_file_key, sun_last_ctr, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(s.id, u.orgId, b.siteId, b.zoneId, b.kind, b.label, b.equipmentId, s.sun_meta_key ? "sun" : "static", uid, s.sun_meta_key, s.sun_file_key, lastCtr, t),
    c.env.DB.prepare("UPDATE tag_stock SET status = 'registered', registered_at = ?, uid = COALESCE(uid, ?) WHERE id = ?").bind(t, uid, s.id)
  ]);
  await invalidateTag(c.env, s.id);
  await audit(c.env, u.orgId, u.id, "tag.register", "tag", s.id, { kind: b.kind, label: b.label, viaTouch: !!(b.sun || b.serial) });
  return c.json({ id: s.id });
});

/** 破損・紛失したタグを新しいタグに交換（巡回ルート・手順・デバイスの紐付けを引き継ぐ） */
r.post("/tags/:id/replace", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ stockId: z.string().min(4), reason: z.string().max(200).optional() }));
  const old = await c.env.DB.prepare("SELECT * FROM tags WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).first<{
    id: string;
    site_id: string;
    zone_id: string | null;
    kind: string;
    label: string;
    equipment_id: string | null;
  }>();
  if (!old) fail(404, "タグが見つかりません");
  const s = await loadStock(c.env, b.stockId, u.orgId);
  if (s.item_type !== "location_tag") fail(422, "設置タグを指定してください");
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tags (id, org_id, site_id, zone_id, kind, label, equipment_id, security, uid, sun_meta_key, sun_file_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(s.id, u.orgId, old.site_id, old.zone_id, old.kind, old.label, old.equipment_id, s.sun_meta_key ? "sun" : "static", s.uid, s.sun_meta_key, s.sun_file_key, t),
    c.env.DB.prepare("UPDATE tag_stock SET status = 'registered', registered_at = ? WHERE id = ?").bind(t, s.id),
    c.env.DB.prepare("UPDATE patrol_route_points SET tag_id = ? WHERE tag_id = ?").bind(s.id, old.id),
    c.env.DB.prepare("UPDATE procedure_steps SET tag_id = ? WHERE tag_id = ?").bind(s.id, old.id),
    c.env.DB.prepare("UPDATE devices SET tag_id = ? WHERE tag_id = ?").bind(s.id, old.id),
    c.env.DB.prepare("UPDATE tags SET active = 0, label = label || '（交換済）' WHERE id = ?").bind(old.id),
    c.env.DB.prepare("UPDATE tag_stock SET status = 'retired', note = ? WHERE id = ?").bind(`交換: ${b.reason ?? ""} → ${s.id}`, old.id)
  ]);
  await invalidateTag(c.env, old.id);
  await audit(c.env, u.orgId, u.id, "tag.replace", "tag", old.id, { newTagId: s.id, reason: b.reason });
  return c.json({ id: s.id });
});

/** スマート社員証（受領在庫）をユーザーに割り当て / 解除 */
r.put("/users/:id/badge", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ stockId: z.string().nullable() }));
  const target = await c.env.DB.prepare("SELECT id, badge_uid FROM users WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).first<{ id: string; badge_uid: string | null }>();
  if (!target) fail(404, "ユーザーが見つかりません");
  const t = now();
  const stmts: D1PreparedStatement[] = [
    // 既存の割当を在庫に戻す
    c.env.DB.prepare("UPDATE tag_stock SET status = 'allocated', registered_user_id = NULL, registered_at = NULL WHERE registered_user_id = ? AND org_id = ?").bind(target.id, u.orgId)
  ];
  if (b.stockId) {
    const s = await loadStock(c.env, b.stockId, u.orgId);
    if (s.item_type !== "badge") fail(422, "社員証を指定してください");
    if (!s.uid) fail(422, "この社員証はUIDが未登録です。運営にお問い合わせください");
    stmts.push(
      c.env.DB.prepare("UPDATE users SET badge_uid = ? WHERE id = ?").bind(s.uid, target.id),
      c.env.DB.prepare("UPDATE tag_stock SET status = 'registered', registered_user_id = ?, registered_at = ? WHERE id = ?").bind(target.id, t, s.id)
    );
  } else {
    stmts.push(c.env.DB.prepare("UPDATE users SET badge_uid = NULL WHERE id = ?").bind(target.id));
  }
  await c.env.DB.batch(stmts);
  await audit(c.env, u.orgId, u.id, b.stockId ? "badge.assign" : "badge.unassign", "user", target.id, { stockId: b.stockId });
  return c.json({ ok: true });
});

// ===== 巡回ルート =====
r.get("/routes", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT pr.*, s.name AS site_name,
            (SELECT json_group_array(json_object('seq', p.seq, 'tagId', p.tag_id, 'label', t.label))
               FROM (SELECT * FROM patrol_route_points ORDER BY seq) p JOIN tags t ON t.id = p.tag_id WHERE p.route_id = pr.id) AS points
       FROM patrol_routes pr JOIN sites s ON s.id = pr.site_id WHERE pr.org_id = ? ORDER BY pr.created_at`
  )
    .bind(u.orgId)
    .all<Record<string, unknown> & { points: string }>();
  return c.json(results.map((x) => ({ ...x, points: parseJson(x.points, []) })));
});

r.post("/routes", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ siteId: z.string(), name: z.string().min(1), enforceOrder: z.boolean().default(false), timeLimitMin: z.number().int().positive().nullish(), tagIds: z.array(z.string()).min(1).max(200) }));
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  const { results: valid } = await c.env.DB.prepare(`SELECT id FROM tags WHERE org_id = ? AND id IN (${b.tagIds.map(() => "?").join(",")})`).bind(u.orgId, ...b.tagIds).all<{ id: string }>();
  if (new Set(valid.map((v) => v.id)).size !== new Set(b.tagIds).size) fail(422, "不明なタグが含まれています");
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO patrol_routes (id, org_id, site_id, name, enforce_order, time_limit_min, created_at) VALUES (?,?,?,?,?,?,?)").bind(id, u.orgId, b.siteId, b.name, b.enforceOrder ? 1 : 0, b.timeLimitMin ?? null, now()),
    ...b.tagIds.map((t, i) => c.env.DB.prepare("INSERT INTO patrol_route_points (route_id, seq, tag_id) VALUES (?,?,?)").bind(id, i + 1, t))
  ]);
  return c.json({ id });
});

r.get("/patrol-runs", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.status, r.started_at, r.finished_at, pr.name AS route_name, us.name AS user_name,
            (SELECT COUNT(*) FROM patrol_run_visits v WHERE v.run_id = r.id) AS visited,
            (SELECT COUNT(*) FROM patrol_route_points p WHERE p.route_id = r.route_id) AS total
       FROM patrol_runs r JOIN patrol_routes pr ON pr.id = r.route_id JOIN users us ON us.id = r.user_id
      WHERE r.org_id = ? ORDER BY r.started_at DESC LIMIT 100`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

// ===== 作業手順 =====
r.get("/procedures", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT p.*, e.name AS equipment_name,
            (SELECT json_group_array(json_object('seq', s.seq, 'tagId', s.tag_id, 'instruction', s.instruction, 'label', t.label))
               FROM (SELECT * FROM procedure_steps ORDER BY seq) s JOIN tags t ON t.id = s.tag_id WHERE s.procedure_id = p.id) AS steps
       FROM procedures p LEFT JOIN equipment e ON e.id = p.equipment_id WHERE p.org_id = ? ORDER BY p.created_at`
  )
    .bind(u.orgId)
    .all<Record<string, unknown> & { steps: string }>();
  return c.json(results.map((x) => ({ ...x, steps: parseJson(x.steps, []) })));
});

r.post("/procedures", async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      name: z.string().min(1),
      equipmentId: optStr,
      unlocksEquipment: z.boolean().default(false),
      steps: z.array(z.object({ tagId: z.string(), instruction: z.string().min(1) })).min(1).max(50)
    })
  );
  if (b.unlocksEquipment && !b.equipmentId) fail(422, "起動許可に連動する手順には設備の指定が必要です");
  const tagIds = [...new Set(b.steps.map((s) => s.tagId))];
  const { results: valid } = await c.env.DB.prepare(`SELECT id FROM tags WHERE org_id = ? AND id IN (${tagIds.map(() => "?").join(",")})`).bind(u.orgId, ...tagIds).all();
  if (valid.length !== tagIds.length) fail(422, "不明なタグが含まれています");
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO procedures (id, org_id, equipment_id, name, unlocks_equipment, created_at) VALUES (?,?,?,?,?,?)").bind(id, u.orgId, b.equipmentId, b.name, b.unlocksEquipment ? 1 : 0, now()),
    ...b.steps.map((s, i) => c.env.DB.prepare("INSERT INTO procedure_steps (procedure_id, seq, tag_id, instruction) VALUES (?,?,?,?)").bind(id, i + 1, s.tagId, s.instruction))
  ]);
  return c.json({ id });
});

// ===== IoTデバイス =====
r.get("/devices", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.site_id, d.kind, d.name, d.equipment_id, d.tag_id, d.last_seen_at, d.created_at, e.name AS equipment_name, s.name AS site_name
       FROM devices d JOIN sites s ON s.id = d.site_id LEFT JOIN equipment e ON e.id = d.equipment_id WHERE d.org_id = ? ORDER BY d.created_at`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

r.post("/devices", adminOnly, async (c) => {
  const u = c.get("user");
  await assertFeature(c.env, u.orgId, "devices", "IoTデバイス連携");
  const b = await body(c, z.object({ siteId: z.string(), kind: z.enum(["ble_receiver", "nfc_reader"]), name: z.string().min(1), equipmentId: optStr, tagId: optStr }));
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  const id = `dev_${shortId(12)}`;
  const token = randomToken(32);
  await c.env.DB.prepare("INSERT INTO devices (id, org_id, site_id, kind, name, equipment_id, tag_id, token_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(id, u.orgId, b.siteId, b.kind, b.name, b.equipmentId, b.tagId, await sha256Hex(token), now())
    .run();
  await audit(c.env, u.orgId, u.id, "device.create", "device", id);
  // トークンはこの応答でのみ表示（DBにはハッシュのみ保存）
  return c.json({ id, credential: `${id}.${token}` });
});

r.post("/devices/:id/rotate", adminOnly, async (c) => {
  const u = c.get("user");
  const token = randomToken(32);
  const res = await c.env.DB.prepare("UPDATE devices SET token_hash = ? WHERE id = ? AND org_id = ?").bind(await sha256Hex(token), c.req.param("id"), u.orgId).run();
  if (!res.meta.changes) fail(404, "デバイスが見つかりません");
  await audit(c.env, u.orgId, u.id, "device.rotate", "device", c.req.param("id"));
  return c.json({ credential: `${c.req.param("id")}.${token}` });
});

r.delete("/devices/:id", adminOnly, async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("DELETE FROM devices WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).run();
  await audit(c.env, u.orgId, u.id, "device.delete", "device", c.req.param("id"));
  return c.json({ ok: true });
});

// ===== 履歴・アラート =====
function range(c: { req: { query: (k: string) => string | undefined } }) {
  const to = Number(c.req.query("to") ?? Date.now());
  const from = Number(c.req.query("from") ?? to - 7 * 86400_000);
  return { from, to, siteId: c.req.query("siteId") ?? null };
}

r.get("/taps", async (c) => {
  const u = c.get("user");
  const { from, to, siteId } = range(c);
  const { results } = await c.env.DB.prepare(
    `SELECT te.id, te.occurred_at, te.received_at, te.source, te.assurance, te.purpose, te.offline, t.label AS tag_label, t.kind AS tag_kind,
            us.name AS user_name, s.name AS site_name, z.name AS zone_name
       FROM tap_events te JOIN tags t ON t.id = te.tag_id JOIN users us ON us.id = te.user_id JOIN sites s ON s.id = te.site_id LEFT JOIN zones z ON z.id = te.zone_id
      WHERE te.org_id = ? AND te.occurred_at BETWEEN ? AND ? AND (? IS NULL OR te.site_id = ?)
      ORDER BY te.occurred_at DESC LIMIT 500`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all();
  return c.json(results);
});

r.get("/inspections", async (c) => {
  const u = c.get("user");
  const { from, to, siteId } = range(c);
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.result, i.note, i.checklist_json, i.photo_keys_json, i.started_at, i.completed_at, e.name AS equipment_name, us.name AS user_name, te.assurance
       FROM inspections i JOIN equipment e ON e.id = i.equipment_id JOIN users us ON us.id = i.user_id LEFT JOIN tap_events te ON te.id = i.tap_event_id
      WHERE i.org_id = ? AND i.completed_at BETWEEN ? AND ? AND (? IS NULL OR i.site_id = ?)
      ORDER BY i.completed_at DESC LIMIT 500`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all<Record<string, unknown> & { checklist_json: string; photo_keys_json: string }>();
  return c.json(results.map((x) => ({ ...x, checklist: parseJson(x.checklist_json, []), photoKeys: parseJson(x.photo_keys_json, []) })));
});

r.get("/incidents", async (c) => {
  const u = c.get("user");
  const { from, to, siteId } = range(c);
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, us.name AS user_name, e.name AS equipment_name, z.name AS zone_name
       FROM incidents i LEFT JOIN users us ON us.id = i.user_id LEFT JOIN equipment e ON e.id = i.equipment_id LEFT JOIN zones z ON z.id = i.zone_id
      WHERE i.org_id = ? AND i.occurred_at BETWEEN ? AND ? AND (? IS NULL OR i.site_id = ?)
      ORDER BY i.occurred_at DESC LIMIT 500`
  )
    .bind(u.orgId, from, to, siteId, siteId)
    .all();
  return c.json(results);
});

r.get("/alerts", async (c) => {
  const u = c.get("user");
  const open = c.req.query("open") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, us.name AS user_name, ak.name AS acked_by_name FROM alerts a LEFT JOIN users us ON us.id = a.user_id LEFT JOIN users ak ON ak.id = a.acked_by
      WHERE a.org_id = ? AND (? = 0 OR a.acked_at IS NULL) ORDER BY a.created_at DESC LIMIT 200`
  )
    .bind(u.orgId, open ? 1 : 0)
    .all();
  return c.json(results);
});

r.post("/alerts/:id/ack", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("UPDATE alerts SET acked_by = ?, acked_at = ? WHERE id = ? AND org_id = ? AND acked_at IS NULL").bind(u.id, now(), c.req.param("id"), u.orgId).run();
  return c.json({ ok: true });
});

r.get("/deadman", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.user_id, d.site_id, d.interval_sec, d.grace_sec, d.status, d.started_at, d.last_checkin_at, us.name AS user_name, s.name AS site_name
       FROM deadman_sessions d JOIN users us ON us.id = d.user_id JOIN sites s ON s.id = d.site_id
      WHERE d.org_id = ? AND d.status IN ('active','alarm') ORDER BY d.started_at DESC`
  )
    .bind(u.orgId)
    .all<{ id: string } & Record<string, unknown>>();
  const withState = await Promise.all(results.map(async (d) => ({ ...d, state: await deadmanStub(c.env, d.id).status() })));
  return c.json(withState);
});

r.get("/audit", adminOnly, async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT a.*, us.name AS actor_name FROM audit_logs a LEFT JOIN users us ON us.id = a.actor_id WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT 300"
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

export default r;
