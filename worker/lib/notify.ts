// 通知（メール / LINE Messaging API）
// すべての送信は notification_outbox に記録し、失敗分は cron で再送する。
import { newId, now, parseJson } from "./app";
import { openSecret, sealSecret, enc, bytesToHex } from "./crypto";
import type { Severity } from "../../shared/types";

export type EmailProvider = "none" | "resend" | "brevo" | "sendgrid";

export interface NotifyConfig {
  provider: EmailProvider;
  from: string;
  fromName: string;
  emailApiKey: string | null;
  lineToken: string | null;
  lineSecret: string | null;
  lineBasicId: string;
  baseUrl: string;
  companyName: string;
  supportEmail: string;
}

/** 秘密情報（APIキー等）は platform_settings に "secret:<name>" として AES-GCM で封印保存 */
export const SECRET_SETTINGS = ["email_api_key", "line_channel_secret", "line_channel_token"] as const;
export type SecretSetting = (typeof SECRET_SETTINGS)[number];

export async function putSecretSetting(env: Env, key: SecretSetting, value: string) {
  if (!value) {
    await env.DB.prepare("DELETE FROM platform_settings WHERE key = ?").bind(`secret:${key}`).run();
    return;
  }
  await env.DB.prepare("INSERT INTO platform_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(`secret:${key}`, await sealSecret(value, env.TAG_KEY_SECRET))
    .run();
}

export async function getNotifyConfig(env: Env): Promise<NotifyConfig> {
  const { results } = await env.DB.prepare("SELECT key, value FROM platform_settings").all<{ key: string; value: string }>();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const secret = async (k: SecretSetting) => (s[`secret:${k}`] ? await openSecret(s[`secret:${k}`], env.TAG_KEY_SECRET).catch(() => null) : null);
  return {
    provider: (s.email_provider as EmailProvider) || "none",
    from: s.email_from ?? "",
    fromName: s.email_from_name || "Intent-Trace",
    emailApiKey: await secret("email_api_key"),
    lineToken: await secret("line_channel_token"),
    lineSecret: await secret("line_channel_secret"),
    lineBasicId: s.line_bot_basic_id ?? "",
    baseUrl: (s.app_base_url ?? "").replace(/\/$/, ""),
    companyName: s.company_name ?? "",
    supportEmail: s.support_email ?? ""
  };
}

/** リクエスト元のURLを記録（cron / Durable Object から送るメールのリンク生成に使う） */
export async function rememberBaseUrl(env: Env, reqUrl: string) {
  const origin = new URL(reqUrl).origin;
  if (origin.includes("localhost") || origin.includes("127.0.0.1")) return;
  await env.DB.prepare("UPDATE platform_settings SET value = ? WHERE key = 'app_base_url' AND value = ''").bind(origin).run();
}

// ---------- テンプレート ----------
const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function emailTemplate(cfg: NotifyConfig, title: string, lines: string[], cta?: { label: string; url: string }) {
  const footer = [`―――`, `${cfg.companyName || "Intent-Trace"}`, cfg.supportEmail ? `お問い合わせ: ${cfg.supportEmail}` : "", "※ このメールは送信専用アドレスから送信しています。"].filter(Boolean);
  const text = [title, "", ...lines, ...(cta ? ["", `${cta.label}: ${cta.url}`] : []), "", ...footer].join("\n");
  const html = `<!doctype html><html lang="ja"><body style="margin:0;background:#f1f5f9;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="font-weight:bold;font-size:14px;color:#b45309;margin-bottom:12px">◎ Intent-Trace</div>
<div style="background:#fff;border-radius:16px;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${escHtml(title)}</h1>
${lines.map((l) => (l ? `<p style="margin:0 0 8px;line-height:1.7;font-size:14px">${escHtml(l)}</p>` : `<div style="height:8px"></div>`)).join("")}
${cta ? `<p style="margin:24px 0 0"><a href="${escHtml(cta.url)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:bold">${escHtml(cta.label)}</a></p>` : ""}
</div>
<p style="font-size:12px;color:#64748b;line-height:1.6;margin-top:16px">${footer.map(escHtml).join("<br>")}</p>
</div></body></html>`;
  return { text, html };
}

// ---------- 送信 ----------
async function withTimeout(url: string, init: RequestInit, ms = 8000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

async function sendEmail(cfg: NotifyConfig, to: string, subject: string, text: string, html: string | null): Promise<"sent" | "skipped"> {
  if (cfg.provider === "none" || !cfg.emailApiKey || !cfg.from) return "skipped";
  let res: Response;
  if (cfg.provider === "resend") {
    res = await withTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.emailApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${cfg.fromName} <${cfg.from}>`, to: [to], subject, text, html: html ?? undefined })
    });
  } else if (cfg.provider === "brevo") {
    res = await withTimeout("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": cfg.emailApiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: cfg.from, name: cfg.fromName }, to: [{ email: to }], subject, textContent: text, htmlContent: html ?? undefined })
    });
  } else {
    res = await withTimeout("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.emailApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.from, name: cfg.fromName },
        subject,
        content: [{ type: "text/plain", value: text }, ...(html ? [{ type: "text/html", value: html }] : [])]
      })
    });
  }
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return "sent";
}

async function lineApi(cfg: NotifyConfig, path: string, payload: unknown) {
  if (!cfg.lineToken) throw new Error("LINE チャネルアクセストークンが未設定です");
  const res = await withTimeout(`https://api.line.me/v2/bot/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.lineToken}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`LINE ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendLine(cfg: NotifyConfig, to: string, text: string): Promise<"sent" | "skipped"> {
  if (!cfg.lineToken) return "skipped";
  await lineApi(cfg, "message/push", { to, messages: [{ type: "text", text: text.slice(0, 4900) }] });
  return "sent";
}

export async function lineReply(cfg: NotifyConfig, replyToken: string, text: string) {
  await lineApi(cfg, "message/reply", { replyToken, messages: [{ type: "text", text }] });
}

export interface Message {
  orgId: string | null;
  channel: "email" | "line";
  to: string;
  toLabel?: string | null;
  eventType: string;
  refId?: string | null;
  subject: string;
  body: string;
  html?: string | null;
}

interface OutboxRow {
  id: string;
  channel: "email" | "line";
  to_address: string;
  subject: string;
  body: string;
  html: string | null;
  attempts: number;
}

async function deliver(env: Env, cfg: NotifyConfig, row: OutboxRow) {
  try {
    const r = row.channel === "email" ? await sendEmail(cfg, row.to_address, row.subject, row.body, row.html) : await sendLine(cfg, row.to_address, row.body);
    await env.DB.prepare("UPDATE notification_outbox SET status = ?, attempts = attempts + 1, sent_at = ?, last_error = ? WHERE id = ?")
      .bind(r, r === "sent" ? now() : null, r === "skipped" ? (row.channel === "email" ? "メール送信サービスが未設定" : "LINE連携が未設定") : null, row.id)
      .run();
    return r;
  } catch (e) {
    await env.DB.prepare("UPDATE notification_outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").bind(String(e).slice(0, 500), row.id).run();
    return "failed" as const;
  }
}

/** 通知を記録して即時送信（失敗しても例外にしない。cron で再送） */
export async function notify(env: Env, messages: Message[], cfg?: NotifyConfig) {
  if (!messages.length) return [];
  const config = cfg ?? (await getNotifyConfig(env));
  const t = now();
  const rows: OutboxRow[] = messages.map((m) => ({ id: newId(), channel: m.channel, to_address: m.to, subject: m.subject, body: m.body, html: m.html ?? null, attempts: 0 }));
  await env.DB.batch(
    messages.map((m, i) =>
      env.DB.prepare(
        "INSERT INTO notification_outbox (id, org_id, channel, to_address, to_label, event_type, ref_id, subject, body, html, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(rows[i].id, m.orgId, m.channel, m.to, m.toLabel ?? null, m.eventType, m.refId ?? null, m.subject, m.body, m.html ?? null, "pending", t)
    )
  );
  const results = [];
  for (const r of rows) results.push({ id: r.id, status: await deliver(env, config, r) });
  return results;
}

/** cron: 失敗・未送信の再送（最大5回、指数的に間隔を空ける） */
export async function retryOutbox(env: Env) {
  const cfg = await getNotifyConfig(env);
  const { results } = await env.DB.prepare(
    `SELECT id, channel, to_address, subject, body, html, attempts, created_at FROM notification_outbox
      WHERE status IN ('pending','failed') AND attempts < 5 AND created_at > ? ORDER BY created_at LIMIT 50`
  )
    .bind(now() - 2 * 86400_000)
    .all<OutboxRow & { created_at: number }>();
  let sent = 0;
  for (const r of results) {
    if (r.attempts > 0 && now() - r.created_at < 2 ** r.attempts * 60_000) continue;
    if ((await deliver(env, cfg, r)) === "sent") sent++;
  }
  return { checked: results.length, sent };
}

// ---------- 用途別ヘルパ ----------
const SEV_RANK: Record<string, number> = { info: 0, warning: 1, danger: 2, off: 9 };

export interface OrgNotifyPrefs {
  alertEmail: Severity | "off";
  alertLine: Severity | "off";
  extraEmails: string[];
  invoiceEmail: boolean;
}
export const DEFAULT_PREFS: OrgNotifyPrefs = { alertEmail: "danger", alertLine: "warning", extraEmails: [], invoiceEmail: true };

export async function getOrgPrefs(env: Env, orgId: string): Promise<OrgNotifyPrefs> {
  const r = await env.DB.prepare("SELECT notify_json FROM organizations WHERE id = ?").bind(orgId).first<{ notify_json: string | null }>();
  return { ...DEFAULT_PREFS, ...parseJson<Partial<OrgNotifyPrefs>>(r?.notify_json, {}) };
}

const SEV_LABEL: Record<string, string> = { info: "お知らせ", warning: "注意", danger: "緊急" };

/** アラート発生時: 組織の設定に従い管理者メール・LINE（個人/グループ）へ通知 */
export async function notifyAlert(env: Env, a: { orgId: string; siteId: string; severity: Severity; type: string; message: string; alertId: string }) {
  const prefs = await getOrgPrefs(env, a.orgId);
  const rank = SEV_RANK[a.severity];
  const wantEmail = rank >= SEV_RANK[prefs.alertEmail];
  const wantLine = rank >= SEV_RANK[prefs.alertLine];
  if (!wantEmail && !wantLine) return;
  const cfg = await getNotifyConfig(env);
  const site = await env.DB.prepare("SELECT name FROM sites WHERE id = ?").bind(a.siteId).first<{ name: string }>();
  const siteName = site?.name ?? "";
  const url = cfg.baseUrl ? `${cfg.baseUrl}/admin` : "";
  const subject = `【${SEV_LABEL[a.severity]}】${siteName} ${a.message}`.slice(0, 150);
  const msgs: Message[] = [];
  // 同じ内容を短時間に連投しない（デッドマンの再通知は5分間隔なので3分で抑止）
  const recent = await env.DB.prepare("SELECT to_address FROM notification_outbox WHERE org_id = ? AND event_type = 'alert' AND subject = ? AND created_at > ?")
    .bind(a.orgId, subject, now() - 3 * 60_000)
    .all<{ to_address: string }>();
  const already = new Set(recent.results.map((r) => r.to_address));

  if (wantEmail) {
    const { results } = await env.DB.prepare("SELECT name, email FROM users WHERE org_id = ? AND role IN ('admin','manager') AND active = 1 AND notify_email = 1 AND email IS NOT NULL")
      .bind(a.orgId)
      .all<{ name: string; email: string }>();
    const recipients = new Map<string, string>(results.map((u) => [u.email, u.name]));
    for (const e of prefs.extraEmails) if (!recipients.has(e)) recipients.set(e, "");
    const tpl = emailTemplate(cfg, subject, [`現場: ${siteName}`, `内容: ${a.message}`, `発生: ${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium" }).format(now())}`], url ? { label: "ダッシュボードを開く", url } : undefined);
    for (const [email, name] of recipients) {
      if (already.has(email)) continue;
      msgs.push({ orgId: a.orgId, channel: "email", to: email, toLabel: name, eventType: "alert", refId: a.alertId, subject, body: tpl.text, html: tpl.html });
    }
  }
  if (wantLine) {
    const { results } = await env.DB.prepare("SELECT line_id, display_name, min_severity FROM line_targets WHERE org_id = ? AND active = 1")
      .bind(a.orgId)
      .all<{ line_id: string; display_name: string | null; min_severity: string }>();
    const icon = a.severity === "danger" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️";
    const text = `${icon}【${SEV_LABEL[a.severity]}】${siteName}\n${a.message}${url ? `\n\n${url}` : ""}`;
    for (const t of results) {
      if (rank < SEV_RANK[t.min_severity] || already.has(t.line_id)) continue;
      msgs.push({ orgId: a.orgId, channel: "line", to: t.line_id, toLabel: t.display_name, eventType: "alert", refId: a.alertId, subject, body: text });
    }
  }
  await notify(env, msgs, cfg);
}

/** 管理者・マネージャー宛（請求書・リマインダー等）の宛先 */
export async function orgBillingRecipients(env: Env, orgId: string) {
  const o = await env.DB.prepare("SELECT billing_email, contact_email, contact_name FROM organizations WHERE id = ?").bind(orgId).first<{ billing_email: string | null; contact_email: string | null; contact_name: string | null }>();
  const set = new Map<string, string>();
  if (o?.billing_email) set.set(o.billing_email, "ご請求担当者");
  if (o?.contact_email) set.set(o.contact_email, o.contact_name ?? "");
  if (!set.size) {
    const { results } = await env.DB.prepare("SELECT name, email FROM users WHERE org_id = ? AND role = 'admin' AND active = 1 AND email IS NOT NULL").bind(orgId).all<{ name: string; email: string }>();
    for (const u of results) set.set(u.email, u.name);
  }
  return [...set].map(([email, name]) => ({ email, name }));
}

// ---------- LINE webhook 署名検証 ----------
export async function verifyLineSignature(secret: string, rawBody: string, signature: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
  let b = "";
  for (const x of mac) b += String.fromCharCode(x);
  const expected = btoa(b);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export function sixDigitCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export { bytesToHex };
