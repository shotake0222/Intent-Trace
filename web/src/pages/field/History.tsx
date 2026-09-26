import { useApi, useQueue } from "../../lib/hooks";
import { Badge, Card, Empty, assuranceTone } from "../../components/ui";
import { ASSURANCE_LABEL, PURPOSE_LABEL, fmtDateTime } from "../../lib/format";

interface Row {
  id: string;
  occurred_at: number;
  purpose: string;
  assurance: string;
  offline: number;
  label: string;
  site_name: string;
}

export default function History() {
  const { data } = useApi<Row[]>("/my/history");
  const queue = useQueue();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">自分の記録</h1>
      {queue.length > 0 && (
        <Card title="未送信">
          <ul className="space-y-1 text-sm">
            {queue.map((q) => (
              <li key={q.id} className="flex justify-between">
                <span>{q.kind === "tap" ? "タッチ" : q.kind === "inspection" ? "点検" : "ヒヤリハット"}</span>
                <span className="text-slate-500">{fmtDateTime(q.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="タッチ履歴（直近50件）">
        {!data?.length ? (
          <Empty>まだ記録がありません</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2.5">
                <div>
                  <div className="text-sm font-semibold">{r.label}</div>
                  <div className="text-xs text-slate-500">
                    {fmtDateTime(r.occurred_at)} ・ {r.site_name}
                    {r.offline ? " ・ オフライン記録" : ""}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Badge>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</Badge>
                  <Badge tone={assuranceTone(r.assurance)}>{ASSURANCE_LABEL[r.assurance]}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
