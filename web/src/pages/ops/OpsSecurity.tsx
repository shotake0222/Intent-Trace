// 運営: 二段階認証・通知設定・通知履歴
import { useEffect, useState } from "react";
import { useApi } from "../../lib/hooks";
import { ApiError, get, post, put } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { fmtDateTime } from "../../lib/format";

// ================= 二段階認証 =================
export function MfaCard({ onChanged }: { onChanged?: () => void }) {
  const me = useApi<{ totpEnabled: boolean; recoveryCodesLeft: number; email: string }>("/ops/me");
  const [setup, setSetup] = useState<{ secret: string; uri: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [action, setAction] = useState<"disable" | "regen" | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  if (codes)
    return (
      <Card title="リカバリーコード">
        <Alert tone="amber">
          認証アプリの端末を紛失したときに使うコードです。<b>この画面でのみ表示</b>されます。印刷するかパスワード管理ツールに保存してください（各コード1回限り）。
        </Alert>
        <div className="my-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-4 font-mono text-lg">
          {codes.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}>
            コピー
          </Button>
          <Button
            className="!bg-indigo-700"
            onClick={() => {
              setCodes(null);
              void me.reload();
              onChanged?.();
            }}
          >
            保存しました
          </Button>
        </div>
      </Card>
    );

  if (!me.data) return <Card><Empty>読み込み中…</Empty></Card>;

  if (me.data.totpEnabled)
    return (
      <Card title="二段階認証" action={<Badge tone="green">有効</Badge>}>
        <p className="text-sm text-slate-600">ログイン時に認証アプリの6桁コードが必要です。残りのリカバリーコード: {me.data.recoveryCodesLeft} 個</p>
        {action ? (
          <div className="mt-4 space-y-2">
            <Field label="認証アプリの現在のコード">
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} className="font-mono" />
            </Field>
            {err && <Alert>{err}</Alert>}
            <div className="flex gap-2">
              <Button
                variant={action === "disable" ? "danger" : "primary"}
                disabled={code.length !== 6}
                onClick={() =>
                  run(async () => {
                    if (action === "disable") {
                      await post("/ops/2fa/disable", { code });
                      onChanged?.();
                      await me.reload();
                    } else {
                      const r = await post<{ recoveryCodes: string[] }>("/ops/2fa/recovery-codes", { code });
                      setCodes(r.recoveryCodes);
                    }
                    setAction(null);
                    setCode("");
                  })
                }
              >
                {action === "disable" ? "無効化する" : "再発行する"}
              </Button>
              <Button variant="ghost" onClick={() => (setAction(null), setCode(""))}>
                キャンセル
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setAction("regen")}>
              リカバリーコードを再発行
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAction("disable")}>
              無効化
            </Button>
          </div>
        )}
      </Card>
    );

  return (
    <Card title="二段階認証" action={<Badge tone="amber">未設定</Badge>}>
      {!setup ? (
        <>
          <p className="text-sm text-slate-600">
            パスワードに加えて、スマホの認証アプリ（Google Authenticator、Microsoft Authenticator、1Password など）の6桁コードでログインを保護します。運営コンソールはすべてのテナントを操作できるため、設定を強く推奨します。
          </p>
          <Button className="mt-4 !bg-indigo-700" onClick={() => run(async () => setSetup(await post("/ops/2fa/setup")))}>
            設定を始める
          </Button>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <div className="rounded-xl bg-white p-2 ring-1 ring-slate-200" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
            <div className="space-y-2 text-sm">
              <div>
                <b>1.</b> 認証アプリで QR コードを読み取ります
              </div>
              <div className="text-xs text-slate-500">読み取れない場合は次のキーを手入力:</div>
              <div className="rounded-lg bg-slate-100 p-2 font-mono text-xs break-all">{setup.secret.replace(/(.{4})/g, "$1 ")}</div>
              <div>
                <b>2.</b> アプリに表示された6桁を入力して確認します
              </div>
            </div>
          </div>
          <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} placeholder="000000" className="text-center font-mono text-2xl tracking-[.3em]" />
          {err && <Alert>{err}</Alert>}
          <Button
            className="w-full !bg-indigo-700"
            disabled={code.length !== 6}
            onClick={() =>
              run(async () => {
                const r = await post<{ recoveryCodes: string[] }>("/ops/2fa/enable", { code });
                setSetup(null);
                setCode("");
                setCodes(r.recoveryCodes);
              })
            }
          >
            確認して有効化
          </Button>
        </div>
      )}
      {!setup && err && <div className="mt-3"><Alert>{err}</Alert></div>}
    </Card>
  );
}

