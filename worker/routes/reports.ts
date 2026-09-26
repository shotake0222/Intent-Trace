// 元請け・オーナー向けレポート（印刷用HTML → ブラウザでPDF保存）と CSV エクスポート
import { createRouter, fail } from "../lib/app";
import { requireAuth, requireRole } from "../lib/auth";

const r = createRouter();
r.use("*", requireAuth, requireRole("admin", "manager"));

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const fmt = (ms: number | null | undefined) =>
  ms ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(ms)) : "—";

const RESULT: Record<string, string> = { ok: "異常なし", ng: "異常あり", needs_followup: "要フォロー" };
const ASSURANCE: Record<string, string> = { high: "高（暗号検証）", medium: "中（UID照合）", low: "低（URL）" };
const SEV: Record<string, string> = { info: "情報", warning: "注意", danger: "危険" };

function monthRange(month: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) fail(400, "month は YYYY-MM 形式で指定してください");
  // JST の月初〜翌月初
  const from = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) - 9 * 3600_000;
  const to = Date.UTC(Number(m[1]), Number(m[2]), 1) - 9 * 3600_000 - 1;
  return { from, to };
}

r.get("/monthly", async (c) => {
  const u = c.get("user");
  const siteId = c.req.query("siteId");
  if (!siteId) fail(400, "siteId が必要です");
  const month = c.req.query("month") ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
  const { from, to } = monthRange(month);
  const site = await c.env.DB.prepare("SELECT s.name, s.address, o.name AS org_name FROM sites s JOIN organizations o ON o.id = s.org_id WHERE s.id = ? AND s.org_id = ?")
    .bind(siteId, u.orgId)
    .first<{ name: string; address: string | null; org_name: string }>();
  if (!site) fail(404, "現場が見つかりません");

  const [insp, patrols, incidents, tapStats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT i.completed_at, i.started_at, i.result, i.note, e.name AS equipment, us.name AS user_name, te.assurance
         FROM inspections i JOIN equipment e ON e.id=i.equipment_id JOIN users us ON us.id=i.user_id LEFT JOIN tap_events te ON te.id=i.tap_event_id
        WHERE i.site_id=? AND i.completed_at BETWEEN ? AND ? ORDER BY i.completed_at`
    )
      .bind(siteId, from, to)
      .all<Record<string, string | number | null>>(),
    c.env.DB.prepare(
      `SELECT r.started_at, r.finished_at, r.status, pr.name AS route, us.name AS user_name,
              (SELECT COUNT(*) FROM patrol_run_visits v WHERE v.run_id=r.id) visited,
              (SELECT COUNT(*) FROM patrol_route_points p WHERE p.route_id=r.route_id) total
         FROM patrol_runs r JOIN patrol_routes pr ON pr.id=r.route_id JOIN users us ON us.id=r.user_id
        WHERE pr.site_id=? AND r.started_at BETWEEN ? AND ? ORDER BY r.started_at`
    )
      .bind(siteId, from, to)
      .all<Record<string, string | number | null>>(),
    c.env.DB.prepare(
      `SELECT i.occurred_at, i.source, i.severity, i.title, i.note, us.name AS user_name, z.name AS zone
         FROM incidents i LEFT JOIN users us ON us.id=i.user_id LEFT JOIN zones z ON z.id=i.zone_id
        WHERE i.site_id=? AND i.occurred_at BETWEEN ? AND ? ORDER BY i.occurred_at`
    )
      .bind(siteId, from, to)
      .all<Record<string, string | number | null>>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) n, SUM(assurance='high') high, SUM(assurance='medium') medium, SUM(assurance='low') low FROM tap_events WHERE site_id=? AND occurred_at BETWEEN ? AND ?"
    )
      .bind(siteId, from, to)
      .first<{ n: number; high: number; medium: number; low: number }>()
  ]);

  const completedPatrols = patrols.results.filter((p) => p.status === "completed").length;
  const ngCount = insp.results.filter((i) => i.result !== "ok").length;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(site.name)} 月次報告書 ${esc(month)}</title>
<style>
  body{font-family:"Hiragino Sans","Noto Sans JP",sans-serif;color:#111;margin:32px;font-size:12px}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:14px;border-left:4px solid #0f172a;padding-left:8px;margin-top:28px}
  .meta{color:#555;margin-bottom:16px} table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f1f5f9}
  .kpi{display:flex;gap:12px;flex-wrap:wrap} .kpi div{border:1px solid #ccc;border-radius:6px;padding:8px 12px;min-width:120px}
  .kpi b{display:block;font-size:18px} .ng{color:#b91c1c;font-weight:bold} .note{color:#555;font-size:11px}
  @media print{.noprint{display:none} body{margin:12mm}}
</style></head><body>
<button class="noprint" onclick="print()" style="float:right;padding:6px 12px">印刷 / PDF保存</button>
<h1>巡回・点検 月次報告書（${esc(month)}）</h1>
<div class="meta">${esc(site.org_name)}　現場: ${esc(site.name)}${site.address ? `（${esc(site.address)}）` : ""}　出力日時: ${esc(fmt(Date.now()))}</div>
<div class="kpi">
  <div>点検件数<b>${insp.results.length}</b></div>
  <div>異常・要フォロー<b class="${ngCount ? "ng" : ""}">${ngCount}</b></div>
  <div>巡回完了<b>${completedPatrols} / ${patrols.results.length}</b></div>
  <div>ヒヤリハット<b>${incidents.results.length}</b></div>
  <div>タッチ記録<b>${tapStats?.n ?? 0}</b><span class="note">暗号検証 ${tapStats?.high ?? 0} / UID照合 ${tapStats?.medium ?? 0} / URL ${tapStats?.low ?? 0}</span></div>
</div>
<p class="note">※ 全記録は作業員が現地のNFCタグに物理的にタッチした時点の証跡（タップログ）に紐付いています。証明レベル「高」はタグ内の暗号チップによりタッチ毎に生成された一回限りの署名を検証済みであることを示します。</p>

<h2>点検記録</h2>
<table><tr><th>日時</th><th>設備</th><th>結果</th><th>担当</th><th>所要</th><th>証明</th><th>所見</th></tr>
${insp.results
  .map(
    (i) => `<tr><td>${esc(fmt(i.completed_at as number))}</td><td>${esc(i.equipment)}</td><td class="${i.result !== "ok" ? "ng" : ""}">${esc(RESULT[i.result as string] ?? i.result)}</td><td>${esc(i.user_name)}</td><td>${
      i.started_at ? `${Math.max(1, Math.round(((i.completed_at as number) - (i.started_at as number)) / 60000))}分` : "—"
    }</td><td>${esc(ASSURANCE[i.assurance as string] ?? "—")}</td><td>${esc(i.note)}</td></tr>`
  )
  .join("") || `<tr><td colspan="7">記録なし</td></tr>`}
</table>

<h2>巡回記録</h2>
<table><tr><th>開始</th><th>終了</th><th>ルート</th><th>担当</th><th>到達地点</th><th>状態</th></tr>
${patrols.results
  .map(
    (p) => `<tr><td>${esc(fmt(p.started_at as number))}</td><td>${esc(fmt(p.finished_at as number))}</td><td>${esc(p.route)}</td><td>${esc(p.user_name)}</td><td>${p.visited}/${p.total}</td><td class="${
      p.status !== "completed" ? "ng" : ""
    }">${p.status === "completed" ? "完了" : p.status === "abandoned" ? "中断" : "実施中"}</td></tr>`
  )
  .join("") || `<tr><td colspan="6">記録なし</td></tr>`}
