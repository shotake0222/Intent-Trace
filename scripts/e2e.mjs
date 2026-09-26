#!/usr/bin/env node
// 主要フローの結合テスト（seed-demo.mjs 実行後に使用）
//   node scripts/e2e.mjs http://127.0.0.1:5173
import { readFileSync } from "node:fs";
import { client } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const ids = JSON.parse(readFileSync("seed/demo-ids.json", "utf8"));
let pass = 0;
let failCount = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}
const cid = () => crypto.randomUUID();
const tap = (api, tagId, extra = {}) => api.req("POST", "/api/tap", { tagId, clientEventId: cid(), occurredAt: Date.now(), source: "pwa_url", ...extra });

const tanaka = client(base);
const suzuki = client(base);
const admin = client(base);

console.log("認証");
check("PIN誤りは401", (await tanaka.req("POST", "/api/auth/worker-login", { orgCode: "DEMO", employeeCode: "W001", pin: "9999" })).status === 401);
await tanaka.post("/api/auth/worker-login", { orgCode: "demo", employeeCode: "W001", pin: "1234" });
await suzuki.post("/api/auth/worker-login", { orgCode: "DEMO", employeeCode: "W003", pin: "1234" });
await admin.post("/api/auth/login", ids.admin);
const me = await tanaka.get("/api/auth/me");
check("作業員ログイン & 資格取得", me.name === "田中 一郎" && me.qualifications.length === 2, me);
check("作業員は管理APIに403", (await tanaka.req("GET", "/api/admin/users")).status === 403);
check("未ログインは401", (await client(base).req("GET", "/api/auth/me")).status === 401);
check("CSRF: 別オリジンのPOSTは403", (await tanaka.req("POST", "/api/tap", {}, { origin: "https://evil.example" })).status === 403);

console.log("タップ・証明レベル");
let r = await tap(tanaka, ids.tags.entrance);
check("静的URLタップ = low", r.status === 200 && r.data.assurance === "low", r.data);
const dupId = cid();
const first = await tanaka.req("POST", "/api/tap", { tagId: ids.tags.office, clientEventId: dupId, occurredAt: Date.now(), source: "pwa_url" });
const dup = await tanaka.req("POST", "/api/tap", { tagId: ids.tags.office, clientEventId: dupId, occurredAt: Date.now(), source: "pwa_url" });
check("同一clientEventIdは冪等", dup.data.duplicate === true && dup.data.tapEventId === first.data.tapEventId, dup.data);

