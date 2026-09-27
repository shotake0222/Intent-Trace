// 用途別メール（パスワード案内・再設定・請求書送付）
import { fail, now } from "./app";
import { randomToken, sha256Hex } from "./crypto";
import { emailTemplate, getNotifyConfig, notify, orgBillingRecipients, getOrgPrefs } from "./notify";

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const date = (ms: number | null) => (ms ? new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "long" }).format(ms) : "—");
const baseOf = (cfgBase: string, reqUrl?: string) => cfgBase || (reqUrl ? new URL(reqUrl).origin : "");

const RESET_TTL = 60 * 60 * 1000;

/** パスワード再設定リンクを送る（有効1時間・1回限り） */
export async function sendResetMail(env: Env, reqUrl: string, subject: "user" | "ops", accountId: string, email: string, name: string) {
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO password_resets (token_hash, subject, account_id, expires_at, created_at) VALUES (?,?,?,?,?)")
    .bind(await sha256Hex(token), subject, accountId, now() + RESET_TTL, now())
    .run();
  const cfg = await getNotifyConfig(env);
  const base = baseOf(cfg.baseUrl, reqUrl);
  const url = subject === "ops" ? `${base}/ops/reset?token=${token}` : `${base}/reset-password?token=${token}`;
  const tpl = emailTemplate(
    cfg,
    "パスワード再設定のご案内",
    [`${name} 様`, "", "パスワード再設定のリクエストを受け付けました。下のボタンから1時間以内に新しいパスワードを設定してください。", "", "お心当たりがない場合は、このメールを破棄してください（パスワードは変更されません）。"],
    { label: "パスワードを再設定する", url }
  );
  const orgRow = subject === "user" ? await env.DB.prepare("SELECT org_id FROM users WHERE id = ?").bind(accountId).first<{ org_id: string }>() : null;
  await notify(env, [{ orgId: orgRow?.org_id ?? null, channel: "email", to: email, toLabel: name, eventType: "password_reset", refId: accountId, subject: "【Intent-Trace】パスワード再設定のご案内", body: tpl.text, html: tpl.html }], cfg);
}

export async function consumeResetToken(env: Env, subject: "user" | "ops", token: string) {
  const h = await sha256Hex(token);
  const r = await env.DB.prepare("SELECT account_id, expires_at, used_at FROM password_resets WHERE token_hash = ? AND subject = ?").bind(h, subject).first<{ account_id: string; expires_at: number; used_at: number | null }>();
  if (!r || r.used_at || r.expires_at < now()) fail(400, "リンクの有効期限が切れているか、既に使用されています。もう一度お手続きください", "reset_invalid");
  await env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").bind(now(), h).run();
  return r.account_id;
}

/** テナント開設時: 初期管理者へのご案内 */
export async function sendWelcomeMail(
  env: Env,
  reqUrl: string,
  a: { orgId: string; to: string; name: string; orgName: string; orgCode: string; password: string | null; trialEndsAt: number | null }
) {
  const cfg = await getNotifyConfig(env);
  const base = baseOf(cfg.baseUrl, reqUrl);
  const tpl = emailTemplate(
    cfg,
    `${a.orgName} 様 Intent-Trace ご利用開始のご案内`,
    [
      `${a.name} 様`,
      "",
      "Intent-Trace のアカウントを開設しました。下記の情報で管理画面にログインしてください。",
      "",
      `ログインID（メール）: ${a.to}`,
      ...(a.password ? [`初期パスワード: ${a.password}`] : []),
      `会社コード: ${a.orgCode}（作業員がスマホでログインする際に使います）`,
      ...(a.trialEndsAt ? [`トライアル期間: ${date(a.trialEndsAt)} まで`] : []),
      "",
      "【はじめにやること】",
      "1. ログイン後「契約・サポート」→「パスワード」で初期パスワードを変更",
      "2. 「作業員・資格」で作業員を登録",
      "3. 届いたNFCタグを設置場所に貼り、管理者のスマホでタッチして登録"
    ],
    { label: "管理画面にログイン", url: `${base}/login?next=/admin` }
  );
  const [r] = await notify(env, [{ orgId: a.orgId, channel: "email", to: a.to, toLabel: a.name, eventType: "invite", refId: a.orgId, subject: "【Intent-Trace】ご利用開始のご案内", body: tpl.text, html: tpl.html }], cfg);
  return r.status;
}