// ================= 通知設定（メール・LINE） =================
interface Settings {
  email_provider: string;
  email_from: string;
  email_from_name: string;
  line_bot_basic_id: string;
  app_base_url: string;
  require_ops_2fa: string;
  secrets: Record<string, boolean>;
  lineWebhookUrl: string;
}

export function NotifySettingsCard({ owner }: { owner: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);
  const [testTo, setTestTo] = useState({ email: "", line: "" });
  const load = () => get<Settings>("/ops/settings").then((x) => (setS(x), setF({ email_provider: x.email_provider, email_from: x.email_from, email_from_name: x.email_from_name, line_bot_basic_id: x.line_bot_basic_id, app_base_url: x.app_base_url })));
  useEffect(() => {
    void load();
  }, []);
  if (!s) return <Card><Empty>読み込み中…</Empty></Card>;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const secretField = (k: string, label: string, hint?: string) => (
    <Field label={`${label}${s.secrets[k] ? "（設定済み）" : ""}`} hint={hint}>
      <Input type="password" value={f[k] ?? ""} onChange={set(k)} placeholder={s.secrets[k] ? "変更する場合のみ入力" : ""} disabled={!owner} autoComplete="off" />
    </Field>
  );
  const save = async () => {
    try {
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v !== undefined && !(["email_api_key", "line_channel_secret", "line_channel_token"].includes(k) && v === "")) payload[k] = v;
      await put("/ops/settings", payload);
      setMsg({ tone: "green", text: "通知設定を保存しました" });
      await load();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const test = async (channel: "email" | "line") => {
    try {
      const r = await post<{ status: string; last_error: string | null }>("/ops/notifications/test", { channel, to: channel === "email" ? testTo.email : testTo.line });
      setMsg({ tone: r.status === "sent" ? "green" : "amber", text: r.status === "sent" ? "送信しました" : `送信できませんでした: ${r.last_error ?? r.status}` });
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  return (
    <Card title="通知（メール・LINE）">
      <div className="space-y-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="space-y-3">
          <div className="text-sm font-bold">メール送信</div>
          <Field label="送信サービス" hint="独自ドメインがない場合は Brevo（旧Sendinblue）の送信者認証（個人メールアドレス）が手軽です。Resend / SendGrid は独自ドメインの認証を推奨">
            <Select value={f.email_provider ?? "none"} onChange={set("email_provider")} disabled={!owner}>
              <option value="none">送信しない（履歴のみ記録）</option>
              <option value="brevo">Brevo</option>
              <option value="resend">Resend</option>
              <option value="sendgrid">SendGrid</option>
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="送信元アドレス" hint="送信サービスで認証済みのアドレス">
              <Input value={f.email_from ?? ""} onChange={set("email_from")} disabled={!owner} />
            </Field>
            <Field label="送信者名">
              <Input value={f.email_from_name ?? ""} onChange={set("email_from_name")} disabled={!owner} />
            </Field>
          </div>
          {secretField("email_api_key", "APIキー")}
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <div className="text-sm font-bold">LINE（Messaging API）</div>
          <p className="text-xs text-slate-500">
            LINE Developers でプロバイダーと Messaging API チャネルを作成し、下記を設定してください。Webhook URL を登録して「Webhookの利用」をオン、応答メッセージをオフ、グループ参加を許可にします。
          </p>
          <Field label="Webhook URL（LINE Developers に登録）">
            <div className="flex gap-2">
              <Input value={s.lineWebhookUrl} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(s.lineWebhookUrl)}>
                コピー
              </Button>
            </div>
          </Field>
          <Field label="ベーシックID（@から始まるID）">
            <Input value={f.line_bot_basic_id ?? ""} onChange={set("line_bot_basic_id")} placeholder="@123abcde" disabled={!owner} />
          </Field>
          {secretField("line_channel_secret", "チャネルシークレット")}
          {secretField("line_channel_token", "チャネルアクセストークン（長期）")}
        </div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <Field label="アプリのURL（メール内リンクに使用）" hint="空欄なら最初にアクセスされたURLを自動設定">
            <Input value={f.app_base_url ?? ""} onChange={set("app_base_url")} placeholder="https://intent-trace.example.workers.dev" disabled={!owner} />
          </Field>
        </div>
        {owner && (
          <Button className="!bg-indigo-700" onClick={save}>
            通知設定を保存
          </Button>
        )}
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <div className="text-sm font-bold">テスト送信</div>
          <div className="flex gap-2">
            <Input value={testTo.email} onChange={(e) => setTestTo({ ...testTo, email: e.target.value })} placeholder="メールアドレス" />
            <Button variant="outline" disabled={!testTo.email} onClick={() => void test("email")}>
              メール
            </Button>
          </div>
          <div className="flex gap-2">
            <Input value={testTo.line} onChange={(e) => setTestTo({ ...testTo, line: e.target.value })} placeholder="LINE userId / groupId（U... / C...）" className="font-mono text-xs" />
            <Button variant="outline" disabled={!testTo.line} onClick={() => void test("line")}>
              LINE
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ================= 通知履歴 =================
interface OutRow {
  id: string;
  org_name: string | null;
  channel: string;
  to_address: string;
  to_label: string | null;
  event_type: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}
const EVENT_LABEL: Record<string, string> = {
  alert: "アラート",
  invite: "招待・案内",
  password_reset: "パスワード",
  invoice: "請求書",
  reminder_trial: "トライアル終了",
  reminder_overdue: "支払督促",
  test: "テスト",
  ops_error: "運営: エラー報告",
  ops_escalation: "運営: 通知未達"
};
export const statusBadge = (s: string) => <Badge tone={s === "sent" ? "green" : s === "failed" ? "red" : s === "skipped" ? "slate" : "blue"}>{{ sent: "送信済", failed: "失敗", skipped: "未送信（未設定）", pending: "送信待ち" }[s] ?? s}</Badge>;

export function OpsNotifications() {
  const [status, setStatus] = useState("");
  const list = useApi<OutRow[]>(`/ops/notifications${status ? `?status=${status}` : ""}`, [status]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">通知履歴</h1>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">すべて</option>
          <option value="sent">送信済</option>
          <option value="failed">失敗</option>
          <option value="skipped">未送信（未設定）</option>
          <option value="pending">送信待ち</option>
        </Select>
      </div>
      <Alert tone="blue">失敗した通知は10分ごとに自動で再送されます（最大5回）。「未送信」はメール送信サービスまたはLINEが未設定のため記録のみ行ったものです。</Alert>
      <Card>
        {!list.data?.length ? (
          <Empty>通知はまだありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">日時</th>
                  <th>種別</th>
                  <th>経路</th>
                  <th>宛先</th>
                  <th>件名</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((n) => (
                  <tr key={n.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(n.id)}>
                    <td className="py-2 whitespace-nowrap">{fmtDateTime(n.created_at)}</td>
                    <td>{EVENT_LABEL[n.event_type] ?? n.event_type}</td>
                    <td>{n.channel === "line" ? "LINE" : "メール"}</td>
                    <td className="max-w-[220px] truncate text-xs">
                      {n.to_label ? `${n.to_label} ` : ""}
                      <span className="text-slate-500">{n.channel === "line" ? "" : n.to_address}</span>
                      {n.org_name ? <div className="text-slate-400">{n.org_name}</div> : null}
                    </td>
                    <td className="max-w-xs truncate">{n.subject}</td>
                    <td>{statusBadge(n.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <OutboxDetail id={open} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
    </div>
  );
}

function OutboxDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, reload } = useApi<OutRow & { body: string }>(`/ops/notifications/${id}`, [id]);
  return (
    <Modal open onClose={onClose} title="通知の内容" wide>
      {!data ? (
        <Empty>読み込み中…</Empty>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {statusBadge(data.status)} <span className="text-slate-500">試行 {data.attempts} 回</span>
            {data.sent_at && <span className="text-slate-500">送信 {fmtDateTime(data.sent_at)}</span>}
          </div>
          {data.last_error && <Alert>{data.last_error}</Alert>}
          <div className="font-bold">{data.subject}</div>
          <pre className="max-h-[50vh] overflow-auto rounded-xl bg-slate-100 p-3 text-xs whitespace-pre-wrap">{data.body}</pre>
          {data.status !== "sent" && (
            <Button
              variant="outline"
              onClick={async () => {
                await post(`/ops/notifications/${id}/retry`);
                await reload();
                onChanged();
              }}
            >
              今すぐ再送
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

interface ErrGroup { source: string; path: string | null; message: string; n: number; last_at: number; orgs: number }
interface ErrRow { id: string; source: string; method: string | null; path: string | null; message: string; detail: string | null; user_agent: string | null; created_at: number; reported_at: number | null; org_name: string | null }
interface Undelivered { id: string; org_name: string | null; channel: string; to_label: string | null; to_address: string; subject: string; attempts: number; last_error: string | null; created_at: number; escalated_at: number | null }

export function OpsErrors() {
  const [days, setDays] = useState("7");
  const { data } = useApi<{ groups: ErrGroup[]; recent: ErrRow[]; undelivered: Undelivered[] }>(`/ops/errors?days=${days}`, [days]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = data?.recent.find((r) => r.id === open);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold whitespace-nowrap">システムエラー</h1>
        <div className="w-32">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">24時間</option>
            <option value="7">7日</option>
            <option value="30">30日</option>
          </Select>
        </div>
      </div>
      <Alert tone="blue">
        サーバー・画面で起きた想定外のエラーと、届かなかった通知を表示します。新しいエラーは10分ごとに確認し、運営のオーナーとサポート窓口へメールでまとめて通知します（1時間に1通まで）。緊急アラートの通知が失敗した場合は即時に通知します。
      </Alert>
      <Card title={`届いていない通知（${data?.undelivered.length ?? 0}件）`}>
        {!data?.undelivered.length ? (
          <Empty>ありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr className="whitespace-nowrap"><th className="py-2 pr-3">日時</th><th className="pr-3">テナント</th><th className="pr-3">宛先</th><th className="pr-3">件名</th><th className="pr-3">理由</th><th>状態</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.undelivered.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtDateTime(u.created_at)}</td>
                    <td className="pr-3 whitespace-nowrap">{u.org_name ?? "運営"}</td>
                    <td className="pr-3 text-xs whitespace-nowrap">{u.channel === "line" ? "LINE" : "メール"} {u.to_label ?? u.to_address}</td>
                    <td className={`max-w-xs truncate ${u.subject.startsWith("【緊急】") ? "font-bold text-red-700" : ""}`}>{u.subject}</td>
                    <td className="max-w-xs truncate text-xs text-slate-500">{u.last_error}</td>
                    <td className="text-xs whitespace-nowrap">{u.attempts >= 5 ? "再送終了" : `再送中（${u.attempts}回）`}{u.escalated_at ? " ・ 運営通知済" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="エラーの種類別">
        {!data?.groups.length ? (
          <Empty>エラーはありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="py-2">最終発生</th><th>場所</th><th>内容</th><th className="text-right">件数</th><th className="text-right">影響テナント</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.groups.map((g, i) => (
                  <tr key={i}>
                    <td className="py-2 whitespace-nowrap">{fmtDateTime(g.last_at)}</td>
                    <td className="text-xs"><Badge tone={g.source === "server" ? "red" : "amber"}>{g.source === "server" ? "サーバー" : "画面"}</Badge> <span className="font-mono">{g.path ?? "-"}</span></td>
                    <td className="max-w-md truncate">{g.message}</td>
                    <td className="text-right tabular-nums">{g.n}</td>
                    <td className="text-right tabular-nums">{g.orgs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="直近のエラー">
        {!data?.recent.length ? (
          <Empty>エラーはありません</Empty>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.recent.map((r) => (
              <li key={r.id} className="cursor-pointer py-2 hover:bg-slate-50" onClick={() => setOpen(r.id)}>
                <span className="mr-2 text-xs text-slate-500">{fmtDateTime(r.created_at)}</span>
                <span className="mr-2 font-mono text-xs">{r.method ?? ""} {r.path}</span>
                {r.org_name && <span className="mr-2 text-xs text-slate-500">{r.org_name}</span>}
                <span>{r.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {detail && (
        <Modal open title="エラー詳細" onClose={() => setOpen(null)} wide>
          <div className="space-y-2 text-sm">
            <div>{fmtDateTime(detail.created_at)} ・ {detail.source === "server" ? "サーバー" : "画面"} ・ {detail.org_name ?? "テナント不明"}</div>
            <div className="font-mono text-xs">{detail.method} {detail.path}</div>
            <div className="font-semibold">{detail.message}</div>
            <pre className="max-h-80 overflow-auto rounded bg-slate-900 p-3 text-[11px] text-slate-100">{detail.detail ?? "(スタックなし)"}</pre>
            <div className="text-xs text-slate-500">{detail.user_agent}</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
