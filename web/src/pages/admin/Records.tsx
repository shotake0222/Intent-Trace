import { useMemo, useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Badge, Button, Card, Empty, Input, assuranceTone, resultTone, severityTone, cx } from "../../components/ui";
import { ASSURANCE_LABEL, PURPOSE_LABEL, RESULT_LABEL, SEVERITY_LABEL, fmtDateTime, fmtDuration } from "../../lib/format";

type Tab = "taps" | "inspections" | "incidents" | "audit";

export default function Records() {
  const { siteId } = useAdmin();
  const { me } = useAuth();
  const [tab, setTab] = useState<Tab>("taps");
  const [days, setDays] = useState(7);
  const [month, setMonth] = useState(() => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7));
  const from = useMemo(() => Date.now() - days * 86400_000, [days]);
  const path = tab === "audit" ? "/admin/audit" : `/admin/${tab}?siteId=${siteId}&from=${from}`;
  const { data, loading } = useApi<Record<string, unknown>[]>(path, [path]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">記録・レポート</h1>

      <Card title="元請け・オーナー向け月次報告書">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-slate-700">対象月</span>
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
          </label>
          <a href={`/api/reports/monthly?siteId=${siteId}&month=${month}`} target="_blank" rel="noreferrer">
            <Button>報告書を開く（印刷/PDF）</Button>
          </a>
          <span className="text-xs text-slate-500">点検・巡回・ヒヤリハットを証明レベル付きで自動集計します</span>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl bg-white p-1 text-sm font-semibold ring-1 ring-slate-200">
          {(
            [
              ["taps", "タッチ記録"],
              ["inspections", "点検"],
              ["incidents", "ヒヤリハット"],
              ...(me?.role === "admin" ? [["audit", "監査ログ"]] : [])
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("rounded-lg px-3 py-1.5", tab === k ? "bg-slate-900 text-white" : "text-slate-600")}>
              {l}
            </button>
          ))}
        </div>
        {tab !== "audit" && (
          <div className="flex items-center gap-2">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
              {[1, 7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  直近{d}日
                </option>
              ))}
            </select>
            <a href={`/api/reports/export.csv?type=${tab}&from=${from}`}>
              <Button variant="outline" size="sm">
                CSV出力
              </Button>
            </a>
          </div>
        )}
      </div>

      <Card>
        {loading && !data ? (
          <Empty>読み込み中…</Empty>
        ) : !data?.length ? (
          <Empty>記録がありません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              {tab === "taps" && (
                <>
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="py-2">日時</th>
                      <th>作業員</th>
                      <th>タグ</th>
                      <th>区分</th>
                      <th>証明</th>
                      <th>経路</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.map((r) => (
                      <tr key={r.id as string}>
                        <td className="py-2 whitespace-nowrap">{fmtDateTime(r.occurred_at as number)}</td>
                        <td>{r.user_name as string}</td>
                        <td>
                          {r.tag_label as string}
                          {r.zone_name ? <span className="text-xs text-slate-500"> / {r.zone_name as string}</span> : null}
                        </td>
                        <td>
                          <Badge>{PURPOSE_LABEL[r.purpose as string] ?? (r.purpose as string)}</Badge>
                        </td>
                        <td>
                          <Badge tone={assuranceTone(r.assurance as string)}>{ASSURANCE_LABEL[r.assurance as string]}</Badge>
                        </td>
                        <td className="text-xs text-slate-500">
                          {{ pwa_url: "URL", pwa_webnfc: "アプリ内NFC", reader: "固定リーダー" }[r.source as string]}
                          {r.offline ? "・オフライン" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
              {tab === "inspections" && (
                <>
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="py-2">日時</th>
                      <th>設備</th>
                      <th>結果</th>
                      <th>担当</th>
                      <th>所要</th>
                      <th>写真</th>
                      <th>所見</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.map((r) => (
                      <tr key={r.id as string}>
                        <td className="py-2 whitespace-nowrap">{fmtDateTime(r.completed_at as number)}</td>
                        <td className="font-medium">{r.equipment_name as string}</td>
                        <td>
                          <Badge tone={resultTone(r.result as string)}>{RESULT_LABEL[r.result as string]}</Badge>
                        </td>
                        <td>{r.user_name as string}</td>
                        <td className="tabular-nums">{r.started_at ? fmtDuration(((r.completed_at as number) - (r.started_at as number)) / 1000) : "—"}</td>
                        <td>
                          {(r.photoKeys as string[]).map((k) => (
                            <a key={k} href={`/api/files/${k}`} target="_blank" rel="noreferrer" className="mr-1 text-sky-700">
                              📷
                            </a>
                          ))}
                        </td>
                        <td className="max-w-xs text-xs text-slate-600">{r.note as string}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
              {tab === "incidents" && (
                <>
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="py-2">日時</th>
                      <th>区分</th>
                      <th>重要度</th>
                      <th>内容</th>
                      <th>関係者</th>
                      <th>距離</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.map((r) => (
                      <tr key={r.id as string}>
                        <td className="py-2 whitespace-nowrap">{fmtDateTime(r.occurred_at as number)}</td>
                        <td>{{ ble: "BLE接近", manual: "報告", deadman: "生存確認", interlock: "手順違反" }[r.source as string]}</td>
                        <td>
                          <Badge tone={severityTone(r.severity as string)}>{SEVERITY_LABEL[r.severity as string]}</Badge>
                        </td>
                        <td>
                          {r.title as string}
                          {r.note ? <div className="text-xs text-slate-500">{r.note as string}</div> : null}
                        </td>
                        <td>{(r.user_name as string) ?? "—"}</td>
                        <td className="tabular-nums">{r.distance_m != null ? `${(r.distance_m as number).toFixed(1)}m` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
              {tab === "audit" && (
                <>
                  <thead className="text-left text-xs text-slate-500">
                    <tr>
                      <th className="py-2">日時</th>
                      <th>操作者</th>
                      <th>操作</th>
                      <th>詳細</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.map((r) => (
                      <tr key={r.id as string}>
                        <td className="py-2 whitespace-nowrap">{fmtDateTime(r.created_at as number)}</td>
                        <td>{(r.actor_name as string) ?? "—"}</td>
                        <td className="font-mono text-xs">{r.action as string}</td>
                        <td className="max-w-md truncate font-mono text-xs text-slate-500">{r.detail_json as string}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
