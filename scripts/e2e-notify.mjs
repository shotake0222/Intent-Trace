#!/usr/bin/env node
// 通知・二段階認証・QR の結合テスト（ローカル。e2e-ops 実行後: 運営 ops@straid.example が存在すること）
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { client } from "./lib.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:5173";
const ids = JSON.parse(readFileSync("seed/demo-ids.json", "utf8"));
let pass = 0, failed = 0;
const check = (n, ok, x) => (ok ? (pass++, console.log(`  ✓ ${n}`)) : (failed++, console.log(`  ✗ ${n}`, x === undefined ? "" : JSON.stringify(x))));
const OPS = { email: "ops@straid.example", password: "ops-password-123" };

// RFC6238 TOTP
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32dec(s) { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/=+$/, "")) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, offset = 0) {
  const step = Math.floor(Date.now() / 30000) + offset;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", b32dec(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

const ops = client(base);
await ops.post("/api/ops/login", OPS);

console.log("通知設定（運営）");
await ops.must("PUT", "/api/ops/settings", { email_provider: "resend", email_from: "noreply@example.com", email_api_key: "re_test_dummy", line_channel_secret: "line-secret-xyz", line_channel_token: "line-token-xyz", line_bot_basic_id: "@123abcd" });
const st = await ops.get("/api/ops/settings");
check("秘密情報はマスクされて返る", st.secrets.email_api_key === true && !JSON.stringify(st).includes("re_test_dummy"), st.secrets);
check("webhook URL 表示", st.lineWebhookUrl.endsWith("/api/line/webhook"));
const test = await ops.post("/api/ops/notifications/test", { channel: "email", to: "someone@example.com" });
check("テストメールは送信試行され結果が記録される", ["sent", "failed"].includes(test.status), test);

console.log("パスワード案内メール");
const code = "N" + Date.now().toString(36).toUpperCase().slice(-6);
const created = await ops.post("/api/ops/tenants", { name: "通知テスト株式会社", code, plan: "standard", status: "active", admin: { name: "通知 太郎", email: `${code.toLowerCase()}@example.com` } });
check("テナント作成時に案内メールを送信", ["sent", "failed"].includes(created.mailStatus), created.mailStatus);
let log = await ops.get("/api/ops/notifications");
const welcome = log.find((l) => l.event_type === "invite" && l.to_address === `${code.toLowerCase()}@example.com`);
check("送信履歴に案内メール", !!welcome, log.slice(0, 3));
const detail = await ops.get(`/api/ops/notifications/${welcome.id}`);
check("案内メールに初期パスワードと会社コード", detail.body.includes(created.initialPassword) && detail.body.includes(code), detail.body.slice(0, 200));
const t = client(base);
await t.post("/api/auth/login", { email: created.adminEmail, password: created.initialPassword });
const u = await t.post("/api/admin/users", { role: "worker", name: "現場 花子", employeeCode: "W100", email: `w100.${code.toLowerCase()}@example.com`, secret: "4321" });
check("作業員追加時の招待メール（メールありの場合）", ["sent", "failed"].includes(u.mailStatus), u);

console.log("パスワード再設定（テナント管理者）");
await t.post("/api/auth/forgot", { email: created.adminEmail });
log = await ops.get("/api/ops/notifications");
const resetMail = await ops.get(`/api/ops/notifications/${log.find((l) => l.event_type === "password_reset" && l.to_address === created.adminEmail).id}`);
const token = /token=([A-Za-z0-9_-]+)/.exec(resetMail.body)?.[1];
check("再設定リンクを送信", !!token, resetMail.body.slice(0, 200));
check("存在しないメールでも同じ応答", (await client(base).req("POST", "/api/auth/forgot", { email: "nobody@example.com" })).status === 200);
check("再設定", (await client(base).req("POST", "/api/auth/reset", { token, password: "reset-pass-999" })).status === 200);
check("同じリンクは再利用不可", (await client(base).req("POST", "/api/auth/reset", { token, password: "reset-pass-000" })).status === 400);
check("旧セッションは失効", (await t.req("GET", "/api/auth/me")).status === 401);
await t.post("/api/auth/login", { email: created.adminEmail, password: "reset-pass-999" });
check("新パスワードでログイン", (await t.req("GET", "/api/auth/me")).status === 200);

console.log("請求書送付");
const period = "2026-08";
await ops.post("/api/ops/invoices/generate", { period, orgIds: [created.id] });
const inv = (await ops.get(`/api/ops/invoices?period=${period}`)).find((i) => i.org_id === created.id);
await ops.must("PATCH", `/api/ops/invoices/${inv.id}`, { status: "issued" });
log = await ops.get("/api/ops/notifications");
check("発行時に請求書メール", log.some((l) => l.event_type === "invoice" && l.org_id === created.id));
const again = await ops.post(`/api/ops/invoices/${inv.id}/send`);
check("請求書の再送", again.recipients >= 1, again);

console.log("LINE 連携（webhook）");
const lc = await t.post("/api/account/line/link-code", { personal: false });
check("連携コード発行・友だち追加URL", /^IT-[A-Z2-9]{8}$/.test(lc.code) && lc.addFriendUrl?.includes("@123abcd"), lc);
const hook = async (payload, secret = "line-secret-xyz") => {
  const raw = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(raw).digest("base64");
  return fetch(`${base}/api/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sig }, body: raw });
};
let res = await hook({ events: [{ type: "message", replyToken: "r1", source: { type: "group", groupId: "Cgroup123", userId: "U1" }, message: { type: "text", text: `連携 ${lc.code}` } }] }, "wrong");
check("不正署名は401", res.status === 401);
res = await hook({ events: [{ type: "message", replyToken: "r1", source: { type: "group", groupId: "Cgroup123", userId: "U1" }, message: { type: "text", text: `連携 ${lc.code}` } }] });
check("署名付きwebhookを受理", res.status === 200);
let ns = await t.get("/api/account/notifications");
check("グループが通知先に登録", ns.lineTargets.some((x) => x.kind === "group"), ns.lineTargets);
res = await hook({ events: [{ type: "message", replyToken: "r2", source: { type: "user", userId: "U2" }, message: { type: "text", text: lc.code } }] });
ns = await t.get("/api/account/notifications");
check("使用済みコードでは連携されない", ns.lineTargets.length === 1, ns.lineTargets);

console.log("アラート通知");
await t.must("PUT", "/api/account/notifications", { alertEmail: "warning", alertLine: "warning", extraEmails: ["safety@example.com"], invoiceEmail: true, allowQrCheckin: true });
const { sites } = await t.get("/api/admin/sites");
await t.post("/api/incidents", { clientEventId: crypto.randomUUID(), siteId: sites[0].id, severity: "danger", title: "E2E 重大ヒヤリハット", occurredAt: Date.now() });
log = await ops.get("/api/ops/notifications");
const alerts = log.filter((l) => l.event_type === "alert" && l.org_id === created.id);
check("アラートが管理者・追加宛先・LINEへ", alerts.some((a) => a.channel === "email" && a.to_address === "safety@example.com") && alerts.some((a) => a.channel === "line") && alerts.some((a) => a.to_address === created.adminEmail), alerts.map((a) => [a.channel, a.to_address]));
await t.post("/api/incidents", { clientEventId: crypto.randomUUID(), siteId: sites[0].id, severity: "danger", title: "E2E 重大ヒヤリハット", occurredAt: Date.now() });
const alerts2 = (await ops.get("/api/ops/notifications")).filter((l) => l.event_type === "alert" && l.org_id === created.id);
check("同一内容の連投は抑止", alerts2.length === alerts.length, [alerts.length, alerts2.length]);
const tt = await t.post("/api/account/notifications/test");
check("テナントからのテスト通知", tt.total >= 3, tt);
await t.must("PUT", "/api/account/notifications/me", { notifyEmail: false });
check("個人のメール受信OFF", (await t.get("/api/account/notifications")).me.notifyEmail === false);

console.log("QR");
const demo = client(base);
await demo.post("/api/auth/worker-login", { orgCode: "DEMO", employeeCode: "W001", pin: "1234" });
let q = await demo.req("POST", "/api/tap", { tagId: ids.tags.entrance, clientEventId: crypto.randomUUID(), occurredAt: Date.now(), source: "pwa_qr" });
check("QR打刻は証明レベル低で記録", q.status === 200 && q.data.assurance === "low" && q.data.warnings.some((w) => w.includes("QR")), q.data);
const dAdmin = client(base);
await dAdmin.post("/api/auth/login", ids.admin);
const pre = await dAdmin.get("/api/account/notifications");
await dAdmin.must("PUT", "/api/account/notifications", { ...pre.prefs, allowQrCheckin: false });
q = await demo.req("POST", "/api/tap", { tagId: ids.tags.entrance, clientEventId: crypto.randomUUID(), occurredAt: Date.now(), source: "pwa_qr" });
check("QR打刻を禁止できる", q.status === 403 && q.data.code === "qr_disabled", q.data);
await dAdmin.must("PUT", "/api/account/notifications", { ...pre.prefs, allowQrCheckin: true });
const lab = await dAdmin.req("GET", `/api/admin/tags/labels?siteId=${ids.siteId}`);
check("テナントのQRラベル印刷", lab.status === 200 && lab.data.includes("<svg") && lab.data.includes("src=qr") === false && lab.data.includes("B1F"), lab.status);
const opsLab = await ops.req("GET", "/api/ops/stock/labels?qr=1");
check("運営のラベルシートにQR", opsLab.status === 200 && opsLab.data.includes("<svg"));

console.log("運営の二段階認証");
const setup = await ops.post("/api/ops/2fa/setup");
check("QRと秘密鍵", setup.qrSvg.startsWith("<svg") && setup.uri.startsWith("otpauth://totp/"), setup.uri);
check("誤コードでは有効化されない", (await ops.req("POST", "/api/ops/2fa/enable", { code: "000000" })).status === 401);
const en = await ops.post("/api/ops/2fa/enable", { code: totp(setup.secret) });
check("有効化とリカバリーコード10個", en.recoveryCodes.length === 10, en);
const o2 = client(base);
const l1 = await o2.post("/api/ops/login", OPS);
check("パスワードだけではログインできない", l1.mfaRequired === true && !!l1.mfaToken && (await o2.req("GET", "/api/ops/me")).status === 401, l1);
check("誤コードは401", (await o2.req("POST", "/api/ops/login/mfa", { mfaToken: l1.mfaToken, code: "123456" })).status === 401);
// 有効化で使ったステップは再利用不可なので次のステップのコードを使う
let ok = await o2.req("POST", "/api/ops/login/mfa", { mfaToken: l1.mfaToken, code: totp(setup.secret, 1) });
check("正しいコードでログイン", ok.status === 200 && (await o2.req("GET", "/api/ops/me")).data.totpEnabled === true, ok.data);
const o3 = client(base);
const l3 = await o3.post("/api/ops/login", OPS);
check("同じコードの再利用は拒否", (await o3.req("POST", "/api/ops/login/mfa", { mfaToken: l3.mfaToken, code: totp(setup.secret, 1) })).status === 401);
ok = await o3.req("POST", "/api/ops/login/mfa", { mfaToken: l3.mfaToken, recoveryCode: en.recoveryCodes[0].toLowerCase() });
check("リカバリーコードでログイン", ok.status === 200, ok.data);
const o4 = client(base);
const l4 = await o4.post("/api/ops/login", OPS);
check("使用済みリカバリーコードは無効", (await o4.req("POST", "/api/ops/login/mfa", { mfaToken: l4.mfaToken, recoveryCode: en.recoveryCodes[0] })).status === 401);
check("残りリカバリーコード9", (await o3.get("/api/ops/me")).recoveryCodesLeft === 9);

console.log("二段階認証の必須化");
const staff = await o3.post("/api/ops/admins", { name: "新人", email: `new${Date.now()}@straid.example`, role: "staff" });
check("運営アカウント作成時に招待メール", ["sent", "failed"].includes(staff.mailStatus), staff);
await o3.must("PUT", "/api/ops/settings", { require_ops_2fa: "1" });
const sEmail = (await o3.get("/api/ops/admins")).find((a) => a.id === staff.id).email;
const sc = client(base);
await sc.post("/api/ops/login", { email: sEmail, password: staff.temporaryPassword });
const blocked = await sc.req("GET", "/api/ops/tenants");
check("未設定のスタッフは設定以外の操作不可", blocked.status === 403 && blocked.data.code === "mfa_setup_required", blocked.data);
check("me は mfaSetupRequired", (await sc.get("/api/ops/me")).mfaSetupRequired === true);
check("必須化中は自分で無効化できない", (await o3.req("POST", "/api/ops/2fa/disable", { code: totp(setup.secret, 2) })).status === 403);
await o3.must("PUT", "/api/ops/settings", { require_ops_2fa: "0" });
await o3.must("PATCH", `/api/ops/admins/${staff.id}`, { reset2fa: true });
// 後片付け: オーナーの2FAを無効化（再実行できるように）。使用済みステップより新しいコードが必要なので次の30秒枠まで待つ
const s0 = Math.floor(Date.now() / 30000);
while (Math.floor(Date.now() / 30000) === s0) await new Promise((r) => setTimeout(r, 500));
const off = await o3.req("POST", "/api/ops/2fa/disable", { code: totp(setup.secret, 1) });
check("二段階認証の無効化（現在のコードが必要）", off.status === 200, off.data);
await o3.must("PUT", "/api/ops/settings", { email_provider: "none", email_api_key: "", line_channel_secret: "", line_channel_token: "" });

console.log(`\n結果: ${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
