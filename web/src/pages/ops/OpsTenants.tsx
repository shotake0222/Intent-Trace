import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useApi } from "../../lib/hooks";
import { ApiError, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Textarea, cx } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { ORG_STATUS_LABEL, fmtAgo, fmtDate } from "../../lib/format";

interface Tenant {
  id: string;
  code: string;
  name: string;
  plan: string;
  status: string;
  trial_ends_at: number | null;
  contact_name: string | null;
  users: number;
  tags: number;
  sites: number;
  stock_unregistered: number;
  last_tap_at: number | null;
  taps30: number;
  created_at: number;
}
export const statusTone = (s: string) => (s === "active" ? "green" : s === "trial" ? "blue" : s === "suspended" ? "red" : "slate") as "green" | "blue" | "red" | "slate";

export default function OpsTenants() {
  const { data, reload } = useApi<Tenant[]>("/ops/tenants");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = (data ?? []).filter((t) => (!status || t.status === status) && (!q || `${t.name}${t.code}${t.contact_name ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">テナント（契約企業）</h1>
        <Button className="!bg-indigo-700" onClick={() => setCreating(true)}>
          ＋ テナントを作成
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input placeholder="社名・会社コード・担当者で検索" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[160px]">
          <option value="">すべての状態</option>
          {Object.entries(ORG_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        {!rows.length ? (
          <Empty>該当するテナントはありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">会社</th>
                  <th>状態</th>
                  <th>プラン</th>
                  <th className="text-right">ユーザー</th>
                  <th className="text-right">稼働タグ</th>
                  <th className="text-right">未登録タグ</th>
                  <th className="text-right">タッチ30日</th>
                  <th>最終利用</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50">
                    <td className="py-2.5">
                      <Link to={`/ops/tenants/${t.id}`} className="font-semibold text-indigo-700">
                        {t.name}
                      </Link>
                      <div className="font-mono text-xs text-slate-500">{t.code}</div>
                    </td>
                    <td>
                      <Badge tone={statusTone(t.status)}>{ORG_STATUS_LABEL[t.status]}</Badge>
                      {t.status === "trial" && t.trial_ends_at && <div className={cx("text-xs", t.trial_ends_at < Date.now() ? "text-red-600" : "text-slate-500")}>〜{fmtDate(t.trial_ends_at)}</div>}
                    </td>
                    <td>{t.plan}</td>
                    <td className="text-right tabular-nums">{t.users}</td>
                    <td className="text-right tabular-nums">{t.tags}</td>
                    <td className="text-right tabular-nums">{t.stock_unregistered || "—"}</td>
                    <td className="text-right tabular-nums">{t.taps30}</td>
                    <td className="text-xs">{fmtAgo(t.last_tap_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <CreateTenant onClose={() => setCreating(false)} onCreated={() => void reload()} />}
    </div>
  );
}

function CreateTenant({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const plans = useApi<{ code: string; name: string }[]>("/ops/plans");
  const nav = useNavigate();
  const [f, setF] = useState({
    name: "",
    code: "",
    plan: "trial",
    status: "trial",
    trialDays: "30",
    siteName: "本社",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    billingEmail: "",
    address: "",
    notes: "",
    adminName: "",
    adminEmail: ""
  });
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; orgCode: string; adminEmail: string; initialPassword: string | null; mailStatus?: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setErr(null);
    try {
      const r = await post<{ id: string; orgCode: string; adminEmail: string; initialPassword: string | null; mailStatus: string }>("/ops/tenants", {
        name: f.name,
        code: f.code,
        plan: f.plan,
        status: f.status,
        trialDays: Number(f.trialDays),
        siteName: f.siteName,
        contactName: f.contactName || null,
        contactEmail: f.contactEmail || null,
        contactPhone: f.contactPhone || null,
        billingEmail: f.billingEmail || null,
        address: f.address || null,
        notes: f.notes || null,
        admin: { name: f.adminName, email: f.adminEmail }
      });
      setResult(r);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (result)
    return (
      <Modal open onClose={onClose} title="テナントを作成しました">
        <div className="space-y-3 text-sm">
          {result.mailStatus === "sent" ? (
            <Alert tone="green">管理者様へご利用開始のご案内メール（初期パスワード記載）を送信しました。</Alert>
          ) : (
            <Alert tone="amber">
              案内メールは送信されていません（{result.mailStatus === "skipped" ? "メール送信サービスが未設定" : "送信失敗・通知履歴を確認"}）。初期パスワードは<b>この画面でのみ</b>表示されます。安全な方法でお伝えください。
            </Alert>
          )}
          <dl className="grid grid-cols-3 gap-y-2 rounded-xl bg-slate-50 p-4">
            <dt className="text-slate-500">ログインURL</dt>
            <dd className="col-span-2 font-mono break-all">{location.origin}/login?next=/admin</dd>
            <dt className="text-slate-500">会社コード</dt>
            <dd className="col-span-2 font-mono">{result.orgCode}</dd>
            <dt className="text-slate-500">管理者メール</dt>
            <dd className="col-span-2 font-mono">{result.adminEmail}</dd>
            <dt className="text-slate-500">初期パスワード</dt>
            <dd className="col-span-2 font-mono font-bold">{result.initialPassword}</dd>
          </dl>
          <Button
            className="w-full"
            onClick={() =>
              void navigator.clipboard.writeText(
                `Intent-Trace ご利用開始のご案内\nログインURL: ${location.origin}/login?next=/admin\n会社コード: ${result.orgCode}\nメールアドレス: ${result.adminEmail}\n初期パスワード: ${result.initialPassword}\n※初回ログイン後、「契約・サポート」画面からパスワードを変更してください。`
              )
            }
          >
            案内文をコピー
          </Button>
          <Button variant="outline" className="w-full" onClick={() => nav(`/ops/tenants/${result.id}`)}>
            テナント詳細へ
          </Button>
        </div>
      </Modal>
    );

  return (
    <Modal open onClose={onClose} title="テナントを作成" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="会社名 *">
          <Input value={f.name} onChange={set("name")} />
        </Field>
        <Field label="会社コード *" hint="作業員ログイン時に入力します（英数字）">
          <Input value={f.code} onChange={set("code")} className="font-mono uppercase" placeholder="TAMA-BM" />
        </Field>
        <Field label="プラン">
          <Select value={f.plan} onChange={set("plan")}>
            {plans.data?.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}（{p.code}）
              </option>
            ))}
          </Select>
        </Field>
        <Field label="契約状態">
          <Select value={f.status} onChange={set("status")}>
            <option value="trial">トライアル</option>
            <option value="active">契約中</option>
          </Select>
        </Field>
        {f.status === "trial" && (
          <Field label="トライアル日数">
            <Input type="number" value={f.trialDays} onChange={set("trialDays")} />
          </Field>
        )}
        <Field label="最初の現場名">
          <Input value={f.siteName} onChange={set("siteName")} />
        </Field>
        <div className="sm:col-span-2 border-t border-slate-100 pt-3 text-sm font-bold">初期管理者</div>
        <Field label="氏名 *">
          <Input value={f.adminName} onChange={set("adminName")} />
        </Field>
        <Field label="メールアドレス *" hint="初期パスワードは自動発行されます">
          <Input type="email" value={f.adminEmail} onChange={set("adminEmail")} />
        </Field>
        <div className="sm:col-span-2 border-t border-slate-100 pt-3 text-sm font-bold">契約・連絡先</div>
        <Field label="担当者名">
          <Input value={f.contactName} onChange={set("contactName")} />
        </Field>
        <Field label="担当者メール">
          <Input value={f.contactEmail} onChange={set("contactEmail")} />
        </Field>
        <Field label="電話番号">
          <Input value={f.contactPhone} onChange={set("contactPhone")} />
        </Field>
        <Field label="請求書送付先メール">
          <Input value={f.billingEmail} onChange={set("billingEmail")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="住所（請求書宛先・タグ送付先）">
            <Input value={f.address} onChange={set("address")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="運営メモ（テナントには非表示）">
            <Textarea rows={2} value={f.notes} onChange={set("notes")} />
          </Field>
        </div>
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
        <Button className="!bg-indigo-700" onClick={save} disabled={!f.name || !f.code || !f.adminName || !f.adminEmail}>
          作成
        </Button>
      </div>
    </Modal>
  );
}
