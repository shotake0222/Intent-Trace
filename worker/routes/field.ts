// 現場（作業員PWA）向け API
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { createRouter, body, fail, newId, now, audit, raiseAlert, broadcast, assertSiteInOrg, assertOwned, assertOwnedAll } from "../lib/app";
import { requireAuth } from "../lib/auth";
import { loadTag, evaluateAssurance } from "../lib/tags";
import { processTap } from "../lib/tap";
import {
  resolveTag,
  buildEquipmentCard,
  getEquipment,
  checkQualification,
  findRecentEquipmentTap,
  lockStub,
  deadmanStub,
  activeDeadmanFor,
  activePatrolFor,
  activeProcedureFor
} from "../lib/domain";

const r = createRouter();
r.use("*", requireAuth);

const PRESENCE_WINDOW = 30 * 60 * 1000; // 点検記録はタップから30分以内
const UNLOCK_WINDOW = 5 * 60 * 1000; // バーチャルキーはタップから5分以内

async function tagForUser(env: Env, tagId: string, orgId: string) {
  const tag = await loadTag(env, tagId);
  if (!tag) {
    // 運営から出荷済みで未登録のタグ → 管理者/マネージャーはその場で登録できる
    const stock = await env.DB.prepare("SELECT id, item_type, chip, status FROM tag_stock WHERE id = ? AND org_id = ?").bind(tagId, orgId).first<{ id: string; item_type: string; chip: string; status: string }>();
    if (stock && stock.status === "allocated") {
      throw new HTTPException(404, {
        res: Response.json({ error: "このタグはまだ設置場所に登録されていません", code: "tag_unregistered", stock: { id: stock.id, itemType: stock.item_type, chip: stock.chip } }, { status: 404 })
      });
    }
  }
  if (!tag || tag.org_id !== orgId) fail(404, "このタグは登録されていないか、別の会社のタグです");
  if (!tag.active) fail(404, "このタグは無効化されています");
  return tag;
}

// ---------- タグ（仮想ビーコン） ----------
r.get("/tags/:id", async (c) => {
  const u = c.get("user");
  const tag = await tagForUser(c.env, c.req.param("id"), u.orgId);
  return c.json(await resolveTag(c.env, tag, u.id, u.orgId));
});

r.post("/tap", async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      tagId: z.string().min(1),
      clientEventId: z.string().min(8).max(64),
      occurredAt: z.number().int(),
      source: z.enum(["pwa_url", "pwa_webnfc", "pwa_qr"]),
      sun: z.object({ picc: z.string().regex(/^[0-9A-Fa-f]{32}$/), cmac: z.string().regex(/^[0-9A-Fa-f]{16}$/) }).optional(),
      serial: z.string().max(64).optional(),
      offline: z.boolean().optional()
    })
  );
  const tag = await tagForUser(c.env, b.tagId, u.orgId);
  let a;
  if (b.source === "pwa_qr") {
    // QRはカメラで読める＝撮影・コピーで再現できるため証明レベルは常に「低」。組織設定で無効化できる
    const org = await c.env.DB.prepare("SELECT allow_qr_checkin FROM organizations WHERE id = ?").bind(u.orgId).first<{ allow_qr_checkin: number }>();
    if (!org?.allow_qr_checkin) fail(403, "この会社ではQRコードでの記録は許可されていません。NFCタグにスマホをタッチしてください", "qr_disabled");
    a = { assurance: "low" as const, sunCounter: null, warnings: ["QRコード読取で記録しました（物理タッチの証明なし）"] };
  } else {
    a = await evaluateAssurance(c.env, tag, { sun: b.sun, serial: b.serial, offline: b.offline });
  }
  const res = await processTap(c.env, {
    tag,
    user: { id: u.id, name: u.name, orgId: u.orgId },
    source: b.source,
    assurance: a.assurance,
    sunCounter: a.sunCounter,
    clientEventId: b.clientEventId,
    occurredAt: b.occurredAt,
    offline: !!b.offline,
    warnings: a.warnings,
    meta: { ua: c.req.header("user-agent")?.slice(0, 200), colo: (c.req.raw.cf as { colo?: string } | undefined)?.colo }
  });
  return c.json(res);
});

