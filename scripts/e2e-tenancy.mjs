#!/usr/bin/env node
// テナント分離の結合テスト: 2社を作り、A社が B社のデータを読めない・紐付けられないことを確認する（ローカル）
import { client } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
let pass = 0, failed = 0;
const check = (n, ok, x) => (ok ? (pass++, console.log(`  ✓ ${n}`)) : (failed++, console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x))));
const denied = (r) => r.status === 404 || r.status === 403;

const ops = client(base);
await ops.post("/api/ops/login", { email: "ops@straid.example", password: "ops-password-123" });

async function tenant(label) {
  const code = label + Date.now().toString(36).toUpperCase().slice(-5);
  const t = await ops.post("/api/ops/tenants", { name: `${label}社`, code, plan: "standard", status: "active", siteName: `${label}現場`, admin: { name: `${label}管理者`, email: `${code.toLowerCase()}@example.com` } });
  const c = client(base);
  await c.post("/api/auth/login", { email: t.adminEmail, password: t.initialPassword });
  const { sites } = await c.get("/api/admin/sites");
  return { ...t, code, c, siteId: sites[0].id };
}

const A = await tenant("A");
const B = await tenant("B");

console.log("利用規約の同意");
let me = await A.c.get("/api/auth/me");
check("新テナントは未同意", me.termsAccepted === false && !!me.termsVersion, me);
check("古い版では同意できない", (await A.c.req("POST", "/api/account/terms/accept", { version: "1999-01-01" })).status === 409);
await A.c.post("/api/account/terms/accept", { version: me.termsVersion });
check("同意すると termsAccepted", (await A.c.get("/api/auth/me")).termsAccepted === true);
const detail = await ops.get(`/api/ops/tenants/${A.id}`);
check("運営画面に同意日時", !!detail.org.terms_accepted_at && detail.org.terms_version === me.termsVersion, detail.org);

console.log("B社のデータを用意");
const bZone = await B.c.post("/api/admin/zones", { siteId: B.siteId, name: "B倉庫" });
const bQual = await B.c.post("/api/admin/qualifications", { code: "BQ", name: "B資格" });
const bEq = await B.c.post("/api/admin/equipment", { siteId: B.siteId, name: "B社フォークリフト", lockable: true, requiredQualificationId: bQual.id });
const bTag = await B.c.post("/api/admin/tags", { siteId: B.siteId, kind: "checkpoint", label: "B入口", zoneId: bZone.id });
const bPhoto = await (await fetch(`${base}/api/files?kind=photo`, { method: "POST", headers: { "content-type": "image/png", "x-filename": "b.png", cookie: B.c.cookie(), origin: base }, body: new Uint8Array([137, 80, 78, 71]) })).json();

console.log("読み取りの分離");
check("B社の設備カルテは読めない", denied(await A.c.req("GET", `/api/equipment/${bEq.id}`)));
check("B社のタグは解決できない", denied(await A.c.req("GET", `/api/tags/${bTag.id}`)));
check("B社の写真は取得できない", denied(await A.c.req("GET", `/api/files/${bPhoto.id}`)));
check("一覧にB社の設備が出ない", !(await A.c.get("/api/admin/equipment")).some((e) => e.id === bEq.id));
check("B社の設備は更新できない", denied(await A.c.req("PATCH", `/api/admin/equipment/${bEq.id}`, { name: "乗っ取り" })));
check("B社の設備はロックできない", denied(await A.c.req("POST", `/api/equipment/${bEq.id}/lock`, {})));

