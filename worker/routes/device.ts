// IoT デバイス API（プランB：固定NFCリーダー / 重機側BLEレシーバー）
// 認証: Authorization: Device <deviceId>.<token>
import { z } from "zod";
import { createRouter, body, fail, newId, now, raiseAlert, broadcast, audit } from "../lib/app";
import { requireDevice } from "../lib/auth";
import { loadTag } from "../lib/tags";
import { processTap } from "../lib/tap";
import { lockStub, checkQualification, getEquipment } from "../lib/domain";

const r = createRouter();
r.use("*", requireDevice);

r.post("/heartbeat", async (c) => {
  const d = c.get("device");
  return c.json({ ok: true, serverTime: now(), deviceId: d.id });
});

/**
 * 重機コントローラ用：起動許可状態の取得。
 * 「ロック保持者がいて、かつ手順インターロック完了(armed)」のときのみ ignition=true。
 * ※ 物理安全（接近ブレーキ）はこの API に依存せずローカルで完結させること。
 */
r.get("/lock-state", async (c) => {
  const d = c.get("device");
  if (!d.equipmentId) fail(400, "このデバイスは設備に紐付いていません");
  const st = await lockStub(c.env, d.equipmentId).status();
  return c.json({ equipmentId: d.equipmentId, ...st, ignition: !!st.lockedBy && st.armed, serverTime: now() });
});

/**
 * 固定リーダーでスマート社員証をタッチ（プランB）。
 * リーダー自体が設置場所のタグを代理する。設備に紐付くリーダーなら資格判定してバーチャルキーを発行。
 */
r.post("/badge-tap", async (c) => {
  const d = c.get("device");
  if (d.kind !== "nfc_reader") fail(400, "NFCリーダーではありません");
  const b = await body(c, z.object({ badgeUid: z.string().min(4).max(32), eventId: z.string().min(4).max(64), occurredAt: z.number().int().optional(), action: z.enum(["tap", "unlock", "release"]).default("tap") }));
  if (!d.tagId) fail(400, "リーダーに地点タグが設定されていません");
  const tag = await loadTag(c.env, d.tagId);
  if (!tag || tag.org_id !== d.orgId) fail(404, "地点タグが見つかりません");
  const uid = b.badgeUid.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  const user = await c.env.DB.prepare("SELECT id, name, org_id FROM users WHERE org_id = ? AND badge_uid = ? AND active = 1")
    .bind(d.orgId, uid)
    .first<{ id: string; name: string; org_id: string }>();
  if (!user) {
    await raiseAlert(c.env, { orgId: d.orgId, siteId: d.siteId, type: "unknown_badge", severity: "warning", refId: d.id, message: `未登録の社員証がリーダー「${d.name}」にタッチされました (${uid})` });
    return c.json({ allow: false, reason: "unknown_badge" });
  }
  const occurredAt = b.occurredAt ?? now();
  const tapRes = await processTap(c.env, {
    tag,
    user: { id: user.id, name: user.name, orgId: user.org_id },
    source: "reader",
    assurance: "high",
    sunCounter: null,
    clientEventId: `dev:${d.id}:${b.eventId}`.slice(0, 64),
    occurredAt,
    offline: Math.abs(occurredAt - now()) > 60_000,
    warnings: [],
    meta: { deviceId: d.id }
  });

  let allow = true;
  let reason: string | undefined;
  let ignition = false;
  const eqId = tag.equipment_id;
  if (eqId && b.action !== "tap") {
    const e = await getEquipment(c.env, eqId, d.orgId);
    if (b.action === "release") {
      const rel = await lockStub(c.env, eqId).release(user.id);
      allow = rel.ok;
      reason = rel.ok ? undefined : "not_owner";
    } else if (e.lockable) {
      const q = await checkQualification(c.env, user.id, e.required_qualification_id);
      if (!q.ok) {
        allow = false;
        reason = "not_qualified";
        await audit(c.env, d.orgId, user.id, "equipment.unlock_denied", "equipment", eqId, { reason: q.reason, deviceId: d.id });
        await raiseAlert(c.env, { orgId: d.orgId, siteId: d.siteId, type: "unauthorized", severity: "warning", userId: user.id, refId: eqId, message: `${user.name} さんが無資格で「${e.name}」の起動を試みました（${q.reason}）` });
      } else {
        const needsProc = await c.env.DB.prepare("SELECT 1 AS x FROM procedures WHERE equipment_id = ? AND unlocks_equipment = 1 LIMIT 1").bind(eqId).first();
        const acq = await lockStub(c.env, eqId).acquire({ userId: user.id, userName: user.name }, !!needsProc);
        allow = acq.ok;
        reason = acq.ok ? undefined : "locked_by_other";
        ignition = acq.ok && acq.state.armed;
        if (acq.ok) await audit(c.env, d.orgId, user.id, "equipment.lock", "equipment", eqId, { deviceId: d.id });
      }
    }
    const st = await lockStub(c.env, eqId).status();
    await broadcast(c.env, { type: "lock", siteId: d.siteId, at: now(), data: { equipmentId: eqId, equipmentName: e.name, ...st } });
  }
  return c.json({ allow, reason: reason ?? null, ignition, userName: user.name, tapEventId: tapRes.tapEventId });
});