// ---------- 設備カルテ ----------
r.get("/equipment/:id", async (c) => {
  const u = c.get("user");
  return c.json(await buildEquipmentCard(c.env, c.req.param("id"), u.orgId));
});

// バーチャルキー：資格者のみ占有・起動可能
r.post("/equipment/:id/lock", async (c) => {
  const u = c.get("user");
  const e = await getEquipment(c.env, c.req.param("id"), u.orgId);
  if (!e.lockable) fail(400, "この設備はバーチャルキーの対象ではありません");
  const tap = await findRecentEquipmentTap(c.env, u.id, e.id, UNLOCK_WINDOW);
  if (!tap) fail(403, "設備のNFCタグに直接タッチしてから操作してください", "presence_required");
  const q = await checkQualification(c.env, u.id, e.required_qualification_id);
  if (!q.ok) {
    await audit(c.env, u.orgId, u.id, "equipment.unlock_denied", "equipment", e.id, { reason: q.reason });
    await raiseAlert(c.env, {
      orgId: u.orgId,
      siteId: e.site_id,
      type: "unauthorized",
      severity: "warning",
      userId: u.id,
      refId: e.id,
      message: `${u.name} さんが無資格で「${e.name}」の操作を試みました（${q.reason}）`
    });
    fail(403, q.reason, "not_qualified");
  }
  const needsProc = await c.env.DB.prepare("SELECT 1 AS x FROM procedures WHERE equipment_id = ? AND org_id = ? AND unlocks_equipment = 1 LIMIT 1").bind(e.id, u.orgId).first();
  const r1 = await lockStub(c.env, e.id).acquire({ userId: u.id, userName: u.name }, !!needsProc);
  if (!r1.ok) fail(423, r1.reason ?? "他の作業者が操作中です", "locked");
  await audit(c.env, u.orgId, u.id, "equipment.lock", "equipment", e.id, { tapEventId: tap.id });
  await broadcast(c.env, { type: "lock", siteId: e.site_id, at: now(), data: { equipmentId: e.id, equipmentName: e.name, ...r1.state } });
  return c.json({ ...r1.state, requiresProcedure: !!needsProc });
});

r.delete("/equipment/:id/lock", async (c) => {
  const u = c.get("user");
  const e = await getEquipment(c.env, c.req.param("id"), u.orgId);
  const force = u.role !== "worker" && c.req.query("force") === "1";
  const r1 = await lockStub(c.env, e.id).release(u.id, force);
  if (!r1.ok) fail(403, "他の作業者のロックは解除できません");
  await audit(c.env, u.orgId, u.id, force ? "equipment.force_unlock" : "equipment.unlock", "equipment", e.id, { previous: r1.previous });
  await broadcast(c.env, { type: "lock", siteId: e.site_id, at: now(), data: { equipmentId: e.id, equipmentName: e.name, ...r1.state } });
  return c.json(r1.state);
});

