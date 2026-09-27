// 料金プラン / お知らせ / サポート / 設定 / 監査ログ
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useApi } from "../../lib/hooks";
import { ApiError, del, patch, post, put } from "../../lib/api";
import { useOps } from "./OpsLayout";
import { MfaCard, NotifySettingsCard } from "./OpsSecurity";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Textarea, cx } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { FEATURE_LABEL, TICKET_CATEGORY_LABEL, TICKET_STATUS_LABEL, fmtAgo, fmtDateTime, yen } from "../../lib/format";

// ================= 料金プラン =================
interface Plan {
  code: string;
  name: string;
  monthly_fee: number;
  fee_per_tag: number;
  fee_per_user: number;
  included_tags: number;
  included_users: number;
  max_tags: number | null;
  max_users: number | null;
  max_sites: number | null;
  features: string[];
  active: number;
  sort: number;
  tenants: number;
}

export function OpsPlans() {
  const { me } = useOps();
  const { data, reload } = useApi<Plan[]>("/ops/plans");
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">料金プラン</h1>
        {me.role === "owner" && (
          <Button className="!bg-indigo-700" onClick={() => setEditing("new")}>
            ＋ プラン追加
          </Button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((p) => (
          <Card key={p.code} title={<span>{p.name} <span className="font-mono text-xs text-slate-400">{p.code}</span></span>} action={!p.active ? <Badge tone="red">停止</Badge> : <Badge>{p.tenants}社</Badge>}>
            <div className="text-2xl font-bold">
              {yen(p.monthly_fee)}
              <span className="text-sm font-normal text-slate-500">/月（税抜）</span>
            </div>
            <ul className="mt-3 space-y-1 text-sm text-slate-600">
              <li>
                タグ {p.included_tags}枚まで込み・超過 {yen(p.fee_per_tag)}/枚・上限 {p.max_tags ?? "なし"}
              </li>
              <li>
                ユーザー {p.included_users}名まで込み・超過 {yen(p.fee_per_user)}/名・上限 {p.max_users ?? "なし"}
              </li>
              <li>現場 上限 {p.max_sites ?? "なし"}</li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-1">
              {p.features.map((f) => (
                <Badge key={f} tone="blue">
                  {FEATURE_LABEL[f] ?? f}
                </Badge>
              ))}
            </div>
            {me.role === "owner" && (
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setEditing(p)}>
                編集
              </Button>
            )}
          </Card>
        ))}
      </div>
      {editing && <PlanForm plan={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void reload())} />}
    </div>
  );
}

