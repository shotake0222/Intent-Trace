#!/usr/bin/env node
// エラー時の挙動の結合テスト（ローカル、seed-demo・e2e-ops 後）
import { readFileSync } from "node:fs";
import { client } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const ids = JSON.parse(readFileSync("seed/demo-ids.json", "utf8"));
let pass = 0, failed = 0;
const check = (n, ok, x) => (ok ? (pass++, console.log(`  ✓ ${n}`)) : (failed++, console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x))));

const ops = client(base);
await ops.post("/api/ops/login", { email: "ops@straid.example", password: "ops-password-123" });
const admin = client(base);
await admin.post("/api/auth/login", ids.admin);
const worker = client(base);
await worker.post("/api/auth/worker-login", { orgCode: "DEMO", employeeCode: "W001", pin: "1234" });

console.log("画面エラーの報告");
const marker = `E2E画面エラー ${Date.now()}`;
const ce = await worker.req("POST", "/api/client-errors", { message: marker, stack: "Error: x\n at y", path: "/t/abc" });
check("報告を受け付ける", ce.status === 200, ce);
const errs = await ops.get("/api/ops/errors?days=1");
check("運営のシステムエラーに表示", errs.recent.some((e) => e.message === marker && e.source === "client" && e.org_name), errs.recent.slice(0, 2));
check("テナントは運営のエラー一覧を見られない", (await admin.req("GET", "/api/ops/errors")).status === 401);

console.log("運営へのまとめ通知（cron）");
await fetch(`${base}/cdn-cgi/handler/scheduled`);
const log = await ops.get("/api/ops/notifications");
check("エラー報告メールが記録される", log.some((l) => l.event_type === "ops_error" && l.org_id === null), log.slice(0, 3).map((l) => l.event_type));
const errs2 = await ops.get("/api/ops/errors?days=1");
const recentReport = log.some((l) => l.event_type === "ops_error" && Date.now() - l.created_at < 60 * 60_000);
check("報告済みになる（直近1時間に報告済みなら次回まとめて）", errs2.recent.find((e) => e.message === marker)?.reported_at > 0 || recentReport);

console.log("送信を拒否された現場記録");
const clientId = crypto.randomUUID();
const rej = { clientId, kind: "inspection", payload: { siteId: ids.siteId, equipmentId: ids.equipment.forklift, result: "ng", note: "E2E 拒否記録", occurredAt: Date.now() - 60_000 }, photoCount: 2, error: "点検記録には設備タグへのタッチが必要です", errorCode: "presence_required", occurredAt: Date.now() - 60_000 };
check("作業員の端末から預けられる", (await worker.post("/api/rejected", rej)).duplicate === false);
check("同じ記録は重複しない", (await worker.post("/api/rejected", rej)).duplicate === true);
const odd = await worker.req("POST", "/api/rejected", { ...rej, clientId: crypto.randomUUID(), payload: { siteId: "no-such-site", note: "E2E 不明な現場" } });
check("不明な現場IDでも受け付ける（現場は紐付けない）", odd.status === 200, odd);
let list = await admin.get("/api/admin/rejected");
const row = list.find((r) => r.payload.note === "E2E 拒否記録");
check("不明な現場の記録は現場名なしで表示", list.some((r) => r.payload.note === "E2E 不明な現場" && r.site_name === null));
check("管理者の画面に表示", !!row && row.user_name && row.photo_count === 2 && row.error_code === "presence_required", row);
check("作業員は一覧を見られない", (await worker.req("GET", "/api/admin/rejected")).status === 403);
await admin.post(`/api/admin/rejected/${row.id}/resolve`, { resolution: "再点検を依頼" });
list = await admin.get("/api/admin/rejected");
check("確認済みにすると未対応一覧から消える", !list.some((r) => r.id === row.id));
check("履歴には残る", (await admin.get("/api/admin/rejected?all=1")).some((r) => r.id === row.id && r.resolution === "再点検を依頼"));

console.log("届かなかった通知");
const ud = await admin.req("GET", "/api/admin/undelivered-alerts");
check("テナント向けの未達一覧", ud.status === 200 && Array.isArray(ud.data));

console.log("IoT連携はオプション");
const plans = await ops.get("/api/ops/plans");
const f = (code) => JSON.parse(plans.find((p) => p.code === code)?.features_json ?? "[]");
check("スタンダード・プロにIoT連携は含まない", !f("standard").includes("devices") && !f("pro").includes("devices"), [f("standard"), f("pro")]);
check("エンタープライズには含む", f("enterprise").includes("devices"));

console.log(`\n結果: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