// ---------- 点検記録 ----------
r.post("/inspections", async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      equipmentId: z.string(),
      tapEventId: z.string().optional(),
      tapClientEventId: z.string().optional(), // オフライン時: 先に送られたタップの clientEventId
      clientEventId: z.string().min(8).max(64),
      result: z.enum(["ok", "ng", "needs_followup"]),
      checklist: z.array(z.object({ item: z.string(), ok: z.boolean() })).default([]),
      note: z.string().max(2000).optional(),
      photoKeys: z.array(z.string()).max(10).default([]),
      startedAt: z.number().int().optional(),
      completedAt: z.number().int().optional()
    })
  );
  const e = await getEquipment(c.env, b.equipmentId, u.orgId);
  // 冪等：オフライン再送
  const dupId = `${u.id}:${b.clientEventId}`;
  const existing = await c.env.DB.prepare("SELECT id FROM inspections WHERE id = ?").bind(await idFrom(dupId)).first<{ id: string }>();
  if (existing) return c.json({ id: existing.id, duplicate: true });

  const completedAt = b.completedAt && Math.abs(b.completedAt - Date.now()) < 7 * 86400_000 ? b.completedAt : now();
  // ゼロ距離の証明: 点検完了時刻の30分以内に、その設備タグへ本人がタッチしていること
  let tapId: string | null = null;
  if (b.tapEventId || b.tapClientEventId) {
    const t = await c.env.DB.prepare(
      `SELECT te.id, te.occurred_at FROM tap_events te JOIN tags t ON t.id = te.tag_id
        WHERE te.user_id = ? AND t.equipment_id = ? AND (te.id = ? OR te.client_event_id = ?)`
    )
      .bind(u.id, e.id, b.tapEventId ?? "", b.tapClientEventId ?? "")
      .first<{ id: string; occurred_at: number }>();
    if (t && Math.abs(completedAt - t.occurred_at) <= PRESENCE_WINDOW) tapId = t.id;
  }
  if (!tapId) {
    const recent = await findRecentEquipmentTap(c.env, u.id, e.id, PRESENCE_WINDOW);
    tapId = recent?.id ?? null;
  }
  if (!tapId && u.role === "worker") fail(403, "点検記録には設備タグへのタッチが必要です", "presence_required");

  await assertOwnedAll(c.env, "document", b.photoKeys, u.orgId);
  const id = await idFrom(dupId);
  await c.env.DB.prepare(
    `INSERT INTO inspections (id, org_id, site_id, equipment_id, user_id, tap_event_id, result, checklist_json, note, photo_keys_json, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, u.orgId, e.site_id, e.id, u.id, tapId, b.result, JSON.stringify(b.checklist), b.note ?? null, JSON.stringify(b.photoKeys), b.startedAt ?? null, completedAt)
    .run();
  if (b.result !== "ok") {
    await raiseAlert(c.env, {
      orgId: u.orgId,
      siteId: e.site_id,
      type: "inspection_ng",
      severity: b.result === "ng" ? "warning" : "info",
      userId: u.id,
      refId: id,
      message: `「${e.name}」の点検結果: ${b.result === "ng" ? "異常あり" : "要フォロー"}${b.note ? `（${b.note.slice(0, 60)}）` : ""}`
    });
  }
  await broadcast(c.env, { type: "inspection", siteId: e.site_id, at: completedAt, data: { id, equipmentId: e.id, equipmentName: e.name, result: b.result, userName: u.name } });
  return c.json({ id, duplicate: false });
});

/** clientEventId から決定的な UUID 形式IDを作る（オフライン再送の冪等性） */
async function idFrom(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const h = Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------- 巡回 ----------
r.get("/patrol/routes", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT pr.id, pr.name, pr.site_id, s.name AS site_name, pr.enforce_order, pr.time_limit_min,
            (SELECT COUNT(*) FROM patrol_route_points p WHERE p.route_id = pr.id) AS points
       FROM patrol_routes pr JOIN sites s ON s.id = pr.site_id WHERE pr.org_id = ? ORDER BY s.name, pr.name`
  )
    .bind(u.orgId)
    .all();
  return c.json(results);
});

r.get("/patrol/current", async (c) => {
  const u = c.get("user");
  const run = await activePatrolFor(c.env, u.id);
  if (!run) return c.json(null);
  const { results } = await c.env.DB.prepare(
    `SELECT p.seq, p.tag_id, t.label, z.name AS zone_name, v.visited_at
       FROM patrol_route_points p JOIN tags t ON t.id = p.tag_id LEFT JOIN zones z ON z.id = t.zone_id
       LEFT JOIN patrol_run_visits v ON v.run_id = ? AND v.seq = p.seq
      WHERE p.route_id = ? ORDER BY p.seq`
  )
    .bind(run.id, run.route_id)
    .all();
  return c.json({ runId: run.id, routeName: run.route_name, enforceOrder: !!run.enforce_order, nextSeq: run.next_seq, total: run.total, points: results });
});

r.post("/patrol/runs", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ routeId: z.string() }));
  const route = await c.env.DB.prepare("SELECT id, site_id FROM patrol_routes WHERE id = ? AND org_id = ?").bind(b.routeId, u.orgId).first<{ id: string; site_id: string }>();
  if (!route) fail(404, "巡回ルートが見つかりません");
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE patrol_runs SET status = 'abandoned', finished_at = ? WHERE user_id = ? AND status = 'in_progress'").bind(now(), u.id),
    c.env.DB.prepare("INSERT INTO patrol_runs (id, org_id, route_id, user_id, status, next_seq, started_at) VALUES (?,?,?,?,?,?,?)").bind(id, u.orgId, route.id, u.id, "in_progress", 1, now())
  ]);
  return c.json({ runId: id });
});