function PlanForm({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    code: plan?.code ?? "",
    name: plan?.name ?? "",
    monthlyFee: String(plan?.monthly_fee ?? 0),
    feePerTag: String(plan?.fee_per_tag ?? 0),
    feePerUser: String(plan?.fee_per_user ?? 0),
    includedTags: String(plan?.included_tags ?? 0),
    includedUsers: String(plan?.included_users ?? 0),
    maxTags: plan?.max_tags?.toString() ?? "",
    maxUsers: plan?.max_users?.toString() ?? "",
    maxSites: plan?.max_sites?.toString() ?? "",
    sort: String(plan?.sort ?? 10)
  });
  const [features, setFeatures] = useState<string[]>(plan?.features ?? ["reports"]);
  const [active, setActive] = useState(plan ? !!plan.active : true);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (v: string) => Number(v || 0);
  const nul = (v: string) => (v === "" ? null : Number(v));
  return (
    <Modal open onClose={onClose} title={plan ? `プラン編集: ${plan.name}` : "プラン追加"} wide>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="コード（英小文字）">
          <Input value={f.code} onChange={set("code")} disabled={!!plan} className="font-mono" />
        </Field>
        <Field label="名称">
          <Input value={f.name} onChange={set("name")} />
        </Field>
        <Field label="表示順">
          <Input type="number" value={f.sort} onChange={set("sort")} />
        </Field>
        <Field label="月額基本料（円）">
          <Input type="number" value={f.monthlyFee} onChange={set("monthlyFee")} />
        </Field>
        <Field label="込みタグ数">
          <Input type="number" value={f.includedTags} onChange={set("includedTags")} />
        </Field>
        <Field label="超過タグ単価">
          <Input type="number" value={f.feePerTag} onChange={set("feePerTag")} />
        </Field>
        <Field label="込みユーザー数">
          <Input type="number" value={f.includedUsers} onChange={set("includedUsers")} />
        </Field>
        <Field label="超過ユーザー単価">
          <Input type="number" value={f.feePerUser} onChange={set("feePerUser")} />
        </Field>
        <div />
        <Field label="タグ上限（空=無制限）">
          <Input type="number" value={f.maxTags} onChange={set("maxTags")} />
        </Field>
        <Field label="ユーザー上限">
          <Input type="number" value={f.maxUsers} onChange={set("maxUsers")} />
        </Field>
        <Field label="現場上限">
          <Input type="number" value={f.maxSites} onChange={set("maxSites")} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        {Object.entries(FEATURE_LABEL).map(([k, v]) => (
          <label key={k} className="flex items-center gap-2">
            <input type="checkbox" checked={features.includes(k)} onChange={(e) => setFeatures(e.target.checked ? [...features, k] : features.filter((x) => x !== k))} />
            {v}
          </label>
        ))}
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          新規契約で選択可能
        </label>
      </div>
      {err && (
        <div className="mt-3">
          <Alert>{err}</Alert>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button
          className="!bg-indigo-700"
          disabled={!f.code || !f.name}
          onClick={async () => {
            try {
              await put(`/ops/plans/${f.code}`, {
                name: f.name,
                monthlyFee: num(f.monthlyFee),
                feePerTag: num(f.feePerTag),
                feePerUser: num(f.feePerUser),
                includedTags: num(f.includedTags),
                includedUsers: num(f.includedUsers),
                maxTags: nul(f.maxTags),
                maxUsers: nul(f.maxUsers),
                maxSites: nul(f.maxSites),
                features,
                active,
                sort: num(f.sort)
              });
              onSaved();
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          保存
        </Button>
      </div>
    </Modal>
  );
}

// ================= お知らせ =================
export function OpsAnnouncements() {
  const { data, reload } = useApi<{ id: string; title: string; body: string; level: string; org_name: string | null; published_at: number; expires_at: number | null }[]>("/ops/announcements");
  const tenants = useApi<{ id: string; name: string }[]>("/ops/tenants");
  const [f, setF] = useState({ title: "", body: "", level: "info", orgId: "", expires: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const LEVEL: Record<string, string> = { info: "お知らせ", maintenance: "メンテナンス", important: "重要" };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">お知らせ配信</h1>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="新規配信">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="種別">
                <Select value={f.level} onChange={set("level")}>
                  {Object.entries(LEVEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="配信先">
                <Select value={f.orgId} onChange={set("orgId")}>
                  <option value="">全テナント</option>
                  {tenants.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="タイトル">
              <Input value={f.title} onChange={set("title")} />
            </Field>
            <Field label="本文">
              <Textarea rows={5} value={f.body} onChange={set("body")} />
            </Field>
            <Field label="掲載終了日（任意）">
              <Input type="date" value={f.expires} onChange={set("expires")} />
            </Field>
            {err && <Alert>{err}</Alert>}
            <Button
              className="w-full !bg-indigo-700"
              disabled={!f.title || !f.body}
              onClick={async () => {
                try {
                  await post("/ops/announcements", { title: f.title, body: f.body, level: f.level, orgId: f.orgId || null, expiresAt: f.expires ? new Date(`${f.expires}T23:59:59+09:00`).getTime() : null });
                  setF({ title: "", body: "", level: "info", orgId: "", expires: "" });
                  void reload();
                } catch (e) {
                  setErr(e instanceof ApiError ? e.message : String(e));
                }
              }}
            >
              配信する
            </Button>
          </div>
        </Card>
        <Card title="配信履歴">
          {!data?.length ? (
            <Empty>まだありません</Empty>
          ) : (
            <ul className="space-y-3">
              {data.map((a) => (
                <li key={a.id} className="rounded-xl bg-slate-50 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold">
                      <Badge tone={a.level === "important" ? "red" : a.level === "maintenance" ? "amber" : "blue"}>{LEVEL[a.level]}</Badge> {a.title}
                    </div>
                    <button
                      className="text-xs text-red-600"
                      onClick={async () => {
                        if (confirm("削除しますか？")) {
                          await del(`/ops/announcements/${a.id}`);
                          void reload();
                        }
                      }}
                    >
                      削除
                    </button>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-slate-600">{a.body}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {fmtDateTime(a.published_at)} ・ {a.org_name ?? "全テナント"}
                    {a.expires_at ? ` ・ 〜${fmtDateTime(a.expires_at)}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ================= サポート =================
interface Ticket {
  id: string;
  subject: string;
  category: string;
  status: string;
  org_name: string;
  user_name: string | null;
  updated_at: number;
  messages: number;
}
export function OpsSupport() {
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState("");
  const list = useApi<Ticket[]>(`/ops/tickets${status ? `?status=${status}` : ""}`, [status]);
  const current = sp.get("ticket");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">サポート</h1>
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2" title="問い合わせ一覧" action={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-28 py-1 text-sm">
            <option value="">全て</option>
            {Object.entries(TICKET_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        }>
          {!list.data?.length ? (
            <Empty>問い合わせはありません</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.data.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setSp({ ticket: t.id })} className={cx("w-full py-2.5 text-left", current === t.id && "bg-indigo-50")}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">{t.subject}</span>
                      <Badge tone={t.status === "open" ? "amber" : t.status === "answered" ? "blue" : "slate"}>{TICKET_STATUS_LABEL[t.status]}</Badge>
                    </div>
                    <div className="text-xs text-slate-500">
                      {t.org_name} ・ {TICKET_CATEGORY_LABEL[t.category]} ・ {fmtAgo(t.updated_at)} ・ {t.messages}件
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="xl:col-span-3">{current ? <OpsTicket id={current} onChange={() => void list.reload()} /> : <Card><Empty>左の一覧から問い合わせを選択してください</Empty></Card>}</div>
      </div>
    </div>
  );
}

function OpsTicket({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useApi<{ ticket: { subject: string; status: string; org_name: string; org_id: string }; messages: { id: string; author_type: string; author_name: string; body: string; created_at: number }[] }>(`/ops/tickets/${id}`, [id]);
  const [body, setBody] = useState("");
  const [close, setClose] = useState(false);
  if (!data) return <Card><Empty>読み込み中…</Empty></Card>;
  return (
    <Card title={data.ticket.subject} action={<Badge>{TICKET_STATUS_LABEL[data.ticket.status]}</Badge>}>
      <div className="mb-3 text-xs text-slate-500">{data.ticket.org_name}</div>
      <ul className="space-y-3">
        {data.messages.map((m) => (
          <li key={m.id} className={cx("rounded-xl p-3 text-sm", m.author_type === "platform" ? "ml-8 bg-indigo-50" : "mr-8 bg-slate-100")}>
            <div className="mb-1 text-xs font-semibold text-slate-500">
              {m.author_name} ・ {fmtDateTime(m.created_at)}
            </div>
            <div className="whitespace-pre-wrap">{m.body}</div>
          </li>
        ))}
      </ul>
      <div className="mt-4 space-y-2">
        <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="回答を入力" />
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={close} onChange={(e) => setClose(e.target.checked)} /> 回答して完了にする
          </label>
          <div className="flex gap-2">
            {data.ticket.status !== "closed" && (
              <Button variant="ghost" size="sm" onClick={async () => (await patch(`/ops/tickets/${id}`, { status: "closed" }), reload(), onChange())}>
                完了にする
              </Button>
            )}
            <Button
              className="!bg-indigo-700"
              disabled={!body}
              onClick={async () => {
                await post(`/ops/tickets/${id}/reply`, { body, close });
                setBody("");
                void reload();
                onChange();
              }}
            >
              回答を送信
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ================= 設定 =================
export function OpsSettings() {
  const { me } = useOps();
  const settings = useApi<Record<string, string>>("/ops/settings");
  const admins = useApi<{ id: string; email: string; name: string; role: string; active: number; totp_enabled: number; last_login_at: number | null }[]>("/ops/admins");
  const [s, setS] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);
  const [newAdmin, setNewAdmin] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "" });
  useEffect(() => setS(settings.data ?? {}), [settings.data]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      if (ok) setMsg({ tone: "green", text: ok });
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const owner = me.role === "owner";
  const field = (k: string, label: string, multi = false) => (
    <Field label={label}>
      {multi ? <Textarea rows={3} value={s[k] ?? ""} onChange={(e) => setS({ ...s, [k]: e.target.value })} disabled={!owner} /> : <Input value={s[k] ?? ""} onChange={(e) => setS({ ...s, [k]: e.target.value })} disabled={!owner} />}
    </Field>
  );
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定・運営アカウント</h1>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="運営会社情報（請求書に記載）">
          <div className="space-y-3">
            {field("company_name", "会社名")}
            {field("company_address", "住所", true)}
            {field("invoice_registration_no", "適格請求書発行事業者 登録番号（T+13桁）")}
            {field("bank_info", "振込先", true)}
            {field("support_email", "サポート窓口メール")}
            {field("tax_rate", "消費税率（%）")}
            {owner && (
              <Button
                className="!bg-indigo-700"
                onClick={() =>
                  act(
                    () =>
                      put(
                        "/ops/settings",
                        Object.fromEntries(["company_name", "company_address", "invoice_registration_no", "bank_info", "support_email", "tax_rate"].map((k) => [k, s[k] ?? ""]))
                      ),
                    "保存しました"
                  )
                }
              >
                保存
              </Button>
            )}
          </div>
        </Card>
        <div className="space-y-6">
          <Card title="運営アカウント" action={owner && <Button size="sm" onClick={() => setNewAdmin(true)}>＋ 追加</Button>}>
            <ul className="divide-y divide-slate-100 text-sm">
              {admins.data?.map((a) => (
                <li key={a.id} className={cx("flex items-center justify-between gap-2 py-2", !a.active && "opacity-40")}>
                  <div>
                    <div className="font-semibold">
                      {a.name} <Badge tone={a.role === "owner" ? "blue" : "slate"}>{a.role === "owner" ? "オーナー" : "スタッフ"}</Badge>{" "}
                      <Badge tone={a.totp_enabled ? "green" : "amber"}>{a.totp_enabled ? "2FA" : "2FA未設定"}</Badge>
                    </div>
                    <div className="text-xs text-slate-500">
                      {a.email} ・ 最終ログイン {fmtAgo(a.last_login_at)}
                    </div>
                  </div>
                  {owner && a.id !== me.id && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          act(async () => {
                            const r = await patch<{ temporaryPassword: string }>(`/ops/admins/${a.id}`, { resetPassword: true });
                            setMsg({ tone: "amber", text: `${a.name} の仮パスワード: ${r.temporaryPassword}` });
                          }, "")
                        }
                      >
                        PW再発行
                      </Button>
                      {!!a.totp_enabled && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`${a.name} の二段階認証をリセットしますか？（端末紛失時など。本人は次回ログイン後に再設定します）`))
                              void act(async () => (await patch(`/ops/admins/${a.id}`, { reset2fa: true }), admins.reload()), "二段階認証をリセットしました");
                          }}
                        >
                          2FAリセット
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => act(async () => (await patch(`/ops/admins/${a.id}`, { active: !a.active }), admins.reload()), a.active ? "無効化しました" : "有効化しました")}>
                        {a.active ? "無効化" : "有効化"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <MfaCard />
          {owner && (
            <Card title="セキュリティポリシー">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={s.require_ops_2fa === "1"}
                  onChange={(e) =>
                    act(async () => {
                      await put("/ops/settings", { require_ops_2fa: e.target.checked ? "1" : "0" });
                      setS({ ...s, require_ops_2fa: e.target.checked ? "1" : "0" });
                    }, e.target.checked ? "二段階認証を必須にしました" : "必須設定を解除しました")
                  }
                />
                <span>
                  <b>全運営アカウントに二段階認証を必須にする</b>
                  <br />
                  <span className="text-slate-500">未設定のアカウントはログイン後、設定が完了するまで他の機能を使えません。</span>
                </span>
              </label>
            </Card>
          )}
          <Card title="自分のパスワード変更">
            <div className="space-y-3">
              <Field label="現在のパスワード">
                <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
              </Field>
              <Field label="新しいパスワード（10文字以上）">
                <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
              </Field>
              <Button disabled={!pw.current || pw.next.length < 10} onClick={() => act(async () => (await post("/ops/change-password", pw), setPw({ current: "", next: "" })), "パスワードを変更しました")}>
                変更
              </Button>
            </div>
          </Card>
        </div>
      </div>
      <NotifySettingsCard owner={owner} />
      {newAdmin && <NewAdmin onClose={() => setNewAdmin(false)} onDone={(t) => (setNewAdmin(false), setMsg({ tone: "amber", text: t }), void admins.reload())} />}
    </div>
  );
}

function NewAdmin({ onClose, onDone }: { onClose: () => void; onDone: (t: string) => void }) {
  const [f, setF] = useState({ name: "", email: "", role: "staff" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="運営アカウント追加">
      <div className="space-y-3">
        <Field label="氏名">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="メール">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="権限" hint="スタッフ: テナント・在庫・請求・サポートの操作 / オーナー: 加えてプラン・設定・運営アカウント・暗号鍵の書き出し">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="staff">スタッフ</option>
            <option value="owner">オーナー</option>
          </Select>
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full !bg-indigo-700"
          disabled={!f.name || !f.email}
          onClick={async () => {
            try {
              const r = await post<{ temporaryPassword: string; mailStatus: string }>("/ops/admins", f);
              onDone(`${f.name} を追加しました。仮パスワード: ${r.temporaryPassword}（ログイン画面: ${location.origin}/ops/login）${r.mailStatus === "sent" ? " ／ 招待メールを送信しました" : ""}`);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          追加
        </Button>
      </div>
    </Modal>
  );
}

// ================= 監査ログ =================
export function OpsAudit() {
  const { data } = useApi<{ id: string; admin_name: string | null; action: string; target_type: string | null; target_id: string | null; detail_json: string | null; created_at: number }[]>("/ops/audit");
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">運営監査ログ</h1>
      <Card>
        {!data?.length ? (
          <Empty>記録なし</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">日時</th>
                  <th>運営者</th>
                  <th>操作</th>
                  <th>対象</th>
                  <th>詳細</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2 whitespace-nowrap">{fmtDateTime(l.created_at)}</td>
                    <td>{l.admin_name ?? "—"}</td>
                    <td className="font-mono text-xs">{l.action}</td>
                    <td className="font-mono text-xs text-slate-500">
                      {l.target_type} {l.target_id?.slice(0, 12)}
                    </td>
                    <td className="max-w-md truncate font-mono text-xs text-slate-500">{l.detail_json}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
