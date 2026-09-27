import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../../lib/hooks";
import { ApiError, patch, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Stat, Textarea } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { DailyBars } from "../../components/charts";
import { statusTone } from "./OpsTenants";
import { INVOICE_STATUS_LABEL, ITEM_TYPE_LABEL, ORG_STATUS_LABEL, STOCK_STATUS_LABEL, TICKET_STATUS_LABEL, fmtDate, fmtDateTime, yen } from "../../lib/format";

interface Detail {
  org: Record<string, string | number | null> & { id: string; name: string; code: string; status: string; plan: string };
  contract: { plan: { name: string; features: string[] }; limits: { tags: number | null; users: number | null; sites: number | null } };
  usage: { tags: number; users: number; sites: number; devices: number; stock_unregistered: number };
  estimate: { items: { label: string; qty: number; unit: number; amount: number }[]; subtotal: number; tax: number; total: number };
  sites: { id: string; name: string }[];
  admins: { id: string; name: string; email: string; role: string; active: number }[];
  invoices: { id: string; number: string; period: string; total: number; status: string }[];
  tickets: { id: string; subject: string; status: string; updated_at: number }[];
  stock: { item_type: string; status: string; n: number }[];
  daily: { date: string; taps: number }[];
}

export default function OpsTenantDetail() {
  const { id = "" } = useParams();
  const { data: d, reload } = useApi<Detail>(`/ops/tenants/${id}`, [id]);
  const plans = useApi<{ code: string; name: string }[]>("/ops/plans");
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);
  const [alloc, setAlloc] = useState(false);
  const [imp, setImp] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!d) return;
    const o = d.org;
    setF({
      name: String(o.name ?? ""),
      plan: String(o.plan ?? ""),
      status: String(o.status ?? ""),
      trialEndsAt: o.trial_ends_at ? new Date(Number(o.trial_ends_at) + 9 * 3600e3).toISOString().slice(0, 10) : "",
      contactName: String(o.contact_name ?? ""),
      contactEmail: String(o.contact_email ?? ""),
      contactPhone: String(o.contact_phone ?? ""),
      billingEmail: String(o.billing_email ?? ""),
      address: String(o.address ?? ""),
      notes: String(o.notes ?? ""),
      maxTagsOverride: o.max_tags_override != null ? String(o.max_tags_override) : "",
      maxUsersOverride: o.max_users_override != null ? String(o.max_users_override) : ""
    });
  }, [d]);
  if (!d) return <Empty>読み込み中…</Empty>;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "green", text: ok });
      await reload();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };

  const save = () =>
    run(
      () =>
        patch(`/ops/tenants/${id}`, {
          name: f.name,
          plan: f.plan,
          status: f.status,
          trialEndsAt: f.trialEndsAt ? new Date(`${f.trialEndsAt}T23:59:59+09:00`).getTime() : null,
          contactName: f.contactName,
          contactEmail: f.contactEmail,
          contactPhone: f.contactPhone,
          billingEmail: f.billingEmail,
          address: f.address,
          notes: f.notes,
          maxTagsOverride: f.maxTagsOverride === "" ? null : Number(f.maxTagsOverride),
          maxUsersOverride: f.maxUsersOverride === "" ? null : Number(f.maxUsersOverride)
        }),
      "契約情報を保存しました"
    );

  const lim = (v: number | null) => (v == null ? "無制限" : v);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/ops/tenants" className="text-sm text-indigo-700">
            ‹ テナント一覧
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold">
            {d.org.name} <Badge tone={statusTone(d.org.status)}>{ORG_STATUS_LABEL[d.org.status]}</Badge>
          </h1>
          <div className="text-sm text-slate-500">
            会社コード <span className="font-mono">{d.org.code}</span> ・ {d.contract.plan.name}プラン ・ 登録 {fmtDate(Number(d.org.created_at))}
            {" ・ "}
            {d.org.terms_accepted_at ? (
              <span>利用規約 同意済（{String(d.org.terms_version)}・{fmtDate(Number(d.org.terms_accepted_at))}）</span>
            ) : (
              <span className="font-semibold text-amber-700">利用規約 未同意</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setImp(true)}>
            代理ログイン
          </Button>
          <Button variant="outline" onClick={() => setAlloc(true)}>
            タグを出荷割当
          </Button>
          {d.org.status === "suspended" ? (
            <Button onClick={() => run(() => patch(`/ops/tenants/${id}`, { status: "active" }), "利用を再開しました")}>利用再開</Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                if (confirm("このテナントの利用を停止しますか？（全ユーザーがログインできなくなります）")) void run(() => patch(`/ops/tenants/${id}`, { status: "suspended" }), "利用を停止しました");
              }}
            >
              利用停止
            </Button>
          )}
        </div>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="稼働タグ" value={`${d.usage.tags} / ${lim(d.contract.limits.tags)}`} />
        <Stat label="ユーザー" value={`${d.usage.users} / ${lim(d.contract.limits.users)}`} />
        <Stat label="現場" value={`${d.usage.sites} / ${lim(d.contract.limits.sites)}`} />
        <Stat label="未登録タグ（出荷済）" value={d.usage.stock_unregistered} />
        <Stat label="今月請求見込（税込）" value={yen(d.estimate.total)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="契約情報" className="xl:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="会社名">
              <Input value={f.name ?? ""} onChange={set("name")} />
            </Field>
            <Field label="プラン">
              <Select value={f.plan ?? ""} onChange={set("plan")}>
                {plans.data?.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}（{p.code}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="契約状態">
              <Select value={f.status ?? ""} onChange={set("status")}>
                {Object.entries(ORG_STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="トライアル終了日">
              <Input type="date" value={f.trialEndsAt ?? ""} onChange={set("trialEndsAt")} />
            </Field>
            <Field label="タグ上限（個別契約）" hint="空欄でプラン既定">
              <Input type="number" value={f.maxTagsOverride ?? ""} onChange={set("maxTagsOverride")} />
            </Field>
            <Field label="ユーザー上限（個別契約）" hint="空欄でプラン既定">
              <Input type="number" value={f.maxUsersOverride ?? ""} onChange={set("maxUsersOverride")} />
            </Field>
            <Field label="担当者名">
              <Input value={f.contactName ?? ""} onChange={set("contactName")} />
            </Field>
            <Field label="担当者メール">
              <Input value={f.contactEmail ?? ""} onChange={set("contactEmail")} />
            </Field>
            <Field label="電話番号">
              <Input value={f.contactPhone ?? ""} onChange={set("contactPhone")} />
            </Field>
            <Field label="請求書送付先">
              <Input value={f.billingEmail ?? ""} onChange={set("billingEmail")} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="住所">
                <Input value={f.address ?? ""} onChange={set("address")} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="運営メモ（テナント非表示）">
                <Textarea rows={3} value={f.notes ?? ""} onChange={set("notes")} />
              </Field>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button className="!bg-indigo-700" onClick={save}>
              保存
            </Button>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="今月の請求見込">
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
              <li className="flex justify-between border-t border-slate-100 pt-1">
                <span>税込合計</span>
                <b className="tabular-nums">{yen(d.estimate.total)}</b>
              </li>
            </ul>
          </Card>
          <Card title="管理者アカウント">
            <ul className="space-y-2 text-sm">
              {d.admins.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold">
                      {a.name} <span className="text-xs text-slate-500">{a.role === "admin" ? "管理者" : "マネージャー"}</span>
                    </div>
                    <div className="text-xs text-slate-500">{a.email}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (!confirm(`${a.name} さんのパスワードを再発行しますか？`)) return;
                      try {
                        const r = await post<{ temporaryPassword: string; mailStatus: string | null }>(`/ops/tenants/${id}/users/${a.id}/reset-password`);
                        setMsg({ tone: "amber", text: `${a.name} さんの仮パスワード: ${r.temporaryPassword}（この表示は再度出ません）${r.mailStatus === "sent" ? " ／ ご本人にメールで通知しました" : ""}` });
                      } catch (e) {
                        setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
                      }
                    }}
                  >
                    PW再発行
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="NFCハードウェア">
            {!d.stock.length ? (
              <Empty>出荷実績はありません</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.stock.map((s) => (
                  <li key={s.item_type + s.status} className="flex justify-between">
                    <span>
                      {ITEM_TYPE_LABEL[s.item_type]}・{STOCK_STATUS_LABEL[s.status]}
                    </span>
                    <b>{s.n}</b>
                  </li>
                ))}
              </ul>
            )}
            <a href={`/api/ops/stock/labels?orgId=${id}`} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-indigo-700">
              このテナント宛のラベルを印刷 ›
            </a>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="利用状況（30日のタッチ）" className="xl:col-span-2">
          <DailyBars data={d.daily} valueKey="taps" label="タッチ" />
        </Card>
        <div className="space-y-6">
          <Card title="請求書" action={<Link to="/ops/billing" className="text-sm text-indigo-700">請求管理 ›</Link>}>
            {!d.invoices.length ? (
              <Empty>請求書はまだありません</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <a href={`/api/ops/invoices/${i.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-700">
                      {i.period}
                    </a>
                    <span>
                      {yen(i.total)} <Badge>{INVOICE_STATUS_LABEL[i.status]}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="問い合わせ">
            {!d.tickets.length ? (
              <Empty>問い合わせはありません</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.tickets.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2">
                    <Link to={`/ops/support?ticket=${t.id}`} className="truncate text-indigo-700">
                      {t.subject}
                    </Link>
                    <Badge>{TICKET_STATUS_LABEL[t.status]}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {alloc && <AllocateModal orgId={id} onClose={() => setAlloc(false)} onDone={(n) => (setAlloc(false), setMsg({ tone: "green", text: `${n} 件を出荷割当しました` }), void reload())} />}
      {imp && <ImpersonateModal orgId={id} admins={d.admins} onClose={() => setImp(false)} />}
    </div>
  );
}

export function AllocateModal({ orgId, onClose, onDone }: { orgId?: string; onClose: () => void; onDone: (n: number) => void }) {
  const tenants = useApi<{ id: string; name: string }[]>(orgId ? null : "/ops/tenants");
  const summary = useApi<{ batch: string; item_type: string; chip: string; status: string; n: number }[]>("/ops/stock/summary");
  const [f, setF] = useState({ orgId: orgId ?? "", itemType: "location_tag", batch: "", count: "10", ids: "", shipmentNote: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const batches = (summary.data ?? []).filter((s) => s.status === "in_stock" && s.item_type === f.itemType);
  const available = batches.filter((b) => !f.batch || b.batch === f.batch).reduce((a, b) => a + b.n, 0);
  return (
    <Modal open onClose={onClose} title="タグ・社員証の出荷割当">
      <div className="space-y-4">
        {!orgId && (
          <Field label="出荷先テナント">
            <Select value={f.orgId} onChange={set("orgId")}>
              <option value="">選択</option>
              {tenants.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="種類">
          <Select value={f.itemType} onChange={set("itemType")}>
            <option value="location_tag">設置タグ</option>
            <option value="badge">社員証</option>
          </Select>
        </Field>
        <Field label="ロット（任意）">
          <Select value={f.batch} onChange={set("batch")}>
            <option value="">指定なし（古い順）</option>
            {batches.map((b) => (
              <option key={b.batch + b.chip} value={b.batch}>
                {b.batch}（{b.chip}・在庫 {b.n}）
              </option>
            ))}
          </Select>
        </Field>
        <Field label="枚数" hint={`在庫 ${available} 枚`}>
          <Input type="number" min={1} value={f.count} onChange={set("count")} />
        </Field>
        <Field label="または登録コードを直接指定（改行・カンマ区切り）">
          <Textarea rows={2} value={f.ids} onChange={set("ids")} className="font-mono text-xs" />
        </Field>
        <Field label="出荷メモ（送り状番号など）">
          <Input value={f.shipmentNote} onChange={set("shipmentNote")} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full !bg-indigo-700"
          disabled={!f.orgId}
          onClick={async () => {
            setErr(null);
            const ids = f.ids
              .split(/[\s,]+/)
              .map((x) => x.replace(/[^0-9A-Za-z]/g, "").toUpperCase())
              .filter(Boolean);
            try {
              const r = await post<{ allocated: number }>("/ops/stock/allocate", {
                orgId: f.orgId,
                ...(ids.length ? { ids } : { itemType: f.itemType, batch: f.batch || undefined, count: Number(f.count) }),
                shipmentNote: f.shipmentNote || null
              });
              onDone(r.allocated);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          割り当てる
        </Button>
      </div>
    </Modal>
  );
}

function ImpersonateModal({ orgId, admins, onClose }: { orgId: string; admins: { id: string; name: string; role: string }[]; onClose: () => void }) {
  const [userId, setUserId] = useState(admins.find((a) => a.role === "admin")?.id ?? "");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="代理ログイン（サポート用）">
      <div className="space-y-4">
        <Alert tone="amber">
          テナントの管理者として<b>1時間だけ</b>操作できます。操作内容は運営とテナント双方の監査ログに記録され、テナント画面には「運営が代理ログイン中」と表示されます。
        </Alert>
        <Field label="ログインするアカウント">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {admins.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.role === "admin" ? "管理者" : "マネージャー"}）
              </option>
            ))}
          </Select>
        </Field>
        <Field label="理由 *">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="問い合わせ #123 のタグ設定確認" />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full !bg-indigo-700"
          disabled={reason.length < 2}
          onClick={async () => {
            try {
              const r = await post<{ redirect: string }>(`/ops/tenants/${orgId}/impersonate`, { userId, reason });
              window.open(r.redirect, "_blank");
              onClose();
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          新しいタブで開く
        </Button>
        <p className="text-xs text-slate-500">※ 同じブラウザで開いているテナント画面のログイン状態は、代理ログインで上書きされます。{fmtDateTime(Date.now())}</p>
      </div>
    </Modal>
  );
}
