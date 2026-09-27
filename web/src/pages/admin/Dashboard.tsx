import { useEffect, useRef, useState } from "react";
import type { LiveEvent, LockState } from "../../../../shared/types";
import { useAdmin } from "./AdminLayout";
import { useAuth } from "../../lib/auth";
import { useApi, useInterval, useNow } from "../../lib/hooks";
import { post } from "../../lib/api";
import { Badge, Button, Card, Empty, Stat, assuranceTone, severityTone, cx } from "../../components/ui";
import { DailyBars } from "../../components/charts";
import { ASSURANCE_LABEL, PURPOSE_LABEL, SEVERITY_LABEL, fmtAgo, fmtDate, fmtTime } from "../../lib/format";

interface Summary {
  taps: { total: number; highAssurance: number; offline: number; activeUsers: number };
  inspections: { total: number; ng: number; avgDurationSec: number | null };
  incidents: { total: number; danger: number; ble: number };
  patrols: { total: number; completed: number };
  openAlerts: { total: number; danger: number };
  overdueEquipment: { id: string; name: string; last: number | null; inspection_interval_days: number }[];
  daily: { date: string; taps: number; incidents: number }[];
}
interface AlertRow {
  id: string;
  site_id: string;
  type: string;
  severity: string;
  message: string;
  created_at: number;
  user_name: string | null;
}
interface EquipmentRow {
  id: string;
  name: string;
  site_id: string;
  lockable: number;
  lock: LockState | null;
}
interface DeadmanRow {
  id: string;
  user_name: string;
  site_name: string;
  site_id: string;
  interval_sec: number;
  state: { deadlineAt: number; phase: string } | null;
}

