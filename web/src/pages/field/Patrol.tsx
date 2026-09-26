import { useState } from "react";
import { useApi } from "../../lib/hooks";
import { ApiError, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Spinner, cx } from "../../components/ui";
import { fmtTime } from "../../lib/format";

interface Route {
  id: string;
  name: string;
  site_name: string;
  points: number;
  enforce_order: number;
  time_limit_min: number | null;
}
interface Current {
  runId: string;
  routeName: string;
  enforceOrder: boolean;
  nextSeq: number;
  total: number;
  points: { seq: number; tag_id: string; label: string; zone_name: string | null; visited_at: number | null }[];
}

export default function Patrol() {
  const routes = useApi<Route[]>("/patrol/routes");
  const cur = useApi<Current | null>("/patrol/current");
  const [err, setErr] = useState<string | null>(null);

  async function start(id: string) {
    setErr(null);
    try {
      await post("/patrol/runs", { routeId: id });
      await cur.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "通信エラー");
    }
  }

  if (cur.loading && !cur.data) return <div className="py-20 text-center"><Spinner /></div>;

  if (cur.data) {
    const c = cur.data;
    const visited = c.points.filter((p) => p.visited_at).length;
    return (
      <div className="space-y-4">
        <Card title={`巡回中: ${c.routeName}`} action={<Badge tone="blue">{visited}/{c.total}</Badge>}>
          <p className="mb-3 text-sm text-slate-600">{c.enforceOrder ? "番号順に各地点のタグへタッチしてください。" : "各地点のタグへタッチしてください（順不同）。"}</p>
          <ol className="space-y-2">
            {c.points.map((p) => (
              <li key={p.seq} className={cx("flex items-center gap-3 rounded-xl p-3", p.visited_at ? "bg-emerald-50" : p.seq === c.nextSeq ? "bg-amber-50 ring-2 ring-amber-400" : "bg-slate-50")}>
                <span className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold", p.visited_at ? "bg-emerald-600 text-white" : "bg-white ring-1 ring-slate-300")}>
                  {p.visited_at ? "✓" : p.seq}
                </span>
                <div className="flex-1">
                  <div className="font-semibold">{p.label}</div>
                  {p.zone_name && <div className="text-xs text-slate-500">{p.zone_name}</div>}
                </div>
                <span className="text-xs text-slate-500">{p.visited_at ? fmtTime(p.visited_at) : ""}</span>
              </li>
            ))}
          </ol>
        </Card>
        <Button
          variant="ghost"
          className="w-full"
          onClick={async () => {
            if (!confirm("巡回を中断しますか？")) return;
            await post(`/patrol/runs/${c.runId}/abandon`);
            await cur.reload();
          }}
        >
          巡回を中断
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">巡回ルートを選択</h1>
      {err && <Alert>{err}</Alert>}
      {routes.data?.length === 0 && <Empty>巡回ルートが登録されていません</Empty>}
      {routes.data?.map((r) => (
        <Card key={r.id}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs text-slate-500">{r.site_name}</div>
              <div className="font-bold">{r.name}</div>
              <div className="text-xs text-slate-500">
                {r.points}地点{r.enforce_order ? "・順序あり" : ""}
                {r.time_limit_min ? `・目安${r.time_limit_min}分` : ""}
              </div>
            </div>
            <Button onClick={() => void start(r.id)}>開始</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
