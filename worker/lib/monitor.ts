// システムエラーの記録と、運営へのまとめ通知・通知失敗のエスカレーション
import { newId, now } from "./app";
import { emailTemplate, getNotifyConfig, notify, type Message } from "./notify";

export interface ErrorInfo {
  source: "server" | "client";
  method?: string | null;
  path?: string | null;
  message: string;
  detail?: string | null;
  orgId?: string | null;
  userId?: string | null;
  userAgent?: string | null;
}

const clip = (s: string | null | undefined, n: number) => (s ? String(s).slice(0, n) : null);

/** エラーを記録（記録自体の失敗で本処理を止めない） */
export async function recordError(env: Env, e: ErrorInfo) {
  try {
    await env.DB.prepare(
      "INSERT INTO error_events (id, source, method, path, message, detail, org_id, user_id, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(newId(), e.source, clip(e.method, 10), clip(e.path, 300), clip(e.message, 500) ?? "unknown", clip(e.detail, 4000), e.orgId ?? null, e.userId ?? null, clip(e.userAgent, 300), now())
      .run();
  } catch (err) {
    console.error("recordError failed", err);
  }
}

/** 運営の通知先: 設定のサポート窓口 + 有効なオーナー */
export async function opsRecipients(env: Env) {
  const cfg = await getNotifyConfig(env);
  const { results } = await env.DB.prepare("SELECT email, name FROM platform_admins WHERE active = 1 AND role = 'owner'").all<{ email: string; name: string }>();
  const list = new Map<string, string>();
  if (cfg.supportEmail) list.set(cfg.supportEmail.toLowerCase(), "サポート窓口");
  for (const r of results) list.set(r.email.toLowerCase(), r.name);
  return { cfg, recipients: [...list].map(([email, name]) => ({ email, name })) };
}

const fmt = (ms: number) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(ms);

/**
 * cron（10分ごと）:
 * 1. 未報告のシステムエラーを運営へまとめてメール（1時間に1通まで）
 * 2. 送信をあきらめた通知・届かなかった緊急アラートを運営へエスカレーション
 */
export async function runMonitor(env: Env) {
  const t = now();
  const { cfg, recipients } = await opsRecipients(env);
  const msgs: Message[] = [];
  const opsUrl = cfg.baseUrl ? `${cfg.baseUrl}/ops/errors` : undefined;

  // --- 1. システムエラー ---
  const last = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'last_error_report_at'").first<{ value: string }>();
  const lastAt = Number(last?.value ?? 0);
  const { results: errors } = await env.DB.prepare(
    `SELECT source, path, message, COUNT(*) n, MIN(created_at) first_at, MAX(created_at) last_at, COUNT(DISTINCT org_id) orgs
       FROM error_events WHERE reported_at IS NULL AND created_at > ? GROUP BY source, path, message ORDER BY n DESC LIMIT 20`
  )
    .bind(t - 7 * 86400_000)
    .all<{ source: string; path: string | null; message: string; n: number; first_at: number; last_at: number; orgs: number }>();
  let errorsReported = 0;
  if (errors.length && t - lastAt >= 60 * 60_000) {
    const total = errors.reduce((a, r) => a + r.n, 0);
    const lines = [
      `Intent-Trace でシステムエラーが ${total} 件発生しています（前回の報告以降）。`,
      "",
      ...errors.map((r) => `・[${r.source === "server" ? "サーバー" : "画面"}] ${r.path ?? "-"}  ${r.message}  ×${r.n}（${fmt(r.first_at)}〜${fmt(r.last_at)}、影響テナント ${r.orgs}社）`),
      "",
      "詳細は運営コンソール「システムエラー」で確認できます。"
    ];
    const tpl = emailTemplate(cfg, "システムエラーの発生", lines, opsUrl ? { label: "エラーを確認する", url: opsUrl } : undefined);
    for (const r of recipients)
      msgs.push({ orgId: null, channel: "email", to: r.email, toLabel: r.name, eventType: "ops_error", refId: null, subject: `【Intent-Trace 運営】システムエラー ${total}件`, body: tpl.text, html: tpl.html });
    await env.DB.batch([
      env.DB.prepare("UPDATE error_events SET reported_at = ? WHERE reported_at IS NULL AND created_at <= ?").bind(t, t),
      env.DB.prepare("INSERT INTO platform_settings (key, value) VALUES ('last_error_report_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(t))
    ]);
    errorsReported = total;
  }

  // --- 2. 通知失敗のエスカレーション ---
  // 再送上限（5回）に達したもの、または緊急アラートで1回でも失敗したもの
  const { results: undelivered } = await env.DB.prepare(
    `SELECT o.id, o.org_id, o.channel, o.to_address, o.to_label, o.event_type, o.subject, o.attempts, o.last_error, o.created_at, g.name AS org_name
       FROM notification_outbox o LEFT JOIN organizations g ON g.id = o.org_id
      WHERE o.status = 'failed' AND o.escalated_at IS NULL AND o.event_type != 'ops_error' AND o.event_type != 'ops_escalation'
        AND (o.attempts >= 5 OR (o.event_type = 'alert' AND o.subject LIKE '【緊急】%'))
      ORDER BY o.created_at LIMIT 50`
  ).all<{ id: string; org_id: string | null; channel: string; to_address: string; to_label: string | null; event_type: string; subject: string; attempts: number; last_error: string | null; created_at: number; org_name: string | null }>();
  if (undelivered.length) {
    const urgent = undelivered.some((u) => u.subject.startsWith("【緊急】"));
    const lines = [
      urgent ? "緊急アラートを含む通知が、宛先に届いていません。至急、テナントの管理者へ電話等で連絡してください。" : "再送の上限に達しても届かなかった通知があります。",
      "",
      ...undelivered.map(
        (u) =>
          `・${fmt(u.created_at)} ${u.org_name ?? "運営"}  ${u.channel === "email" ? "メール" : "LINE"} → ${u.to_label ?? u.to_address}\n  件名: ${u.subject}\n  理由: ${u.last_error ?? "不明"}（${u.attempts}回試行）`
      ),
      "",
      "送信サービスの設定・宛先を確認してください（運営コンソール「通知履歴」）。"
    ];
    const tpl = emailTemplate(cfg, urgent ? "緊急アラートが届いていません" : "通知が届いていません", lines, cfg.baseUrl ? { label: "通知履歴を確認する", url: `${cfg.baseUrl}/ops/notifications` } : undefined);
    for (const r of recipients)
      msgs.push({ orgId: null, channel: "email", to: r.email, toLabel: r.name, eventType: "ops_escalation", refId: null, subject: `【Intent-Trace 運営】${urgent ? "至急: 緊急アラートが未達" : "通知の未達"} ${undelivered.length}件`, body: tpl.text, html: tpl.html });
    await env.DB.batch(undelivered.map((u) => env.DB.prepare("UPDATE notification_outbox SET escalated_at = ? WHERE id = ?").bind(t, u.id)));
  }

  if (msgs.length) await notify(env, msgs, cfg);
  // 古いエラー記録の掃除（90日）
  await env.DB.prepare("DELETE FROM error_events WHERE created_at < ?").bind(t - 90 * 86400_000).run();
  return { errorsReported, escalated: undelivered.length };
}

/** 運営コンソール・テナント画面向け: 届いていない通知の件数 */
export async function undeliveredAlerts(env: Env, orgId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, channel, to_label, to_address, subject, last_error, attempts, created_at FROM notification_outbox
      WHERE org_id = ? AND event_type = 'alert' AND status = 'failed' AND created_at > ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(orgId, now() - 7 * 86400_000)
    .all();
  return results;
}
