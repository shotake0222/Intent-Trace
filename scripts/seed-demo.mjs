#!/usr/bin/env node
// デモテナントを API 経由で作成し、過去30日分の擬似履歴 SQL を生成する
//   node scripts/seed-demo.mjs http://127.0.0.1:5173 <SETUP_TOKEN> [--history]
// 生成された seed/history.sql は `wrangler d1 execute intent-trace --local --file=seed/history.sql` で投入
import { writeFileSync, mkdirSync } from "node:fs";
import { client } from "./lib.mjs";

const [base = "http://127.0.0.1:5173", token = "dev-setup-token"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const withHistory = process.argv.includes("--history");
const api = client(base);

// 本番（公開URL）で使う場合は環境変数でパスワードを指定する（指定時は標準出力に表示しない）
const secretMode = !!process.env.ADMIN_PASSWORD;
const ADMIN = { email: process.env.ADMIN_EMAIL ?? "admin@demo.example", password: process.env.ADMIN_PASSWORD ?? "demo-admin-pass" };
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD ?? "demo-manager-pass";
const WORKER_PIN = process.env.WORKER_PIN ?? "1234";
await api.post("/api/auth/setup", {
  token,
  orgName: "多摩ビルサービス（デモ）",
  orgCode: "DEMO",
  siteName: "立川サンプルビル",
  plan: "enterprise",
  adminName: "管理 太郎",
  ...ADMIN
});
await api.post("/api/auth/login", ADMIN);
const { sites } = await api.get("/api/admin/sites");
const siteId = sites[0].id;
await api.must("POST", "/api/admin/sites", { name: "昭島物流センター", address: "東京都昭島市" });

// ゾーン（フロアマップ上の座標付き）
const zoneDefs = [
  ["B1F 機械室", "B1", 0.2, 0.75],
  ["B1F 電気室", "B1", 0.45, 0.78],
  ["1F エントランス", "1", 0.15, 0.3],
  ["1F 荷捌き場", "1", 0.55, 0.35],
  ["2F 事務所", "2", 0.8, 0.25],
  ["屋上", "R", 0.82, 0.72]
];
const zones = {};
for (const [name, floor, x, y] of zoneDefs) zones[name] = (await api.post("/api/admin/zones", { siteId, name, floor, posX: x, posY: y })).id;

// 資格
const qFork = (await api.post("/api/admin/qualifications", { code: "FORKLIFT", name: "フォークリフト運転技能講習" })).id;
const qElec = (await api.post("/api/admin/qualifications", { code: "ELEC2", name: "第二種電気工事士" })).id;

// ユーザー
const mk = (b) => api.post("/api/admin/users", b).then((r) => r.id);
const users = {
  tanaka: await mk({ role: "worker", name: "田中 一郎", employeeCode: "W001", secret: WORKER_PIN, badgeUid: "04A1B2C3D4E5F6", bleId: "100:1" }),
  sato: await mk({ role: "worker", name: "佐藤 花子", employeeCode: "W002", secret: WORKER_PIN, bleId: "100:2" }),
  suzuki: await mk({ role: "worker", name: "鈴木 次郎", employeeCode: "W003", secret: WORKER_PIN, bleId: "100:3" }),
  manager: await mk({ role: "manager", name: "現場 監督", employeeCode: "M001", email: "manager@demo.example", secret: MANAGER_PASSWORD })
};
const year = 365 * 86400_000;
await api.must("PUT", `/api/admin/users/${users.tanaka}/qualifications/${qFork}`, { certifiedAt: Date.now() - year, expiresAt: Date.now() + 2 * year });
await api.must("PUT", `/api/admin/users/${users.tanaka}/qualifications/${qElec}`, { certifiedAt: Date.now() - year, expiresAt: null });
await api.must("PUT", `/api/admin/users/${users.sato}/qualifications/${qElec}`, { certifiedAt: Date.now() - year, expiresAt: null });
// 鈴木さんはフォークリフト資格が期限切れ
await api.must("PUT", `/api/admin/users/${users.suzuki}/qualifications/${qFork}`, { certifiedAt: Date.now() - 4 * year, expiresAt: Date.now() - 30 * 86400_000 });

// 設備
const eq = async (b) => (await api.post("/api/admin/equipment", { siteId, ...b })).id;
const equipment = {
  cubicle: await eq({ name: "受変電設備（キュービクル）", category: "電気設備", model: "KB-500", zoneId: zones["B1F 電気室"], requiredQualificationId: qElec, inspectionIntervalDays: 30, checklist: ["異音・異臭がない", "表示灯が正常", "扉の施錠", "温度計の値が基準内"] }),
  panelA: await eq({ name: "分電盤 1F-A", category: "分電盤", model: "PN-20", zoneId: zones["1F エントランス"], locationNote: "エントランス東側 壁面", inspectionIntervalDays: 90, checklist: ["ブレーカーの異常なし", "盤内の清掃状態"] }),
  panelB: await eq({ name: "分電盤 1F-B", category: "分電盤", model: "PN-20", zoneId: zones["1F エントランス"], locationNote: "エントランス西側 壁面（1F-Aと同型）", inspectionIntervalDays: 90, checklist: ["ブレーカーの異常なし", "盤内の清掃状態"] }),
  extinguisher: await eq({ name: "消火器 B1-01", category: "消火器", model: "ABC-10", zoneId: zones["B1F 機械室"], inspectionIntervalDays: 30, checklist: ["圧力計が緑色範囲", "安全栓の封印", "設置位置・標識"] }),
  pump: await eq({ name: "給水ポンプ P-1", category: "給排水設備", zoneId: zones["B1F 機械室"], inspectionIntervalDays: 7, checklist: ["吐出圧力が基準内", "漏水なし", "異音・振動なし"] }),
  forklift: await eq({ name: "フォークリフト 1号機", category: "フォークリフト", model: "FD25", zoneId: zones["1F 荷捌き場"], requiredQualificationId: qFork, lockable: true, inspectionIntervalDays: 1, checklist: ["タイヤ", "フォーク・チェーン", "ブレーキ", "警報装置"] })
};

// タグ
const tag = async (b) => (await api.post("/api/admin/tags", { siteId, ...b })).id;
const tags = {
  entrance: await tag({ kind: "checkpoint", label: "1F エントランス", zoneId: zones["1F エントランス"] }),
  machine: await tag({ kind: "checkpoint", label: "B1F 機械室 入口", zoneId: zones["B1F 機械室"] }),
  electric: await tag({ kind: "checkpoint", label: "B1F 電気室 入口", zoneId: zones["B1F 電気室"] }),
  office: await tag({ kind: "checkpoint", label: "2F 事務所", zoneId: zones["2F 事務所"] }),
  // 暗号付きタグ（NXP AN12196 のテスト鍵=全ゼロ。本番では必ずタグごとに固有鍵を設定）
  roof: await tag({ kind: "checkpoint", label: "屋上 出入口（暗号タグ）", zoneId: zones["屋上"], security: "sun", uid: "04DE5F1EACC040", sunMetaKey: "0".repeat(32), sunFileKey: "0".repeat(32) }),
  cubicle: await tag({ kind: "equipment", label: "キュービクル", equipmentId: equipment.cubicle, zoneId: zones["B1F 電気室"] }),
  panelA: await tag({ kind: "equipment", label: "分電盤 1F-A", equipmentId: equipment.panelA, zoneId: zones["1F エントランス"] }),
  panelB: await tag({ kind: "equipment", label: "分電盤 1F-B", equipmentId: equipment.panelB, zoneId: zones["1F エントランス"] }),
  extinguisher: await tag({ kind: "equipment", label: "消火器 B1-01", equipmentId: equipment.extinguisher, zoneId: zones["B1F 機械室"] }),
  pump: await tag({ kind: "equipment", label: "給水ポンプ P-1", equipmentId: equipment.pump, zoneId: zones["B1F 機械室"] }),
  forklift: await tag({ kind: "equipment", label: "フォークリフト 1号機 運転席", equipmentId: equipment.forklift, zoneId: zones["1F 荷捌き場"] }),
  flTire: await tag({ kind: "procedure_step", label: "FL1 タイヤ", equipmentId: equipment.forklift, zoneId: zones["1F 荷捌き場"] }),
  flFork: await tag({ kind: "procedure_step", label: "FL1 フォーク", equipmentId: equipment.forklift, zoneId: zones["1F 荷捌き場"] }),
  flBrake: await tag({ kind: "procedure_step", label: "FL1 ブレーキ", equipmentId: equipment.forklift, zoneId: zones["1F 荷捌き場"] }),
  deadman: await tag({ kind: "deadman", label: "B1F 生存確認ポイント", zoneId: zones["B1F 機械室"] })
};

const route = (await api.post("/api/admin/routes", { siteId, name: "日常巡回（夜間）", enforceOrder: true, timeLimitMin: 40, tagIds: [tags.entrance, tags.electric, tags.machine, tags.office] })).id;
await api.post("/api/admin/routes", { siteId, name: "設備点検ルート", enforceOrder: false, tagIds: [tags.cubicle, tags.extinguisher, tags.pump, tags.panelA, tags.panelB] });
await api.post("/api/admin/procedures", {
  name: "フォークリフト始業前点検",
  equipmentId: equipment.forklift,
  unlocksEquipment: true,
  steps: [
    { tagId: tags.flTire, instruction: "タイヤの空気圧・亀裂を確認" },
    { tagId: tags.flFork, instruction: "フォーク・チェーンの損傷を確認" },
    { tagId: tags.flBrake, instruction: "ブレーキの効きを確認" }
  ]
});
const bleDev = await api.post("/api/admin/devices", { siteId, kind: "ble_receiver", name: "FL1 接近検知レシーバー", equipmentId: equipment.forklift });
const readerDev = await api.post("/api/admin/devices", { siteId, kind: "nfc_reader", name: "FL1 運転席リーダー", equipmentId: equipment.forklift, tagId: tags.forklift });

const out = { base, siteId, zones, users, equipment, tags, route, devices: { ble: bleDev.credential, reader: readerDev.credential }, admin: ADMIN };
mkdirSync("seed", { recursive: true });
writeFileSync("seed/demo-ids.json", JSON.stringify(out, null, 2));

if (withHistory) writeFileSync("seed/history.sql", history(out));

const show = (v) => (secretMode ? "（非表示）" : v);
console.log(`
デモデータを作成しました
  管理者      : ${ADMIN.email} / ${show(ADMIN.password)}
  マネージャー: manager@demo.example / ${show(MANAGER_PASSWORD)}
  作業員      : 会社コード DEMO / 社員番号 W001〜W003 / PIN ${show(WORKER_PIN)}
                （W003 鈴木 はフォークリフト資格が期限切れ）
  タグURL例   : ${base}/t/${tags.panelA}
  ID一覧      : seed/demo-ids.json${withHistory ? "\n  履歴SQL     : seed/history.sql（wrangler d1 execute で投入）" : ""}
`);

// ---------- 擬似履歴（ダッシュボード・ヒートマップ確認用） ----------
function history(o) {
  const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const uuid = () => crypto.randomUUID();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const orgRow = "(SELECT org_id FROM sites WHERE id = " + q(o.siteId) + ")";
  const lines = [];
  const workers = [o.users.tanaka, o.users.sato, o.users.suzuki];
  const eqTags = [
    [o.tags.cubicle, o.equipment.cubicle, o.zones["B1F 電気室"], 900],
    [o.tags.extinguisher, o.equipment.extinguisher, o.zones["B1F 機械室"], 180],
    [o.tags.pump, o.equipment.pump, o.zones["B1F 機械室"], 420],
    [o.tags.panelA, o.equipment.panelA, o.zones["1F エントランス"], 300],
    [o.tags.panelB, o.equipment.panelB, o.zones["1F エントランス"], 300]
  ];
  const checkpoints = [
    [o.tags.entrance, o.zones["1F エントランス"]],
    [o.tags.electric, o.zones["B1F 電気室"]],
    [o.tags.machine, o.zones["B1F 機械室"]],
    [o.tags.office, o.zones["2F 事務所"]]
  ];
  const DAY = 86400_000;
  const today0 = Math.floor((Date.now() + 9 * 3600_000) / DAY) * DAY - 9 * 3600_000;
  for (let d = 30; d >= 1; d--) {
    const day = today0 - d * DAY;
    // 夜間巡回
    const u = pick(workers);
    const runId = uuid();
    let t = day + 21 * 3600_000 + rnd(0, 1800_000);
    const done = Math.random() > 0.1;
    const n = done ? 4 : 2;
    lines.push(`INSERT INTO patrol_runs (id, org_id, route_id, user_id, status, next_seq, started_at, finished_at) VALUES (${q(runId)}, ${orgRow}, ${q(o.route)}, ${q(u)}, ${q(done ? "completed" : "abandoned")}, ${n + 1}, ${Math.round(t)}, ${Math.round(t + 30 * 60_000)});`);
    for (let i = 0; i < n; i++) {
      t += rnd(4, 10) * 60_000;
      const tapId = uuid();
      const [tagId, zoneId] = checkpoints[i];
      lines.push(`INSERT INTO tap_events (id, org_id, site_id, zone_id, tag_id, user_id, source, assurance, purpose, occurred_at, received_at, offline) VALUES (${q(tapId)}, ${orgRow}, ${q(o.siteId)}, ${q(zoneId)}, ${q(tagId)}, ${q(u)}, 'pwa_url', 'low', 'patrol', ${Math.round(t)}, ${Math.round(t)}, ${zoneId === o.zones["B1F 機械室"] ? 1 : 0});`);
      lines.push(`INSERT INTO patrol_run_visits (run_id, seq, tap_event_id, visited_at) VALUES (${q(runId)}, ${i + 1}, ${q(tapId)}, ${Math.round(t)});`);
    }
    // 設備点検
    for (const [tagId, eqId, zoneId, baseSec] of eqTags) {
      if (Math.random() > 0.35) continue;
      const w = pick(workers);
      const t0 = day + rnd(9, 17) * 3600_000;
      const tapId = uuid();
      const dur = baseSec * rnd(0.6, 1.8) * 1000;
      const res = Math.random() < 0.08 ? "ng" : Math.random() < 0.1 ? "needs_followup" : "ok";
      lines.push(`INSERT INTO tap_events (id, org_id, site_id, zone_id, tag_id, user_id, source, assurance, purpose, occurred_at, received_at) VALUES (${q(tapId)}, ${orgRow}, ${q(o.siteId)}, ${q(zoneId)}, ${q(tagId)}, ${q(w)}, 'pwa_webnfc', 'medium', 'inspection', ${Math.round(t0)}, ${Math.round(t0)});`);
      lines.push(`INSERT INTO inspections (id, org_id, site_id, equipment_id, user_id, tap_event_id, result, checklist_json, note, photo_keys_json, started_at, completed_at) VALUES (${q(uuid())}, ${orgRow}, ${q(o.siteId)}, ${q(eqId)}, ${q(w)}, ${q(tapId)}, ${q(res)}, '[]', ${q(res === "ok" ? null : "要確認箇所あり（デモ）")}, '[]', ${Math.round(t0)}, ${Math.round(t0 + dur)});`);
    }
    // BLE 接近（荷捌き場・朝夕のピークに多い）
    const k = Math.floor(rnd(0, 4));
    for (let i = 0; i < k; i++) {
      const hour = pick([8, 8, 9, 12, 13, 16, 17, 17, 18]);
      const at = day + (hour + Math.random()) * 3600_000;
      const dist = rnd(0.8, 4.5);
      const sev = dist < 2 ? "danger" : "warning";
      lines.push(`INSERT INTO incidents (id, org_id, site_id, zone_id, source, severity, user_id, equipment_id, device_id, device_event_id, distance_m, rssi, title, occurred_at, received_at) VALUES (${q(uuid())}, ${orgRow}, ${q(o.siteId)}, ${q(o.zones["1F 荷捌き場"])}, 'ble', ${q(sev)}, ${q(pick(workers))}, ${q(o.equipment.forklift)}, 'demo', ${q(uuid())}, ${dist.toFixed(1)}, ${Math.round(-50 - dist * 6)}, 'フォークリフト 1号機 への接近', ${Math.round(at)}, ${Math.round(at + 60_000)});`);
    }
    if (Math.random() < 0.3) {
      const at = day + rnd(8, 18) * 3600_000;
      const z = pick([o.zones["B1F 機械室"], o.zones["1F エントランス"], o.zones["屋上"]]);
      lines.push(`INSERT INTO incidents (id, org_id, site_id, zone_id, source, severity, user_id, title, occurred_at, received_at) VALUES (${q(uuid())}, ${orgRow}, ${q(o.siteId)}, ${q(z)}, 'manual', ${q(pick(["info", "warning", "warning"]))}, ${q(pick(workers))}, ${q(pick(["床が濡れていて滑りそうになった", "配管に頭をぶつけそうになった", "段差でつまずいた"]))}, ${Math.round(at)}, ${Math.round(at)});`);
    }
  }
  return lines.join("\n") + "\n";
}