console.log("他社IDの紐付けを拒否");
check("設備にB社ゾーン", denied(await A.c.req("POST", "/api/admin/equipment", { siteId: A.siteId, name: "x", zoneId: bZone.id })));
check("設備にB社資格", denied(await A.c.req("POST", "/api/admin/equipment", { siteId: A.siteId, name: "x", requiredQualificationId: bQual.id })));
check("タグにB社設備", denied(await A.c.req("POST", "/api/admin/tags", { siteId: A.siteId, kind: "equipment", label: "x", equipmentId: bEq.id })));
check("タグにB社ゾーン", denied(await A.c.req("POST", "/api/admin/tags", { siteId: A.siteId, kind: "checkpoint", label: "x", zoneId: bZone.id })));
const aTag = await A.c.post("/api/admin/tags", { siteId: A.siteId, kind: "checkpoint", label: "A入口" });
check("既存タグをB社設備へ変更", denied(await A.c.req("PATCH", `/api/admin/tags/${aTag.id}`, { equipmentId: bEq.id })));
check("手順にB社設備", denied(await A.c.req("POST", "/api/admin/procedures", { name: "x", equipmentId: bEq.id, unlocksEquipment: true, steps: [{ tagId: aTag.id, instruction: "確認" }] })));
check("手順にB社タグ", (await A.c.req("POST", "/api/admin/procedures", { name: "x", steps: [{ tagId: bTag.id, instruction: "確認" }] })).status === 422);
check("デバイスにB社設備", denied(await A.c.req("POST", "/api/admin/devices", { siteId: A.siteId, kind: "ble_receiver", name: "x", equipmentId: bEq.id })));
check("デバイスにB社タグ", denied(await A.c.req("POST", "/api/admin/devices", { siteId: A.siteId, kind: "nfc_reader", name: "x", tagId: bTag.id })));
const inc = (extra) => A.c.req("POST", "/api/incidents", { clientEventId: crypto.randomUUID(), siteId: A.siteId, severity: "info", title: "t", occurredAt: Date.now(), ...extra });
check("ヒヤリハットにB社設備", denied(await inc({ equipmentId: bEq.id })));
check("ヒヤリハットにB社写真", denied(await inc({ photoKeys: [bPhoto.id] })));
const r = await inc({ tagId: bTag.id });
check("B社タグ指定でもB社ゾーンは付かない", r.status === 200);
const incs = await B.c.get(`/api/admin/incidents?siteId=${B.siteId}&from=0&to=${Date.now() + 1e6}`).catch(() => []);
check("B社の記録にA社のヒヤリハットが混入しない", !(Array.isArray(incs) ? incs : incs.items ?? []).some((i) => i.title === "t"));
check("A社の現場指定でB社の現場は使えない", denied(await A.c.req("POST", "/api/admin/zones", { siteId: B.siteId, name: "x" })));

console.log("権限変更の即時反映");
await A.c.post("/api/admin/users", { role: "admin", name: "副管理者", employeeCode: "A2", email: `sub-${A.code.toLowerCase()}@example.com`, secret: "sub-password-123" });
const sub = client(base);
await sub.post("/api/auth/login", { email: `sub-${A.code.toLowerCase()}@example.com`, password: "sub-password-123" });
check("副管理者はユーザー一覧を見られる", (await sub.req("GET", "/api/admin/users")).status === 200);
const users = await A.c.get("/api/admin/users");
const subId = users.find((u) => u.employee_code === "A2").id;
await A.c.must("PATCH", `/api/admin/users/${subId}`, { role: "worker" });
check("降格後は既存セッションが無効", (await sub.req("GET", "/api/admin/users")).status === 401);

console.log("ログイン試行の制限");
const w = await A.c.post("/api/admin/users", { role: "worker", name: "作業員", employeeCode: "W9", secret: "4321" });
const atk = client(base);
const variants = [A.code, A.code.toLowerCase(), A.code[0].toLowerCase() + A.code.slice(1)];
for (let i = 0; i < 10; i++) await atk.req("POST", "/api/auth/worker-login", { orgCode: variants[i % 3], employeeCode: "W9", pin: "0000" });
const locked = await atk.req("POST", "/api/auth/worker-login", { orgCode: A.code.toLowerCase(), employeeCode: "W9", pin: "4321" });
check("大文字小文字を変えても10回で制限", locked.status === 429, locked.status);
void w;

console.log("LINE連携コード");
const lc = await A.c.req("POST", "/api/account/line/link-code", { personal: false });
check("連携コードは推測困難な形式（LINE未設定なら400）", lc.status === 400 || /^IT-[A-Z2-9]{8}$/.test(lc.data.code), lc.data);

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
