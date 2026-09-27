// 契約・請求・お知らせ・サポート・パスワード（テナント管理者）
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Qr } from "../../components/Qr";
import { useApi } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { ApiError, del, patch, post, put } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Stat, Textarea, cx } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { FEATURE_LABEL, INVOICE_STATUS_LABEL, ORG_STATUS_LABEL, TICKET_CATEGORY_LABEL, TICKET_STATUS_LABEL, fmtAgo, fmtDate, fmtDateTime, parsePlanFeatures, yen } from "../../lib/format";

interface ContractRes {
  org: { code: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null; billing_email: string | null; address: string | null; contract_started_at: number | null };
  contract: { status: string; trialEndsAt: number | null; plan: { code: string; name: string; features: string[] }; limits: { tags: number | null; users: number | null; sites: number | null } };
  usage: { tags: number; users: number; sites: number; devices: number; stock_unregistered: number };
  estimate: { items: { label: string; qty: number; unit: number; amount: number }[]; subtotal: number; tax: number; total: number };
  plans: { code: string; name: string; monthly_fee: number; fee_per_tag: number; fee_per_user: number; included_tags: number; included_users: number; max_tags: number | null; max_users: number | null; features_json: string }[];
  support: { email: string; company: string };
}

type Tab = "contract" | "invoices" | "notify" | "support" | "security";

export default function AccountAdmin() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (["contract", "invoices", "notify", "support", "security"].includes(sp.get("tab") ?? "") ? (sp.get("tab") as Tab) : "contract"));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">契約・サポート</h1>
      <div className="flex w-fit flex-wrap rounded-xl bg-white p-1 text-sm font-semibold ring-1 ring-slate-200">
        {(
          [
            ["contract", "契約・プラン"],
            ["invoices", "請求書"],
            ["notify", "通知（メール・LINE）"],
            ["support", "お問い合わせ"],
            ["security", "パスワード"]
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("rounded-lg px-3 py-1.5", tab === k ? "bg-slate-900 text-white" : "text-slate-600")}>
            {l}
          </button>
        ))}
      </div>
      {tab === "contract" && <ContractTab onConsult={() => setTab("support")} />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "notify" && <NotifyTab />}
      {tab === "support" && <SupportTab />}
      {tab === "security" && <SecurityTab />}
    </div>
  );
}