console.log("NTAG 424 DNA SUN");
r = await tap(tanaka, ids.tags.roof);
check("SUNタグにパラメータ無しは403", r.status === 403 && r.data.code === "sun_required", r.data);
r = await tap(tanaka, ids.tags.roof, { sun: { picc: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337087" } });
check("CMAC改ざんは403", r.status === 403 && r.data.code === "sun_invalid", r.data);
r = await tap(tanaka, ids.tags.roof, { sun: { picc: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337086" } });
check("正しいSUNは high", r.status === 200 && r.data.assurance === "high", r.data);
r = await tap(tanaka, ids.tags.roof, { sun: { picc: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337086" } });
check("同じURLの再利用（リプレイ）は409", r.status === 409 && r.data.code === "sun_replay", r.data);
r = await tap(suzuki, ids.tags.roof, { sun: { picc: "EF963FF7828658A599F3041510671E88", cmac: "94EED9EE65337086" }, offline: true });
check("オフライン再送でも使用済みカウンタは拒否", r.status === 409, r.data);

console.log("巡回");
const routes = await tanaka.get("/api/patrol/routes");
const night = routes.find((x) => x.name.startsWith("日常巡回"));
await tanaka.post("/api/patrol/runs", { routeId: night.id });
r = await tap(tanaka, ids.tags.entrance);
check("巡回1地点目", r.data.patrol?.nextSeq === 2, r.data);
r = await tap(tanaka, ids.tags.machine);
check("順序違反を検出（記録は残る）", r.data.warnings.includes("巡回順序違反"), r.data);
await tap(tanaka, ids.tags.electric);
r = await tap(tanaka, ids.tags.office);
check("全地点で巡回完了", r.data.patrol?.status === "completed", r.data);

console.log("点検（ゼロ距離の証明）");
r = await tanaka.req("POST", "/api/inspections", { equipmentId: ids.equipment.cubicle, clientEventId: cid(), result: "ok", checklist: [] });
check("タグ未タッチの点検は403", r.status === 403 && r.data.code === "presence_required", r.data);
const t1 = await tap(tanaka, ids.tags.cubicle);
const insp = { equipmentId: ids.equipment.cubicle, tapEventId: t1.data.tapEventId, clientEventId: cid(), result: "ng", checklist: [{ item: "異音・異臭がない", ok: false }], note: "E2E: 異音あり", startedAt: Date.now() - 120000 };
r = await tanaka.req("POST", "/api/inspections", insp);
check("タッチ後の点検記録OK", r.status === 200 && !r.data.duplicate, r.data);
r = await tanaka.req("POST", "/api/inspections", insp);
check("点検の再送は冪等", r.data.duplicate === true, r.data);
const card = await tanaka.get(`/api/equipment/${ids.equipment.cubicle}`);
check("設備カルテに前回点検が反映", card.lastInspection?.result === "ng", card.lastInspection);

console.log("オフライン: 後から届いたタップ → 点検");
const offTap = cid();
const tapAt = Date.now() - 20 * 60_000;
r = await tanaka.req("POST", "/api/tap", { tagId: ids.tags.pump, clientEventId: offTap, occurredAt: tapAt, source: "pwa_url", offline: true });
check("20分前のオフラインタップを受理（時刻保持）", r.status === 200, r.data);
r = await tanaka.req("POST", "/api/inspections", { equipmentId: ids.equipment.pump, tapClientEventId: offTap, clientEventId: cid(), result: "ok", checklist: [], startedAt: tapAt, completedAt: tapAt + 5 * 60_000 });
check("tapClientEventId で紐付く点検を受理", r.status === 200, r.data);

console.log("バーチャルキー・資格判定");
r = await suzuki.req("POST", `/api/equipment/${ids.equipment.forklift}/lock`);
check("タッチ前のキー取得は403", r.status === 403 && r.data.code === "presence_required", r.data);
await tap(suzuki, ids.tags.forklift);
r = await suzuki.req("POST", `/api/equipment/${ids.equipment.forklift}/lock`);
check("資格期限切れの鈴木さんは拒否", r.status === 403 && r.data.code === "not_qualified", r.data);
await tap(tanaka, ids.tags.forklift);
r = await tanaka.req("POST", `/api/equipment/${ids.equipment.forklift}/lock`);
check("有資格の田中さんはキー取得（手順待ち）", r.status === 200 && r.data.armed === false && r.data.requiresProcedure === true, r.data);
const bleDev = ids.devices.ble;
const devApi = client(base);
r = await devApi.req("GET", "/api/device/lock-state", undefined, { authorization: `Device ${bleDev}` });
check("重機側: 手順完了前は ignition=false", r.data.ignition === false, r.data);

console.log("手順インターロック");
const eqCard = await tanaka.get(`/api/equipment/${ids.equipment.forklift}`);
const proc = eqCard.procedures.find((p) => p.unlocksEquipment);
await tanaka.post(`/api/procedures/${proc.id}/runs`);
r = await tap(tanaka, ids.tags.flBrake);
check("手順スキップを検出", r.data.procedure?.ok === false, r.data);
r = await tap(tanaka, ids.tags.flTire);
check("手順1完了", r.data.procedure?.ok === true && r.data.procedure.nextSeq === 2, r.data);
await tap(tanaka, ids.tags.flFork);
r = await tap(tanaka, ids.tags.flBrake);
check("全手順完了で起動許可", r.data.procedure?.status === "completed", r.data);
r = await devApi.req("GET", "/api/device/lock-state", undefined, { authorization: `Device ${bleDev}` });
check("重機側: ignition=true", r.data.ignition === true && r.data.lockedBy?.userName === "田中 一郎", r.data);
r = await suzuki.req("DELETE", `/api/equipment/${ids.equipment.forklift}/lock`);
check("他人のキーは返却できない", r.status === 403, r.data);
r = await tanaka.req("DELETE", `/api/equipment/${ids.equipment.forklift}/lock`);
check("本人はキー返却", r.status === 200 && r.data.lockedBy === null, r.data);

console.log("プランB: 固定リーダー × スマート社員証");
r = await devApi.req("POST", "/api/device/badge-tap", { badgeUid: "04:A1:B2:C3:D4:E5:F6", eventId: "e2e-1", action: "unlock" }, { authorization: `Device ${ids.devices.reader}` });
check("社員証で資格判定しキー発行", r.data.allow === true && r.data.userName === "田中 一郎" && r.data.ignition === false, r.data);
r = await devApi.req("POST", "/api/device/badge-tap", { badgeUid: "FFFFFFFF", eventId: "e2e-2", action: "unlock" }, { authorization: `Device ${ids.devices.reader}` });
check("未登録社員証は拒否", r.data.allow === false && r.data.reason === "unknown_badge", r.data);
await devApi.req("POST", "/api/device/badge-tap", { badgeUid: "04A1B2C3D4E5F6", eventId: "e2e-3", action: "release" }, { authorization: `Device ${ids.devices.reader}` });
check("不正なデバイス認証は401", (await devApi.req("GET", "/api/device/lock-state", undefined, { authorization: "Device dev_x.bad" })).status === 401);

console.log("BLE接近ログ");
const evId = cid();
r = await devApi.req(
  "POST",
  "/api/device/proximity",
  { events: [{ eventId: evId, bleId: "100:2", rssi: -48, distanceM: 1.2, level: "danger", braked: false, occurredAt: Date.now() - 5000, durationMs: 3200 }] },
  { authorization: `Device ${bleDev}` }
);
check("接近イベントを取り込み", r.data.inserted === 1, r.data);
r = await devApi.req("POST", "/api/device/proximity", { events: [{ eventId: evId, rssi: -48, level: "danger", occurredAt: Date.now() }] }, { authorization: `Device ${bleDev}` });
check("接近イベント再送は重複排除", r.data.inserted === 0, r.data);

console.log("デッドマン");
r = await tanaka.req("POST", "/api/deadman/start", { siteId: ids.siteId, intervalMin: 1, graceMin: 1 });
check("生存確認開始", r.status === 200 && r.data.deadlineAt > Date.now(), r.data);
const d1 = r.data.deadlineAt;
await new Promise((res) => setTimeout(res, 1100));
r = await tap(tanaka, ids.tags.deadman);
check("タグタッチで期限延長", r.data.deadman?.deadlineAt > d1, r.data);
const dmList = await admin.get("/api/admin/deadman");
check("管理画面に単独作業者が表示", dmList.some((d) => d.user_name === "田中 一郎"), dmList.length);
await tanaka.post("/api/deadman/end");

console.log("ヒヤリハット・分析・レポート");
r = await tanaka.req("POST", "/api/incidents", { clientEventId: cid(), siteId: ids.siteId, severity: "danger", title: "E2E: 落下物", occurredAt: Date.now() });
check("ヒヤリハット報告", r.status === 200, r.data);
const alerts = await admin.get("/api/admin/alerts?open=1");
check("アラート生成（無資格・異常・接近・重大報告）", ["unauthorized", "inspection_ng", "proximity", "incident", "interlock_violation"].every((t) => alerts.some((a) => a.type === t)), alerts.map((a) => a.type));
const sum = await admin.get(`/api/analytics/summary?siteId=${ids.siteId}`);
check("サマリー集計", sum.taps.total > 20 && sum.incidents.total > 0, { taps: sum.taps, inc: sum.incidents });
const heat = await admin.get(`/api/analytics/heatmap?siteId=${ids.siteId}`);
check("ヒートマップ（Pro）", heat.zones.length === 6 && heat.dowHour.length === 7, heat.zones.length);
const durs = await admin.get(`/api/analytics/inspection-durations?siteId=${ids.siteId}`);
check("点検所要時間", durs.length > 0, durs.length);
const month = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
r = await admin.req("GET", `/api/reports/monthly?siteId=${ids.siteId}&month=${month}`);
check("月次報告書HTML", r.status === 200 && r.data.includes("月次報告書"), r.status);
r = await admin.req("GET", "/api/reports/export.csv?type=inspections");
check("CSVエクスポート", r.status === 200 && r.data.includes("equipment"), r.status);

console.log("ファイル（R2）");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const up = await fetch(`${base}/api/files?kind=manual&equipmentId=${ids.equipment.cubicle}`, {
  method: "POST",
  headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent("キュービクル取扱説明書.pdf"), cookie: (await loginCookie()), origin: base },
  body: pdf
}).then((x) => x.json());
check("マニュアルPDFアップロード", !!up.id, up);
const card2 = await tanaka.get(`/api/equipment/${ids.equipment.cubicle}`);
check("設備カルテにマニュアル表示", card2.documents.some((d) => d.filename === "キュービクル取扱説明書.pdf"), card2.documents);
r = await tanaka.req("GET", `/api/files/${up.id}`);
check("作業員がマニュアル閲覧", r.status === 200, r.status);
r = await tanaka.req("POST", "/api/files?kind=manual", undefined, { "content-type": "application/pdf" });
check("作業員はマニュアル登録不可", r.status === 403, r.status);

console.log(`\n結果: ${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);

async function loginCookie() {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(ids.admin) });
  return res.headers.getSetCookie()[0].split(";")[0];
}