/**
 * BLE 接近イベントのバッチ送信（重機側レシーバー）。
 * 警報・ブレーキはレシーバーがローカルで即時に行い、ここにはログだけが後から届く。
 */
r.post("/proximity", async (c) => {
  const d = c.get("device");
  if (d.kind !== "ble_receiver") fail(400, "BLEレシーバーではありません");
  const b = await body(
    c,
    z.object({
      events: z
        .array(
          z.object({
            eventId: z.string().min(1).max(64),
            bleId: z.string().max(64).optional(),
            rssi: z.number().int().min(-127).max(20),
            distanceM: z.number().min(0).max(100).optional(),
            level: z.enum(["caution", "danger"]),
            braked: z.boolean().default(false),
            occurredAt: z.number().int(),
            durationMs: z.number().int().min(0).optional()
          })
        )
        .max(200)
    })
  );
  const t = now();
  let inserted = 0;
  const equipmentName = d.equipmentId ? (await c.env.DB.prepare("SELECT name FROM equipment WHERE id = ?").bind(d.equipmentId).first<{ name: string }>())?.name : null;
  for (const ev of b.events) {
    const user = ev.bleId
      ? await c.env.DB.prepare("SELECT id, name FROM users WHERE org_id = ? AND ble_id = ?").bind(d.orgId, ev.bleId).first<{ id: string; name: string }>()
      : null;
    const severity = ev.level === "danger" ? "danger" : "warning";
    const title = `${equipmentName ?? d.name} への接近${ev.braked ? "（自動停止作動）" : ""}`;
    const id = newId();
    const occurredAt = ev.occurredAt > t + 60_000 ? t : ev.occurredAt;
    const res = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO incidents (id, org_id, site_id, source, severity, user_id, equipment_id, device_id, device_event_id, distance_m, rssi, title, note, occurred_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, d.orgId, d.siteId, "ble", severity, user?.id ?? null, d.equipmentId, d.id, ev.eventId, ev.distanceM ?? null, ev.rssi, title, ev.durationMs ? `接近継続 ${Math.round(ev.durationMs / 1000)} 秒` : null, occurredAt, t)
      .run();
    if (res.meta.changes === 0) continue;
    inserted++;
    await broadcast(c.env, { type: "incident", siteId: d.siteId, at: occurredAt, data: { id, source: "ble", severity, title, userName: user?.name ?? null, distanceM: ev.distanceM ?? null } });
    if (severity === "danger") {
      await raiseAlert(c.env, { orgId: d.orgId, siteId: d.siteId, type: "proximity", severity: "danger", userId: user?.id, refId: id, message: `${user?.name ?? "作業員"} が ${equipmentName ?? d.name} に危険距離まで接近しました` });
    }
  }
  return c.json({ received: b.events.length, inserted });
});

export default r;
