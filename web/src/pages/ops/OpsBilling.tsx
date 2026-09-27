import { useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../lib/hooks";
import { ApiError, patch, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Input, Select, Stat } from "../../components/ui";
import { INVOICE_STATUS_LABEL, fmtDate, yen } from "../../lib/format";

interface Invoice {
  id: string;
  number: string;
  org_id: string;
  org_name: string;
  period: string;
  plan_code: string;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  issued_at: number | null;
  due_at: number | null;
  paid_at: number | null;
}

export default function OpsBilling() {
  const [period, setPeriod] = useState(() => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7));
  const [status, setStatus] = useState("");
  const q = new URLSearchParams({ ...(period ? { period } : {}), ...(status ? { status } : {}) }).toString();
  const { data, reload } = useApi<Invoice[]>(`/ops/invoices?${q}`, [q]);
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      if (ok) setMsg({ tone: "green", text: ok });
      await reload();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const rows = data ?? [];
  const sum = (s: string) => rows.filter((r) => r.status === s).reduce((a, r) => a + r.total, 0);
  const overdue = rows.filter((r) => r.status === "issued" && r.due_at && r.due_at < Date.now());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">請求</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
            <option value="">全状態</option>
            {Object.entries(INVOICE_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Button
            className="!bg-indigo-700"
            disabled={!period}
            onClick={() =>
              act(async () => {
                const r = await post<{ created: number; skipped: number }>("/ops/invoices/generate", { period });
                setMsg({ tone: "green", text: `${period} の請求書下書きを ${r.created} 件作成（既存 ${r.skipped} 件はスキップ）` });
              }, "作成しました")
            }
          >
            {period} 分の請求書を作成
          </Button>
        </div>
      </div>
      <Alert tone="blue">契約中（active）のテナントについて、その時点の稼働タグ数・ユーザー数から下書きを作成します。内容を確認して「発行」するとテナントの管理画面に表示され、請求書送付先へメールで通知されます。</Alert>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="下書き" value={yen(sum("draft"))} />
        <Stat label="発行済（未入金）" value={yen(sum("issued"))} />
        <Stat label="入金済" value={yen(sum("paid"))} />
        <Stat label="支払期限超過" value={overdue.length} tone={overdue.length ? "red" : undefined} />
      </div>
      <Card>
        {!rows.length ? (
          <Empty>請求書はありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">請求番号</th>
                  <th>テナント</th>
                  <th>対象月</th>
                  <th className="text-right">税込</th>
                  <th>状態</th>
                  <th>期限</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2 font-mono text-xs">
                      <a href={`/api/ops/invoices/${i.id}/print`} target="_blank" rel="noreferrer" className="text-indigo-700">
                        {i.number}
                      </a>
                    </td>
                    <td>
                      <Link to={`/ops/tenants/${i.org_id}`} className="text-indigo-700">
                        {i.org_name}
                      </Link>
                    </td>
                    <td>{i.period}</td>
                    <td className="text-right tabular-nums">{yen(i.total)}</td>
                    <td>
                      <Badge tone={i.status === "paid" ? "green" : i.status === "issued" ? "blue" : i.status === "void" ? "red" : "slate"}>{INVOICE_STATUS_LABEL[i.status]}</Badge>
                    </td>
                    <td className={`text-xs ${i.status === "issued" && i.due_at && i.due_at < Date.now() ? "font-bold text-red-600" : ""}`}>{fmtDate(i.due_at)}</td>
                    <td className="text-right whitespace-nowrap">
                      {i.status === "draft" && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act(() => post(`/ops/invoices/${i.id}/recalculate`), "再計算しました")}>
                            再計算
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(() => patch(`/ops/invoices/${i.id}`, { status: "issued" }), "発行しました")}>
                            発行
                          </Button>
                        </>
                      )}
                      {i.status === "issued" && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => act(async () => {
                            const r = await post<{ recipients: number }>(`/ops/invoices/${i.id}/send`);
                            setMsg({ tone: "green", text: `請求書メールを ${r.recipients} 件の宛先に送信しました（結果は通知履歴）` });
                          }, "")}>
                            メール再送
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => act(() => patch(`/ops/invoices/${i.id}`, { status: "paid" }), "入金済みにしました")}>
                            入金確認
                          </Button>
                        </>
                      )}
                      {i.status !== "void" && i.status !== "paid" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (confirm("この請求書を無効にしますか？")) void act(() => patch(`/ops/invoices/${i.id}`, { status: "void" }), "無効にしました");
                          }}
                        >
                          無効
                        </Button>
                      )}
                    </td>
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