export default function Dashboard() {
  const { siteId } = useAdmin();
  const { me } = useAuth();
  const [range] = useState(() => ({ from: Date.now() - 14 * 86400_000 }));
  const summary = useApi<Summary>(`/analytics/summary?siteId=${siteId}&from=${range.from}`, [siteId]);
  const alerts = useApi<AlertRow[]>("/admin/alerts?open=1");
  const equipment = useApi<EquipmentRow[]>(`/admin/equipment?siteId=${siteId}`, [siteId]);
  const deadman = useApi<DeadmanRow[]>("/admin/deadman");
  const [feed, setFeed] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const now = useNow(1000);
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => {
    void alerts.reload();
    void deadman.reload();
  };

  // リアルタイム購読（Durable Object SiteHub への WebSocket）
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let ping: ReturnType<typeof setInterval>;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/sites/${siteId}`);
      ws.onopen = () => {
        setConnected(true);
        ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
      };
      ws.onmessage = (m) => {
        if (m.data === "pong") return;
        const ev = JSON.parse(m.data) as LiveEvent | { type: "hello" };
        if (ev.type === "hello") return;
        setFeed((f) => [ev as LiveEvent, ...f].slice(0, 60));
        if (ev.type === "alert" || ev.type === "deadman") reloadRef.current();
        if (ev.type === "lock") void equipment.reload();
        if (ev.type === "alert" && (ev as LiveEvent).data.severity === "danger" && "vibrate" in navigator) navigator.vibrate(400);
      };
      ws.onclose = () => {
        setConnected(false);
        clearInterval(ping);
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useInterval(() => void summary.reload(), 60_000);

  const s = summary.data;
  const siteAlerts = (alerts.data ?? []).filter((a) => a.site_id === siteId);
  const dangerAlerts = siteAlerts.filter((a) => a.severity === "danger");
  const locks = (equipment.data ?? []).filter((e) => e.lockable);
  const dms = (deadman.data ?? []).filter((d) => d.site_id === siteId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">ダッシュボード</h1>
        <span className={cx("flex items-center gap-1.5 text-xs font-semibold", connected ? "text-emerald-600" : "text-slate-400")}>
          <span className={cx("h-2 w-2 rounded-full", connected ? "animate-pulse bg-emerald-500" : "bg-slate-300")} />
          {connected ? "リアルタイム接続中" : "接続待ち"}
        </span>
      </div>

      <UndeliveredBanner />
      <RejectedCard />

      {dangerAlerts.length > 0 && (
        <div className="space-y-2">
          {dangerAlerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 rounded-2xl bg-red-600 p-4 text-white shadow-lg">
              <div>
                <div className="font-bold">⚠ {a.message}</div>
                <div className="text-xs text-red-100">{fmtAgo(a.created_at)}</div>
              </div>
              <Button variant="outline" size="sm" onClick={async () => (await post(`/admin/alerts/${a.id}/ack`), alerts.reload())}>
                対応済みにする
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="タッチ（14日）" value={s?.taps.total ?? "—"} sub={s ? `暗号検証 ${s.taps.highAssurance}` : undefined} />
        <Stat label="稼働作業員" value={s?.taps.activeUsers ?? "—"} />
        <Stat label="点検" value={s?.inspections.total ?? "—"} sub={s ? `異常 ${s.inspections.ng}` : undefined} tone={s?.inspections.ng ? "amber" : undefined} />
        <Stat label="巡回完了" value={s ? `${s.patrols.completed}/${s.patrols.total}` : "—"} />
        <Stat label="ヒヤリハット" value={s?.incidents.total ?? "—"} sub={s && me?.features.includes("devices") ? `BLE接近 ${s.incidents.ble}` : undefined} tone={s?.incidents.danger ? "red" : undefined} />
        <Stat label="未対応アラート" value={siteAlerts.length} tone={dangerAlerts.length ? "red" : siteAlerts.length ? "amber" : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="日別タッチ件数（14日間）">{s ? <DailyBars data={s.daily} valueKey="taps" label="タッチ" /> : <Empty>読み込み中…</Empty>}</Card>

          <Card title="未対応アラート">
            {siteAlerts.length === 0 ? (
              <Empty>未対応のアラートはありません</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {siteAlerts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <Badge tone={severityTone(a.severity)}>{SEVERITY_LABEL[a.severity]}</Badge>
                      <div>
                        <div className="text-sm">{a.message}</div>
                        <div className="text-xs text-slate-500">{fmtAgo(a.created_at)}</div>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={async () => (await post(`/admin/alerts/${a.id}/ack`), alerts.reload())}>
                      確認
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {s && s.overdueEquipment.length > 0 && (
            <Card title={`点検期限切れの設備（${s.overdueEquipment.length}）`}>
              <ul className="divide-y divide-slate-100 text-sm">
                {s.overdueEquipment.map((e) => (
                  <li key={e.id} className="flex justify-between py-2">
                    <span className="font-medium">{e.name}</span>
                    <span className="text-red-600">{e.last ? `前回 ${fmtDate(e.last)}（周期 ${e.inspection_interval_days}日）` : "点検記録なし"}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="単独作業中">
            {dms.length === 0 ? (
              <Empty>単独作業者はいません</Empty>
            ) : (
              <ul className="space-y-2">
                {dms.map((d) => {
                  const rem = d.state ? Math.round((d.state.deadlineAt - now) / 1000) : null;
                  const alarm = d.state?.phase === "alarm" || d.state?.phase === "grace";
                  return (
                    <li key={d.id} className={cx("flex items-center justify-between rounded-xl p-3", alarm ? "bg-red-50 ring-2 ring-red-400" : "bg-slate-50")}>
                      <div>
                        <div className="font-semibold">{d.user_name}</div>
                        <div className="text-xs text-slate-500">{d.interval_sec / 60}分間隔</div>
                      </div>
                      <div className={cx("text-lg font-bold tabular-nums", alarm ? "text-red-600" : "")}>
                        {rem === null ? "—" : rem <= 0 ? "応答なし" : `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="設備の使用状況（バーチャルキー）">
            {locks.length === 0 ? (
              <Empty>キー管理対象の設備はありません</Empty>
            ) : (
              <ul className="space-y-2">
                {locks.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{e.name}</span>
                    {e.lock?.lockedBy ? (
                      <span className="flex items-center gap-1">
                        {e.lock.lockedBy.userName}
                        <Badge tone={e.lock.armed ? "green" : "amber"}>{e.lock.armed ? "稼働可" : "点検中"}</Badge>
                      </span>
                    ) : (
                      <Badge>空き</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="ライブフィード">
            {feed.length === 0 ? (
              <Empty>現場のイベントがここにリアルタイム表示されます</Empty>
            ) : (
              <ul className="max-h-[480px] space-y-2 overflow-y-auto text-sm">
                {feed.map((ev, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-12 shrink-0 text-xs text-slate-400 tabular-nums">{fmtTime(ev.at)}</span>
                    <FeedItem ev={ev} />
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

function FeedItem({ ev }: { ev: LiveEvent }) {
  const d = ev.data as Record<string, string | number | boolean | null>;
  switch (ev.type) {
    case "tap":
      return (
        <span>
          <b>{d.userName}</b> が「{d.tagLabel}」にタッチ <Badge>{PURPOSE_LABEL[d.purpose as string] ?? d.purpose}</Badge>{" "}
          <Badge tone={assuranceTone(d.assurance as string)}>{ASSURANCE_LABEL[d.assurance as string]}</Badge>
        </span>
      );
    case "inspection":
      return (
        <span>
          <b>{d.userName}</b> が「{d.equipmentName}」を点検 → {d.result === "ok" ? "異常なし" : <b className="text-red-600">要対応</b>}
        </span>
      );
    case "incident":
      return (
        <span>
          <Badge tone={severityTone(d.severity as string)}>{d.source === "ble" ? "接近検知" : "ヒヤリハット"}</Badge> {d.title}
          {d.userName ? `（${d.userName}）` : ""}
        </span>
      );
    case "alert":
      return (
        <span className={d.severity === "danger" ? "font-bold text-red-600" : ""}>
          <Badge tone={severityTone(d.severity as string)}>アラート</Badge> {d.message}
        </span>
      );
    case "lock":
      return (
        <span>
          「{d.equipmentName ?? "設備"}」 {d.lockedBy ? `キー取得（${(d.lockedBy as unknown as { userName: string }).userName}）${d.armed ? "・起動許可" : ""}` : "キー返却"}
        </span>
      );
    case "deadman":
      return <span>生存確認: {d.phase === "ended" ? "終了" : d.phase === "waiting" ? "応答あり" : d.phase === "grace" ? "遅延" : "応答なし"}</span>;
  }
}

/** メール・LINEで届かなかったアラート（直近7日） */
function UndeliveredBanner() {
  const { data } = useApi<{ id: string; channel: string; to_label: string | null; to_address: string; subject: string; last_error: string | null; created_at: number }[]>("/admin/undelivered-alerts");
  const [open, setOpen] = useState(false);
  if (!data?.length) return null;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-center justify-between gap-3">
        <div className="font-bold">📵 メール・LINEで届かなかったアラートが {data.length} 件あります（直近7日）</div>
        <button className="shrink-0 underline" onClick={() => setOpen(!open)}>
          {open ? "閉じる" : "詳細"}
        </button>
      </div>
      <p className="mt-1 text-xs">自動で再送しています。運営にも通知済みです。宛先（契約・サポート →「通知」）を確認してください。</p>
      {open && (
        <ul className="mt-3 space-y-1 text-xs">
          {data.map((d) => (
            <li key={d.id}>
              {fmtDate(d.created_at)} {fmtTime(d.created_at)} ・ {d.channel === "line" ? "LINE" : "メール"} → {d.to_label ?? d.to_address} ・ {d.subject}
              <span className="text-amber-700">（{d.last_error ?? "不明"}）</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { tap: "タッチ", inspection: "点検", incident: "ヒヤリハット" };

/** 現場の端末から送信を拒否された記録（作業員の端末から自動で届く） */
function RejectedCard() {
  const { data, reload } = useApi<
    { id: string; kind: string; payload: Record<string, unknown>; photo_count: number; error: string; occurred_at: number; user_name: string; site_name: string | null }[]
  >("/admin/rejected");
  if (!data?.length) return null;
  return (
    <Card title={`送信できなかった現場の記録（${data.length}件）`}>
      <p className="mb-3 text-xs text-slate-500">オフライン中に保存され、後から送信したときにサーバーが受け付けなかった記録です。内容を確認し、必要なら作業員に再実施を依頼してください。</p>
      <div className="space-y-2">
        {data.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm">
            <div className="min-w-0">
              <div className="font-semibold">
                {KIND_LABEL[r.kind] ?? r.kind} ・ {r.user_name} ・ {fmtDate(r.occurred_at)} {fmtTime(r.occurred_at)}
                {r.site_name ? ` ・ ${r.site_name}` : ""}
              </div>
              <div className="text-red-700">{r.error}</div>
              <div className="truncate text-xs text-slate-500">
                {typeof r.payload.title === "string" ? `件名: ${r.payload.title} ` : ""}
                {typeof r.payload.result === "string" ? `判定: ${r.payload.result} ` : ""}
                {typeof r.payload.note === "string" ? `メモ: ${r.payload.note} ` : ""}
                {r.photo_count ? `写真 ${r.photo_count}枚（端末内）` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const note = prompt("対応内容（任意）", "作業員に確認済み") ?? "";
                await post(`/admin/rejected/${r.id}/resolve`, { resolution: note });
                await reload();
              }}
            >
              確認済み
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