r.post("/patrol/runs/:id/abandon", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("UPDATE patrol_runs SET status = 'abandoned', finished_at = ? WHERE id = ? AND user_id = ? AND status = 'in_progress'").bind(now(), c.req.param("id"), u.id).run();
  return c.json({ ok: true });
});

// ---------- 作業手順（インターロック） ----------
r.get("/procedures/current", async (c) => {
  const u = c.get("user");
  const run = await activeProcedureFor(c.env, u.id);
  if (!run) return c.json(null);
  const { results } = await c.env.DB.prepare(
    "SELECT s.seq, s.instruction, s.tag_id, t.label FROM procedure_steps s JOIN tags t ON t.id = s.tag_id WHERE s.procedure_id = ? ORDER BY s.seq"
  )
    .bind(run.procedure_id)
    .all();
  return c.json({ runId: run.id, procedureName: run.procedure_name, nextSeq: run.next_seq, total: run.total, equipmentId: run.equipment_id, steps: results });
});

r.post("/procedures/:id/runs", async (c) => {
  const u = c.get("user");
  const p = await c.env.DB.prepare("SELECT id, equipment_id, unlocks_equipment, name FROM procedures WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), u.orgId)
    .first<{ id: string; equipment_id: string | null; unlocks_equipment: number; name: string }>();
  if (!p) fail(404, "手順が見つかりません");
  if (p.unlocks_equipment && p.equipment_id) {
    const st = await lockStub(c.env, p.equipment_id).status();
    if (st.lockedBy?.userId !== u.id) fail(403, "先に設備のバーチャルキーを取得してください", "lock_required");
  }
  const id = newId();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE procedure_runs SET status = 'aborted', finished_at = ? WHERE user_id = ? AND status = 'in_progress'").bind(now(), u.id),
    c.env.DB.prepare("INSERT INTO procedure_runs (id, org_id, procedure_id, user_id, status, next_seq, started_at) VALUES (?,?,?,?,?,?,?)").bind(id, u.orgId, p.id, u.id, "in_progress", 1, now())
  ]);
  await audit(c.env, u.orgId, u.id, "procedure.start", "procedure", p.id, { runId: id });
  return c.json({ runId: id });
});

r.post("/procedures/runs/:id/abort", async (c) => {
  const u = c.get("user");
  await c.env.DB.prepare("UPDATE procedure_runs SET status = 'aborted', finished_at = ? WHERE id = ? AND user_id = ? AND status = 'in_progress'").bind(now(), c.req.param("id"), u.id).run();
  return c.json({ ok: true });
});

// ---------- デッドマン・チェックイン ----------
r.get("/deadman/current", async (c) => {
  const u = c.get("user");
  const dm = await activeDeadmanFor(c.env, u.id);
  if (!dm) return c.json(null);
  const st = await deadmanStub(c.env, dm.id).status();
  return c.json(st && st.phase !== "ended" ? { sessionId: dm.id, deadlineAt: st.deadlineAt, phase: st.phase, intervalSec: st.intervalSec, graceSec: st.graceSec } : null);
});

r.post("/deadman/start", async (c) => {
  const u = c.get("user");
  const b = await body(c, z.object({ siteId: z.string(), intervalMin: z.number().int().min(1).max(240), graceMin: z.number().int().min(1).max(60).default(5) }));
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  const existing = await activeDeadmanFor(c.env, u.id);
  if (existing) {
    await deadmanStub(c.env, existing.id).end();
    await c.env.DB.prepare("UPDATE deadman_sessions SET status = 'ended', ended_at = ? WHERE id = ?").bind(now(), existing.id).run();
  }
  const id = newId();
  await c.env.DB.prepare(
    "INSERT INTO deadman_sessions (id, org_id, site_id, user_id, interval_sec, grace_sec, status, started_at, last_checkin_at) VALUES (?,?,?,?,?,?,?,?,?)"
  )
    .bind(id, u.orgId, b.siteId, u.id, b.intervalMin * 60, b.graceMin * 60, "active", now(), now())
    .run();
  const st = await deadmanStub(c.env, id).start({
    sessionId: id,
    orgId: u.orgId,
    siteId: b.siteId,
    userId: u.id,
    userName: u.name,
    intervalSec: b.intervalMin * 60,
    graceSec: b.graceMin * 60
  });
  await broadcast(c.env, { type: "deadman", siteId: b.siteId, at: now(), data: { sessionId: id, userId: u.id, userName: u.name, phase: "waiting", deadlineAt: st.deadlineAt } });
  return c.json({ sessionId: id, deadlineAt: st.deadlineAt });
});