/** テナント管理者がユーザーを追加したとき（メールアドレスがある場合のみ） */
export async function sendUserInviteMail(
  env: Env,
  reqUrl: string,
  a: { orgId: string; userId: string; to: string; name: string; role: string; orgName: string; orgCode: string; employeeCode: string; secret: string; invitedBy: string }
) {
  const cfg = await getNotifyConfig(env);
  const base = baseOf(cfg.baseUrl, reqUrl);
  const worker = a.role === "worker";
  const tpl = emailTemplate(
    cfg,
    `${a.orgName} の Intent-Trace に招待されました`,
    [
      `${a.name} 様`,
      "",
      `${a.invitedBy} さんが Intent-Trace のアカウントを作成しました。`,
      "",
      ...(worker
        ? [`会社コード: ${a.orgCode}`, `社員番号: ${a.employeeCode}`, `PIN: ${a.secret}`, "", "スマホでURLを開き「作業員」タブからログインしてください。ホーム画面に追加すると便利です。"]
        : [`ログインID（メール）: ${a.to}`, `初期パスワード: ${a.secret}`, "", "ログイン後、パスワードを変更してください。"])
    ],
    { label: "ログインする", url: worker ? `${base}/login` : `${base}/login?next=/admin` }
  );
  const [r] = await notify(env, [{ orgId: a.orgId, channel: "email", to: a.to, toLabel: a.name, eventType: "invite", refId: a.userId, subject: `【Intent-Trace】${a.orgName} へのご招待`, body: tpl.text, html: tpl.html }], cfg);
  return r.status;
}

/** 請求書発行時の送付。force=false のときは組織設定で無効なら送らない */
export async function sendInvoiceMail(env: Env, reqUrl: string | undefined, invoiceId: string, force = false) {
  const inv = await env.DB.prepare(
    "SELECT i.id, i.org_id, i.number, i.period, i.total, i.due_at, i.status, o.name AS org_name FROM invoices i JOIN organizations o ON o.id = i.org_id WHERE i.id = ?"
  )
    .bind(invoiceId)
    .first<{ id: string; org_id: string; number: string; period: string; total: number; due_at: number | null; status: string; org_name: string }>();
  if (!inv || (inv.status !== "issued" && inv.status !== "paid")) return 0;
  if (!force && !(await getOrgPrefs(env, inv.org_id)).invoiceEmail) return 0;
  const cfg = await getNotifyConfig(env);
  const base = baseOf(cfg.baseUrl, reqUrl);
  const recipients = await orgBillingRecipients(env, inv.org_id);
  const tpl = emailTemplate(
    cfg,
    `${inv.period} 分 ご請求のご案内`,
    [
      `${inv.org_name} 御中`,
      "",
      "いつも Intent-Trace をご利用いただきありがとうございます。",
      `${inv.period} 分のご請求書を発行しました。`,
      "",
      `請求番号: ${inv.number}`,
      `ご請求金額: ${yen(inv.total)}（税込）`,
      `お支払期限: ${date(inv.due_at)}`,
      "",
      "請求書は管理画面の「契約・サポート」→「請求書」から表示・PDF保存できます。"
    ],
    { label: "請求書を確認する", url: `${base}/admin/account?tab=invoices` }
  );
  await notify(
    env,
    recipients.map((r) => ({ orgId: inv.org_id, channel: "email" as const, to: r.email, toLabel: r.name, eventType: "invoice", refId: inv.id, subject: `【Intent-Trace】${inv.period}分 ご請求書発行のお知らせ（${inv.number}）`, body: tpl.text, html: tpl.html })),
    cfg
  );
  return recipients.length;
}