function ContractTab({ onConsult }: { onConsult: () => void }) {
  const { me } = useAuth();
  const { data: d, reload } = useApi<ContractRes>("/account/contract");
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const [planReq, setPlanReq] = useState<string | null>(null);
  useEffect(() => {
    if (d) setF({ contactName: d.org.contact_name ?? "", contactEmail: d.org.contact_email ?? "", contactPhone: d.org.contact_phone ?? "", billingEmail: d.org.billing_email ?? "", address: d.org.address ?? "" });
  }, [d]);
  if (!d) return <Empty>読み込み中…</Empty>;
  const lim = (v: number | null) => (v == null ? "無制限" : v);
  const pct = (u: number, l: number | null) => (l ? Math.min(100, (u / l) * 100) : 0);
  const isAdmin = me?.role === "admin";
  return (
    <div className="space-y-6">
      {d.contract.status === "trial" && d.contract.trialEndsAt && (
        <Alert tone="amber">
          トライアル期間中です（{fmtDate(d.contract.trialEndsAt)} まで・残り {Math.max(0, Math.ceil((d.contract.trialEndsAt - Date.now()) / 86400000))} 日）。本契約をご希望の場合はお問い合わせください。
        </Alert>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="ご契約" value={d.contract.plan.name} sub={ORG_STATUS_LABEL[d.contract.status]} />
        <Stat label="会社コード" value={<span className="font-mono">{d.org.code}</span>} sub="作業員のログインに使用" />
        <Stat label="今月の請求見込（税込）" value={yen(d.estimate.total)} />
        <Stat label="未登録のタグ" value={d.usage.stock_unregistered} sub="「NFCタグ」画面から登録" tone={d.usage.stock_unregistered ? "amber" : undefined} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="ご利用状況">
          <div className="space-y-4">
            {(
              [
                ["稼働タグ", d.usage.tags, d.contract.limits.tags],
                ["ユーザー", d.usage.users, d.contract.limits.users],
                ["現場", d.usage.sites, d.contract.limits.sites]
              ] as [string, number, number | null][]
            ).map(([label, u, l]) => (
              <div key={label}>
                <div className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="tabular-nums">
                    {u} / {lim(l)}
                  </span>
                </div>
                {l != null && (
                  <div className="mt-1 h-2 rounded-full bg-slate-100">
                    <div className={cx("h-2 rounded-full", pct(u, l) >= 90 ? "bg-red-500" : "bg-[#2a78d6]")} style={{ width: `${pct(u, l)}%` }} />
                  </div>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-1 pt-2">
              {Object.entries(FEATURE_LABEL).map(([k, v]) => (
                <Badge key={k} tone={d.contract.plan.features.includes(k) ? "green" : "slate"}>
                  {d.contract.plan.features.includes(k) ? "✓" : "—"} {v}
                </Badge>
              ))}
            </div>
          </div>
        </Card>
        <Card title="今月の請求見込（内訳）">
          <ul className="space-y-1 text-sm">
            {d.estimate.items.map((i) => (
              <li key={i.label} className="flex justify-between gap-2">
                <span>
                  {i.label}
                  {i.qty > 1 ? ` ×${i.qty}` : ""}
                </span>
                <span className="tabular-nums">{yen(i.amount)}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-slate-100 pt-1 text-slate-500">
              <span>消費税</span>
              <span className="tabular-nums">{yen(d.estimate.tax)}</span>
            </li>
            <li className="flex justify-between font-bold">
              <span>合計（税込）</span>
              <span className="tabular-nums">{yen(d.estimate.total)}</span>
            </li>
          </ul>
          <p className="mt-2 text-xs text-slate-500">※ 月末時点の稼働タグ数・有効ユーザー数で確定します。</p>
        </Card>
      </div>

      <Card title="プラン一覧">
        <div className="grid gap-4 md:grid-cols-3">
          {d.plans.map((p) => {
            const current = p.code === d.contract.plan.code;
            return (
              <div key={p.code} className={cx("rounded-2xl p-4 ring-1", current ? "bg-slate-900 text-white ring-slate-900" : "ring-slate-200")}>
                <div className="flex items-center justify-between">
                  <div className="font-bold">{p.name}</div>
                  {current && <Badge tone="amber">ご契約中</Badge>}
                </div>
                <div className="mt-1 text-xl font-bold">
                  {yen(p.monthly_fee)}
                  <span className="text-xs font-normal opacity-70">/月（税抜）</span>
                </div>
                <ul className="mt-2 space-y-0.5 text-xs opacity-80">
                  <li>
                    タグ {p.included_tags}枚込み（追加 {yen(p.fee_per_tag)}/枚）・上限 {p.max_tags ?? "なし"}
                  </li>
                  <li>
                    ユーザー {p.included_users}名込み（追加 {yen(p.fee_per_user)}/名）
                  </li>
                  <li>{parsePlanFeatures(p.features_json).map((x) => FEATURE_LABEL[x] ?? x).join("・")}</li>
                </ul>
                {!current && isAdmin && (
                  <Button size="sm" variant="outline" className="mt-3 w-full !text-slate-900" onClick={() => setPlanReq(p.name)}>
                    このプランを相談する
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="会社情報・ご連絡先">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ご担当者">
            <Input value={f.contactName ?? ""} onChange={(e) => setF({ ...f, contactName: e.target.value })} disabled={!isAdmin} />
          </Field>
          <Field label="ご担当者メール">
            <Input value={f.contactEmail ?? ""} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} disabled={!isAdmin} />
          </Field>
          <Field label="電話番号">
            <Input value={f.contactPhone ?? ""} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} disabled={!isAdmin} />
          </Field>
          <Field label="請求書送付先メール">
            <Input value={f.billingEmail ?? ""} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} disabled={!isAdmin} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="住所（請求書宛先・タグのお届け先）">
              <Input value={f.address ?? ""} onChange={(e) => setF({ ...f, address: e.target.value })} disabled={!isAdmin} />
            </Field>
          </div>
        </div>
        {isAdmin && (
          <Button
            className="mt-4"
            onClick={async () => {
              try {
                await patch("/account/org", f);
                setMsg({ tone: "green", text: "会社情報を保存しました" });
                void reload();
              } catch (e) {
                setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
              }
            }}
          >
            保存
          </Button>
        )}
      </Card>
      {planReq && (
        <NewTicket
          initial={{ subject: `プラン変更のご相談（${planReq}）`, category: "billing", body: `現在の${d.contract.plan.name}プランから${planReq}プランへの変更を検討しています。` }}
          onClose={() => setPlanReq(null)}
          onDone={() => {
            setPlanReq(null);
            onConsult();
          }}
        />
      )}
    </div>
  );
}

function InvoicesTab() {
  const { data } = useApi<{ id: string; number: string; period: string; total: number; status: string; issued_at: number | null; due_at: number | null; paid_at: number | null }[]>("/account/invoices");
  return (
    <Card title="請求書">
      {!data?.length ? (
        <Empty>発行済みの請求書はありません</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-500">
            <tr>
              <th className="py-2">対象月</th>
              <th>請求番号</th>
              <th className="text-right">金額（税込）</th>
              <th>状態</th>
              <th>お支払期限</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((i) => (
              <tr key={i.id}>
                <td className="py-2">{i.period}</td>
                <td className="font-mono text-xs">{i.number}</td>
                <td className="text-right tabular-nums">{yen(i.total)}</td>
                <td>
                  <Badge tone={i.status === "paid" ? "green" : "blue"}>{INVOICE_STATUS_LABEL[i.status]}</Badge>
                </td>
                <td className={cx("text-xs", i.status === "issued" && !!i.due_at && i.due_at < Date.now() && "font-bold text-red-600")}>{fmtDate(i.due_at)}</td>
                <td className="text-right">
                  <a href={`/api/account/invoices/${i.id}/print`} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline">
                      表示・PDF
                    </Button>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SupportTab() {
  const list = useApi<{ id: string; subject: string; category: string; status: string; updated_at: number; user_name: string | null; messages: number }[]>("/account/tickets");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-6 xl:grid-cols-5">
      <Card className="xl:col-span-2" title="お問い合わせ履歴" action={<Button size="sm" onClick={() => setCreating(true)}>＋ 新規</Button>}>
        {!list.data?.length ? (
          <Empty>お問い合わせはありません。タグの追加発送・不具合・ご要望などお気軽にどうぞ。</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.map((t) => (
              <li key={t.id}>
                <button onClick={() => setOpen(t.id)} className={cx("w-full py-2.5 text-left", open === t.id && "bg-slate-50")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{t.subject}</span>
                    <Badge tone={t.status === "answered" ? "green" : t.status === "open" ? "amber" : "slate"}>{t.status === "open" ? "回答待ち" : TICKET_STATUS_LABEL[t.status]}</Badge>
                  </div>
                  <div className="text-xs text-slate-500">
                    {TICKET_CATEGORY_LABEL[t.category]} ・ {t.user_name} ・ {fmtAgo(t.updated_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="xl:col-span-3">{open ? <TicketThread id={open} onChange={() => void list.reload()} /> : <Card><Empty>左の一覧からお問い合わせを選択してください</Empty></Card>}</div>
      {creating && (
        <NewTicket
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            void list.reload();
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}

function TicketThread({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useApi<{ ticket: { subject: string; status: string }; messages: { id: string; author_type: string; author_name: string; body: string; created_at: number }[] }>(`/account/tickets/${id}`, [id]);
  const [body, setBody] = useState("");
  if (!data) return <Card><Empty>読み込み中…</Empty></Card>;
  return (
    <Card title={data.ticket.subject} action={<Badge>{TICKET_STATUS_LABEL[data.ticket.status]}</Badge>}>
      <ul className="space-y-3">
        {data.messages.map((m) => (
          <li key={m.id} className={cx("rounded-xl p-3 text-sm", m.author_type === "platform" ? "mr-8 bg-indigo-50" : "ml-8 bg-slate-100")}>
            <div className="mb-1 text-xs font-semibold text-slate-500">
              {m.author_name} ・ {fmtDateTime(m.created_at)}
            </div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </li>
        ))}
      </ul>
      {data.ticket.status !== "closed" && (
        <div className="mt-4 space-y-2">
          <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="追記・返信" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={async () => (await post(`/account/tickets/${id}/close`), reload(), onChange())}>
              解決済みにする
            </Button>
            <Button disabled={!body} onClick={async () => (await post(`/account/tickets/${id}/reply`, { body }), setBody(""), reload(), onChange())}>
              送信
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function NewTicket({ initial, onClose, onDone }: { initial?: { subject: string; category: string; body: string }; onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState(initial ?? { subject: "", category: "general", body: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="お問い合わせ">
      <div className="space-y-3">
        <Field label="種別">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {Object.entries(TICKET_CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="件名">
          <Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="例: NFCタグを50枚追加したい" />
        </Field>
        <Field label="内容">
          <Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full"
          disabled={!f.subject || !f.body}
          onClick={async () => {
            try {
              const r = await post<{ id: string }>("/account/tickets", f);
              onDone(r.id);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          送信
        </Button>
      </div>
    </Modal>
  );
}

function SecurityTab() {
  const { me } = useAuth();
  const [pw, setPw] = useState({ current: "", next: "", next2: "" });
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  return (
    <Card title="パスワード変更" className="max-w-lg">
      <div className="space-y-3">
        {me?.impersonatedBy && <Alert tone="amber">代理ログイン中はパスワードを変更できません</Alert>}
        <Field label="現在のパスワード">
          <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
        </Field>
        <Field label="新しいパスワード（8文字以上）">
          <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="新しいパスワード（確認）">
          <Input type="password" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} autoComplete="new-password" />
        </Field>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button
          disabled={!pw.current || pw.next.length < 8 || pw.next !== pw.next2 || !!me?.impersonatedBy}
          onClick={async () => {
            try {
              await post("/auth/change-password", { current: pw.current, next: pw.next });
              setPw({ current: "", next: "", next2: "" });
              setMsg({ tone: "green", text: "パスワードを変更しました。他の端末はログアウトされます" });
            } catch (e) {
              setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
            }
          }}
        >
          変更する
        </Button>
      </div>
    </Card>
  );
}

interface NotifyRes {
  prefs: { alertEmail: string; alertLine: string; extraEmails: string[]; invoiceEmail: boolean };
  me: { email: string | null; notifyEmail: boolean };
  emailRecipients: { name: string; email: string; notify_email: number }[];
  allowQrCheckin: boolean;
  channels: { email: boolean; line: boolean; lineBasicId: string };
  lineTargets: { id: string; kind: string; display_name: string | null; min_severity: string; active: number; user_name: string | null; created_at: number }[];
  log: { id: string; channel: string; to_label: string | null; to_address: string; event_type: string; subject: string; status: string; last_error: string | null; created_at: number }[];
}
const SEV_OPTS: [string, string][] = [
  ["danger", "緊急のみ（生存確認の応答なし・危険接近・重大ヒヤリハット）"],
  ["warning", "注意以上（無資格操作・手順違反・点検異常なども）"],
  ["info", "すべて"],
  ["off", "送らない"]
];

function NotifyTab() {
  const { me } = useAuth();
  const { data, reload } = useApi<NotifyRes>("/account/notifications");
  const [p, setP] = useState<NotifyRes["prefs"] | null>(null);
  const [extra, setExtra] = useState("");
  const [qr, setQr] = useState(true);
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);
  const [link, setLink] = useState<{ code: string; expiresAt: number; addFriendUrl: string | null; personal: boolean } | null>(null);
  useEffect(() => {
    if (data) {
      setP(data.prefs);
      setExtra(data.prefs.extraEmails.join("\n"));
      setQr(data.allowQrCheckin);
    }
  }, [data]);
  if (!data || !p) return <Empty>読み込み中…</Empty>;
  const isAdmin = me?.role === "admin";
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setMsg({ tone: "green", text: ok });
      await reload();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!data.channels.email && <Alert tone="amber">メール送信は運営側で準備中です。設定は保存でき、準備が整い次第送信されます。</Alert>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="アラートの通知先">
          <div className="space-y-4">
            <Field label="メール（管理者・マネージャー）">
              <Select value={p.alertEmail} onChange={(e) => setP({ ...p, alertEmail: e.target.value })} disabled={!isAdmin}>
                {SEV_OPTS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="LINE（連携したグループ・個人）">
              <Select value={p.alertLine} onChange={(e) => setP({ ...p, alertLine: e.target.value })} disabled={!isAdmin}>
                {SEV_OPTS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="追加のメール宛先（1行に1件）" hint="現場事務所・安全管理者など、アカウントを持たない宛先">
              <Textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} disabled={!isAdmin} className="font-mono text-sm" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={p.invoiceEmail} onChange={(e) => setP({ ...p, invoiceEmail: e.target.checked })} disabled={!isAdmin} />
              請求書の発行をメールで受け取る（請求書送付先・ご担当者宛）
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={qr} onChange={(e) => setQr(e.target.checked)} disabled={!isAdmin} />
              <span>
                ラベルのQRコード読み取りでの記録を許可する
                <br />
                <span className="text-xs text-slate-500">NFC非対応の端末向け。QRは撮影で再現できるため「証明レベル：低」として記録されます</span>
              </span>
            </label>
            {isAdmin && (
              <Button
                onClick={() =>
                  act(
                    () =>
                      put("/account/notifications", {
                        ...p,
                        extraEmails: extra
                          .split(/[\s,]+/)
                          .map((x) => x.trim())
                          .filter(Boolean),
                        allowQrCheckin: qr
                      }),
                    "通知設定を保存しました"
                  )
                }
              >
                保存
              </Button>
            )}
          </div>
        </Card>
        <div className="space-y-6">
          <Card title="メールの受信者">
            <ul className="space-y-1 text-sm">
              {data.emailRecipients.map((r) => (
                <li key={r.email} className="flex justify-between gap-2">
                  <span>
                    {r.name} <span className="text-xs text-slate-500">{r.email}</span>
                  </span>
                  <Badge tone={r.notify_email ? "green" : "slate"}>{r.notify_email ? "受信" : "停止"}</Badge>
                </li>
              ))}
            </ul>
            {data.me.email && (
              <label className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3 text-sm">
                <input type="checkbox" checked={data.me.notifyEmail} onChange={(e) => act(() => put("/account/notifications/me", { notifyEmail: e.target.checked }), "受信設定を変更しました")} />
                自分（{data.me.email}）もアラートメールを受け取る
              </label>
            )}
          </Card>
          <Card
            title="LINE 連携"
            action={
              data.channels.line && (
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => act(async () => setLink({ ...(await post<{ code: string; expiresAt: number; addFriendUrl: string | null }>("/account/line/link-code", { personal: false })), personal: false }))}>
                    グループを連携
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => act(async () => setLink({ ...(await post<{ code: string; expiresAt: number; addFriendUrl: string | null }>("/account/line/link-code", { personal: true })), personal: true }))}>
                    自分のLINE
                  </Button>
                </div>
              )
            }
          >
            {!data.channels.line ? (
              <Empty>LINE通知は運営側で準備中です</Empty>
            ) : !data.lineTargets.length ? (
              <Empty>まだ連携されていません。現場のLINEグループを連携すると、アラートが全員に届きます</Empty>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.lineTargets.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <div className="font-semibold">
                        {t.kind === "group" ? "👥 " : "👤 "}
                        {t.display_name}
                        {!t.active && <Badge tone="red">ブロック/退出</Badge>}
                      </div>
                      {t.user_name && <div className="text-xs text-slate-500">{t.user_name} さん</div>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Select value={t.min_severity} onChange={(e) => act(() => patch(`/account/line/targets/${t.id}`, { minSeverity: e.target.value }))} className="w-28 py-1 text-xs">
                        <option value="danger">緊急のみ</option>
                        <option value="warning">注意以上</option>
                        <option value="info">すべて</option>
                      </Select>
                      <Button size="sm" variant="ghost" onClick={() => confirm("連携を解除しますか？") && act(() => del(`/account/line/targets/${t.id}`), "解除しました")}>
                        解除
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Button variant="outline" className="w-full" onClick={() => act(async () => {
            const r = await post<{ total: number; sent: number; skipped: number; failed: number }>("/account/notifications/test");
            setMsg({ tone: r.sent ? "green" : "amber", text: `テスト通知: ${r.total}件（送信 ${r.sent}・未送信 ${r.skipped}・失敗 ${r.failed}）` });
          })}>
            テスト通知を送る
          </Button>
        </div>
      </div>
      <Card title="最近の通知">
        {!data.log.length ? (
          <Empty>まだ通知はありません</Empty>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {data.log.map((l) => (
                <tr key={l.id}>
                  <td className="py-2 text-xs whitespace-nowrap text-slate-500">{fmtDateTime(l.created_at)}</td>
                  <td className="text-xs">{l.channel === "line" ? "LINE" : "メール"}</td>
                  <td className="max-w-[200px] truncate text-xs">{l.to_label || l.to_address}</td>
                  <td className="max-w-md truncate">{l.subject}</td>
                  <td>
                    <Badge tone={l.status === "sent" ? "green" : l.status === "failed" ? "red" : "slate"}>{{ sent: "送信済", failed: "失敗", skipped: "未送信", pending: "送信待ち" }[l.status] ?? l.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {link && (
        <Modal open onClose={() => (setLink(null), void reload())} title={link.personal ? "自分のLINEと連携" : "LINEグループと連携"}>
          <div className="space-y-4 text-sm">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                公式アカウントを友だち追加します
                {link.addFriendUrl && (
                  <div className="mt-2 flex items-center gap-3">
                    <Qr text={link.addFriendUrl} size={120} />
                    <a href={link.addFriendUrl} target="_blank" rel="noreferrer" className="text-sky-700 underline">
                      友だち追加リンク
                    </a>
                  </div>
                )}
              </li>
              {!link.personal && <li>通知を届けたいLINEグループに、その公式アカウントを招待します</li>}
              <li>
                {link.personal ? "公式アカウントとのトーク" : "そのグループ"}で次のコードを送信します（15分以内）
                <div className="mt-2 rounded-xl bg-slate-900 py-3 text-center font-mono text-3xl tracking-[.4em] text-white">{link.code}</div>
              </li>
            </ol>
            <p className="text-xs text-slate-500">「連携しました」と返信が来たら完了です。この画面を閉じると一覧が更新されます。</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