// 画面ボタンでの応答（タグが近くにない場合の補助。証明レベルは記録されない）
r.post("/deadman/checkin", async (c) => {
  const u = c.get("user");
  const dm = await activeDeadmanFor(c.env, u.id);
  if (!dm) fail(404, "生存確認セッションがありません");
  const st = await deadmanStub(c.env, dm.id).checkin();
  return c.json({ deadlineAt: st?.deadlineAt ?? null });
});

r.post("/deadman/end", async (c) => {
  const u = c.get("user");
  const dm = await activeDeadmanFor(c.env, u.id);
  if (!dm) return c.json({ ok: true });
  await deadmanStub(c.env, dm.id).end();
  await c.env.DB.prepare("UPDATE deadman_sessions SET status = 'ended', ended_at = ? WHERE id = ?").bind(now(), dm.id).run();
  return c.json({ ok: true });
});

// ---------- ヒヤリハット報告（手動） ----------
r.post("/incidents", async (c) => {
  const u = c.get("user");
  const b = await body(
    c,
    z.object({
      clientEventId: z.string().min(8).max(64),
      siteId: z.string(),
      tagId: z.string().optional(),
      equipmentId: z.string().optional(),
      severity: z.enum(["info", "warning", "danger"]),
      title: z.string().min(1).max(200),
      note: z.string().max(2000).optional(),
      photoKeys: z.array(z.string()).max(10).default([]),
      occurredAt: z.number().int()
    })
  );
  await assertSiteInOrg(c.env, b.siteId, u.orgId);
  let zoneId: string | null = null;
  if (b.tagId) {
    const tag = await loadTag(c.env, b.tagId);
    if (tag && tag.org_id === u.orgId) zoneId = tag.zone_id ?? null;
  }
  await assertOwned(c.env, "equipment", b.equipmentId, u.orgId);
  await assertOwnedAll(c.env, "document", b.photoKeys, u.orgId);
  const id = newId();
  const t = now();
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO incidents (id, org_id, site_id, zone_id, source, severity, user_id, equipment_id, device_id, device_event_id, title, note, photo_keys_json, occurred_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(id, u.orgId, b.siteId, zoneId, "manual", b.severity, u.id, b.equipmentId ?? null, `user:${u.id}`, b.clientEventId, b.title, b.note ?? null, JSON.stringify(b.photoKeys), Math.min(b.occurredAt, t), t)
    .run();
  if (res.meta.changes === 0) return c.json({ duplicate: true });
  await broadcast(c.env, { type: "incident", siteId: b.siteId, at: t, data: { id, source: "manual", severity: b.severity, title: b.title, userName: u.name } });
  if (b.severity === "danger") {
    await raiseAlert(c.env, { orgId: u.orgId, siteId: b.siteId, type: "incident", severity: "danger", userId: u.id, refId: id, message: `ヒヤリハット報告（重大）: ${b.title}` });
  }
  return c.json({ id, duplicate: false });
});

// ---------- 作業員の今日の記録 ----------
r.get("/my/history", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT te.id, te.occurred_at, te.purpose, te.assurance, te.offline, t.label, s.name AS site_name
       FROM tap_events te JOIN tags t ON t.id = te.tag_id JOIN sites s ON s.id = te.site_id
      WHERE te.user_id = ? ORDER BY te.occurred_at DESC LIMIT 50`
  )
    .bind(u.id)
    .all();
  return c.json(results);
});

r.get("/sites", async (c) => {
  const u = c.get("user");
  const { results } = await c.env.DB.prepare("SELECT id, name, address FROM sites WHERE org_id = ? ORDER BY name").bind(u.orgId).all();
  return c.json(results);
});

export default r;
