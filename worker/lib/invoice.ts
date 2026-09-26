// 請求書（印刷用HTML）。運営画面・テナント画面の双方から利用
import { fail, parseJson } from "./app";
import { getSettings } from "./platform";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const date = (ms: number | null) => (ms ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "long" }).format(ms) : "—");

export async function renderInvoice(env: Env, invoiceId: string, orgId?: string) {
  const inv = await env.DB.prepare(
    `SELECT i.*, o.name AS org_name, o.address AS org_address, o.contact_name FROM invoices i JOIN organizations o ON o.id = i.org_id
      WHERE i.id = ? AND (? IS NULL OR i.org_id = ?)`
  )
    .bind(invoiceId, orgId ?? null, orgId ?? null)
    .first<{
      id: string;
      number: string;
      period: string;
      items_json: string;
      subtotal: number;
      tax: number;
      total: number;
      status: string;
      issued_at: number | null;
      due_at: number | null;
      paid_at: number | null;
      org_name: string;
      org_address: string | null;
      contact_name: string | null;
    }>();
  if (!inv) fail(404, "請求書が見つかりません");
  if (orgId && inv.status === "draft") fail(404, "請求書が見つかりません");
  const s = await getSettings(env);
  const items = parseJson<{ label: string; qty: number; unit: number; amount: number }[]>(inv.items_json, []);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>請求書 ${esc(inv.number)}</title>
<style>
body{font-family:"Hiragino Sans","Noto Sans JP",sans-serif;color:#111;margin:40px;font-size:13px}
h1{text-align:center;letter-spacing:.5em;font-size:24px;margin-bottom:32px}
.row{display:flex;justify-content:space-between;gap:24px}
.to{font-size:16px;border-bottom:1px solid #111;padding-bottom:4px;min-width:280px}
.total{margin:24px 0;font-size:20px;border:2px solid #111;display:inline-block;padding:8px 16px}
table{width:100%;border-collapse:collapse;margin-top:12px} th,td{border:1px solid #999;padding:6px 8px} th{background:#f1f5f9}
td.n{text-align:right} .muted{color:#555;font-size:12px} .stamp{color:#b91c1c;font-weight:bold;border:2px solid #b91c1c;padding:2px 8px;display:inline-block;transform:rotate(-8deg)}
@media print{.noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="print()" style="float:right;padding:6px 12px">印刷 / PDF保存</button>
<h1>請求書</h1>
<div class="row">
  <div>
    <div class="to">${esc(inv.org_name)} 御中</div>
    ${inv.contact_name ? `<div class="muted" style="margin-top:4px">${esc(inv.contact_name)} 様</div>` : ""}
    <div class="total">ご請求金額 ${yen(inv.total)}（税込）</div>
    <div>対象期間: ${esc(inv.period)}　お支払期限: ${esc(date(inv.due_at))}</div>
  </div>
  <div style="text-align:right">
    <div>請求番号: ${esc(inv.number)}</div>
    <div>発行日: ${esc(date(inv.issued_at))}</div>
    <div style="margin-top:12px;font-weight:bold">${esc(s.company_name)}</div>
    <div class="muted">${esc(s.company_address)}</div>
    ${s.invoice_registration_no ? `<div class="muted">登録番号: ${esc(s.invoice_registration_no)}</div>` : ""}
    ${inv.status === "paid" ? `<div style="margin-top:8px"><span class="stamp">入金済 ${esc(date(inv.paid_at))}</span></div>` : ""}
  </div>
</div>
<table>
<tr><th>内容</th><th>数量</th><th>単価</th><th>金額</th></tr>
${items.map((i) => `<tr><td>${esc(i.label)}</td><td class="n">${i.qty}</td><td class="n">${yen(i.unit)}</td><td class="n">${yen(i.amount)}</td></tr>`).join("")}
<tr><td colspan="3" class="n">小計</td><td class="n">${yen(inv.subtotal)}</td></tr>
<tr><td colspan="3" class="n">消費税（${esc(s.tax_rate ?? "10")}%）</td><td class="n">${yen(inv.tax)}</td></tr>
<tr><td colspan="3" class="n"><b>合計</b></td><td class="n"><b>${yen(inv.total)}</b></td></tr>
</table>
${s.bank_info ? `<p style="margin-top:24px"><b>お振込先</b><br>${esc(s.bank_info).replace(/\n/g, "<br>")}</p>` : ""}
<p class="muted">※ 振込手数料は貴社にてご負担ください。</p>
</body></html>`;
}
