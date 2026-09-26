import { useMemo, useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { Alert, Card, Empty, cx } from "../../components/ui";
import { DowHourHeatmap, ZoneMap } from "../../components/charts";
import { fmtDuration } from "../../lib/format";

interface Heat {
  zones: { id: string; name: string; floor: string | null; pos_x: number | null; pos_y: number | null; incidents: number; danger: number; taps: number }[];
  equipment: { id: string; name: string; incidents: number; danger: number; min_distance: number | null }[];
  dowHour: number[][];
  byUser: { id: string; name: string; incidents: number; danger: number; ble: number }[];
}
interface Duration {
  id: string;
  name: string;
  category: string | null;
  n: number;
  avg_sec: number;
  max_sec: number;
  ng: number;
}

export default function Analytics() {
  const { siteId } = useAdmin();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"incidents" | "taps">("incidents");
  const from = useMemo(() => Date.now() - days * 86400_000, [days]);
  const heat = useApi<Heat>(`/analytics/heatmap?siteId=${siteId}&from=${from}`, [siteId, from]);
  const dur = useApi<Duration[]>(`/analytics/inspection-durations?siteId=${siteId}&from=${from}`, [siteId, from]);

  if (heat.error?.message.includes("上位プラン"))
    return (
      <Alert tone="amber">
        ヒートマップ・所要時間分析は <b>Pro プラン</b>の機能です。プラン変更については運営までお問い合わせください。
      </Alert>
    );

  const maxDur = Math.max(1, ...(dur.data ?? []).map((d) => d.avg_sec));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">分析・ヒートマップ</h1>
        <div className="flex rounded-xl bg-white p-1 text-sm font-semibold ring-1 ring-slate-200">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cx("rounded-lg px-3 py-1.5", days === d ? "bg-slate-900 text-white" : "text-slate-600")}>
              {d}日
            </button>
          ))}
        </div>
      </div>

      <Card
        title="ゾーン別ヒートマップ"
        action={
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold">
            {(
              [
                ["incidents", "ヒヤリハット"],
                ["taps", "タッチ（動線）"]
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setMetric(k)} className={cx("rounded-md px-2.5 py-1", metric === k ? "bg-white shadow-sm" : "text-slate-500")}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        {heat.data ? <ZoneMap zones={heat.data.zones} metric={metric} /> : <Empty>読み込み中…</Empty>}
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="ヒヤリハット発生：曜日 × 時間帯">{heat.data ? <DowHourHeatmap grid={heat.data.dowHour} /> : <Empty>読み込み中…</Empty>}</Card>

        <Card title="作業員別ヒヤリハット">
          {!heat.data?.byUser.length ? (
            <Empty>該当なし</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1">作業員</th>
                  <th className="text-right">件数</th>
                  <th className="text-right">うち危険</th>
                  <th className="text-right">BLE接近</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {heat.data.byUser.map((u) => (
                  <tr key={u.id}>
                    <td className="py-2 font-medium">{u.name}</td>
                    <td className="text-right tabular-nums">{u.incidents}</td>
                    <td className={cx("text-right tabular-nums", u.danger > 0 && "font-bold text-red-600")}>{u.danger}</td>
                    <td className="text-right tabular-nums">{u.ble}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="重機別の接近検知（BLE）">
          {!heat.data?.equipment.length ? (
            <Empty>接近検知はありません</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1">設備</th>
                  <th className="text-right">件数</th>
                  <th className="text-right">危険</th>
                  <th className="text-right">最接近</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {heat.data.equipment.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 font-medium">{e.name}</td>
                    <td className="text-right tabular-nums">{e.incidents}</td>
                    <td className="text-right tabular-nums">{e.danger}</td>
                    <td className="text-right tabular-nums">{e.min_distance != null ? `${e.min_distance.toFixed(1)}m` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="点検に時間がかかっている設備（平均所要時間）">
          {!dur.data?.length ? (
            <Empty>所要時間のデータがありません</Empty>
          ) : (
            <ul className="space-y-2.5">
              {dur.data.map((d) => (
                <li key={d.id} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{d.name}</span>
                    <span className="text-slate-500 tabular-nums">
                      平均 <b className="text-slate-900">{fmtDuration(d.avg_sec)}</b>・最大 {fmtDuration(d.max_sec)}・{d.n}件{d.ng ? `・異常${d.ng}` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-slate-100">
                    <div className="h-2 rounded-full bg-[#2a78d6]" style={{ width: `${(d.avg_sec / maxDur) * 100}%` }} />
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
