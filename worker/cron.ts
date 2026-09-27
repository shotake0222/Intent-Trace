// 定期実行（Cron Trigger）: 通知の再送とリマインダー
import { retryOutbox, getNotifyConfig, notify, emailTemplate, orgBillingRecipients, type Message } from "./lib/notify";

const DAY = 86400_000;
const date = (ms: number) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "long" }).format(ms);

async function alreadySent(env: Env, eventType: string, refId: string) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM notification_outbox WHERE event_type = ? AND ref_id = ? LIMIT 1").bind(eventType, refId).first());
}

export async function runScheduled(env: Env) {
  const retry = await retryOutbox(env);
  const cfg = await getNotifyConfig(env);
  const base = cfg.baseUrl;
  const msgs: Message[] = [];
  const t = Date.now();

  // トライアル終了3日前のご案内（1回のみ）
  const { results: trials } = await env.DB.prepare("SELECT id, name, trial_ends_at FROM organizations WHERE status = 'trial' AND trial_ends_at BETWEEN ? AND ?")
    .bind(t, t + 3 * DAY)
    .all<{ id: string; name: string; trial_ends_at: number }>();
  for (const o of trials) {
    if (await alreadySent(env, "reminder_trial", o.id)) continue;
    const tpl = emailTemplate(cfg, "トライアル期間終了のお知らせ", [`${o.name} 御中`, "", `Intent-Trace のトライアル期間は ${date(o.trial_ends_at)} に終了します。`, "引き続きご利用いただく場合は、管理画面の「契約・サポート」からお問い合わせください。"], base ? { label: "契約内容を確認する", url: `${base}/admin/account` } : undefined);
    for (const r of await orgBillingRecipients(env, o.id))
      msgs.push({ orgId: o.id, channel: "email", to: r.email, toLabel: r.name, eventType: "reminder_trial", refId: o.id, subject: "【Intent-Trace】トライアル期間終了のお知らせ", body: tpl.text, html: tpl.html });
  }

  // 支払期限を過ぎた請求書（1回のみ）
  const { results: overdue } = await env.DB.prepare(
    "SELECT i.id, i.org_id, i.number, i.period, i.total, i.due_at, o.name AS org_name FROM invoices i JOIN organizations o ON o.id = i.org_id WHERE i.status = 'issued' AND i.due_at < ?"
  )
    .bind(t)
    .all<{ id: string; org_id: string; number: string; period: string; total: number; due_at: number; org_name: string }>();
  for (const i of overdue) {
    if (await alreadySent(env, "reminder_overdue", i.id)) continue;
    const tpl = emailTemplate(cfg, "お支払期限経過のご連絡", [`${i.org_name} 御中`, "", `${i.period} 分のご請求（${i.number}・¥${i.total.toLocaleString("ja-JP")}）のお支払期限（${date(i.due_at)}）を過ぎております。`, "既にお手続き済みの場合は、行き違いにつきご容赦ください。"], base ? { label: "請求書を確認する", url: `${base}/admin/account?tab=invoices` } : undefined);
    for (const r of await orgBillingRecipients(env, i.org_id))
      msgs.push({ orgId: i.org_id, channel: "email", to: r.email, toLabel: r.name, eventType: "reminder_overdue", refId: i.id, subject: `【Intent-Trace】お支払期限経過のご連絡（${i.number}）`, body: tpl.text, html: tpl.html });
  }
  await notify(env, msgs, cfg);
  // 期限切れの連携コード・再設定トークンの掃除
  await env.DB.batch([
    env.DB.prepare("DELETE FROM line_link_codes WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(t - DAY)
  ]);
  return { retry, reminders: msgs.length };
}
