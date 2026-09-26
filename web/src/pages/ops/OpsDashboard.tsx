import { Link } from "react-router";
import { useApi } from "../../lib/hooks";
import { Badge, Card, Empty, Stat } from "../../components/ui";
import { DailyBars } from "../../components/charts";
import { ORG_STATUS_LABEL, STOCK_STATUS_LABEL, ITEM_TYPE_LABEL, fmtDate, yen } from "../../lib/format";

interface Dash {
  tenants: { total: number; byStatus: Record<string, number>; byPlan: Record<string, number> };
  totals: { users: number; tags: number; devices: number; taps30: number; incidents30: number; active_orgs: number };
  mrr: number;
  stock: { status: string; item_type: string; n: number }[];
  openTickets: number;
  daily: { date: string; taps: number; orgs: number }[];
  trialsEnding: { id: string; name: string; trial_ends_at: number }[];
}

export default function OpsDashboard() {
  const { data: d } = useApi<Dash>("/ops/dashboard");
  if (!d) return <Empty>読み込み中…</Empty>;
  const stockBy = (status: string) => d.stock.filter((s) => s.status === status).reduce((a, s) => a + s.n, 0);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">運営ダッシュボード</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="契約テナント" value={d.tenants.byStatus.active ?? 0} sub={`トライアル ${d.tenants.byStatus.trial ?? 0}・停止 ${d.tenants.byStatus.suspended ?? 0}`} />
        <Stat label="MRR（税抜・試算）" value={yen(d.mrr)} />
        <Stat label="稼働タグ" value={d.totals.tags} sub={`デバイス ${d.totals.devices}`} />
        <Stat label="有効ユーザー" value={d.totals.users} />
        <Stat label="タッチ（30日）" value={d.totals.taps30} sub={`稼働テナント ${d.totals.active_orgs}`} />
        <Stat label="未回答の問い合わせ" value={d.openTickets} tone={d.openTickets ? "amber" : undefined} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="全テナントの日別タッチ件数（30日）" className="xl:col-span-2">
          <DailyBars data={d.daily} valueKey="taps" label="タッチ" />
        </Card>
        <div className="space-y-6">
          <Card title="タグ在庫" action={<Link to="/ops/stock" className="text-sm text-indigo-700">管理 ›</Link>}>
            <ul className="space-y-1 text-sm">
              {(["in_stock", "allocated", "registered", "retired"] as const).map((s) => (
                <li key={s} className="flex justify-between">
                  <span>{STOCK_STATUS_LABEL[s]}</span>
                  <b className="tabular-nums">{stockBy(s)}</b>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-1">
              {d.stock
                .filter((s) => s.status === "in_stock")
                .map((s) => (
                  <Badge key={s.item_type}>
                    {ITEM_TYPE_LABEL[s.item_type]} 在庫 {s.n}
                  </Badge>
                ))}
            </div>
          </Card>
          <Card title="プラン別テナント">
            <ul className="space-y-1 text-sm">
              {Object.entries(d.tenants.byPlan).map(([k, v]) => (
                <li key={k} className="flex justify-between">
                  <span>{k}</span>
                  <b>{v}</b>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(d.tenants.byStatus).map(([k, v]) => (
                <Badge key={k}>
                  {ORG_STATUS_LABEL[k]} {v}
                </Badge>
              ))}
            </div>
          </Card>
          <Card title="トライアル期限">
            {!d.trialsEnding.length ? (
              <Empty>トライアル中のテナントはありません</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {d.trialsEnding.map((t) => (
                  <li key={t.id} className="flex justify-between">
                    <Link to={`/ops/tenants/${t.id}`} className="text-indigo-700">
                      {t.name}
                    </Link>
                    <span className={t.trial_ends_at < Date.now() ? "font-bold text-red-600" : ""}>{fmtDate(t.trial_ends_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