</table>

<h2>ヒヤリハット・安全イベント</h2>
<table><tr><th>日時</th><th>区分</th><th>重要度</th><th>内容</th><th>関係者</th><th>場所</th></tr>
${incidents.results
  .map(
    (i) => `<tr><td>${esc(fmt(i.occurred_at as number))}</td><td>${esc({ ble: "BLE接近検知", manual: "報告", deadman: "生存確認", interlock: "手順違反" }[i.source as string] ?? i.source)}</td><td class="${
      i.severity === "danger" ? "ng" : ""
    }">${esc(SEV[i.severity as string])}</td><td>${esc(i.title)}${i.note ? `<div class="note">${esc(i.note)}</div>` : ""}</td><td>${esc(i.user_name ?? "—")}</td><td>${esc(i.zone ?? "—")}</td></tr>`
  )
  .join("") || `<tr><td colspan="6">記録なし</td></tr>`}
</table>
<p class="note" style="margin-top:24px">Intent-Trace により自動生成</p>
</body></html>`;
  return c.html(html);
});

r.get("/export.csv", async (c) => {
  const u = c.get("user");
  const type = c.req.query("type") ?? "taps";
  const to = Number(c.req.query("to") ?? Date.now());
  const from = Number(c.req.query("from") ?? to - 30 * 86400_000);
  const queries: Record<string, string> = {
    taps: `SELECT te.occurred_at, s.name site, z.name zone, t.label tag, us.employee_code, us.name user_name, te.purpose, te.assurance, te.source, te.offline
             FROM tap_events te JOIN tags t ON t.id=te.tag_id JOIN users us ON us.id=te.user_id JOIN sites s ON s.id=te.site_id LEFT JOIN zones z ON z.id=te.zone_id
            WHERE te.org_id=? AND te.occurred_at BETWEEN ? AND ? ORDER BY te.occurred_at`,
    inspections: `SELECT i.completed_at, s.name site, e.name equipment, us.name user_name, i.result, i.note, i.started_at
             FROM inspections i JOIN equipment e ON e.id=i.equipment_id JOIN users us ON us.id=i.user_id JOIN sites s ON s.id=i.site_id
            WHERE i.org_id=? AND i.completed_at BETWEEN ? AND ? ORDER BY i.completed_at`,
    incidents: `SELECT i.occurred_at, s.name site, i.source, i.severity, i.title, i.note, us.name user_name, i.distance_m
             FROM incidents i JOIN sites s ON s.id=i.site_id LEFT JOIN users us ON us.id=i.user_id
            WHERE i.org_id=? AND i.occurred_at BETWEEN ? AND ? ORDER BY i.occurred_at`
  };
  const sql = queries[type];
  if (!sql) fail(400, "type が不正です");
  const { results } = await c.env.DB.prepare(sql).bind(u.orgId, from, to).all<Record<string, unknown>>();
  const cols = results.length ? Object.keys(results[0]) : [];
  const cell = (v: unknown, k: string) => {
    let s = v === null || v === undefined ? "" : String(v);
    if ((k.endsWith("_at") || k === "occurred_at") && typeof v === "number") s = fmt(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "﻿" + [cols.join(","), ...results.map((row) => cols.map((k) => cell(row[k], k)).join(","))].join("\r\n");
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="intent-trace-${type}.csv"` }
  });
});

export default r;
