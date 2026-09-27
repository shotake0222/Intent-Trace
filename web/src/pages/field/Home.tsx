import { Link } from "react-router";
import { useApi, useQueue } from "../../lib/hooks";
import { removeItem, retryItem, syncQueue } from "../../lib/offline";
import { webNfcSupported } from "../../lib/nfc";
import { Alert, Badge, Button, Card } from "../../components/ui";
import { fmtTime } from "../../lib/format";

interface PatrolCurrent {
  runId: string;
  routeName: string;
  nextSeq: number;
  total: number;
  points: { seq: number; label: string; visited_at: number | null }[];
}
interface ProcCurrent {
  runId: string;
  procedureName: string;
  nextSeq: number;
  total: number;
  steps: { seq: number; instruction: string; label: string }[];
}

export default function Home() {
  const patrol = useApi<PatrolCurrent | null>("/patrol/current");
  const proc = useApi<ProcCurrent | null>("/procedures/current");
  const queue = useQueue();
  const failed = queue.filter((q) => q.failed);
  const ann = useApi<{ id: string; title: string; body: string; level: string }[]>("/account/announcements");

  const visited = patrol.data?.points.filter((p) => p.visited_at).length ?? 0;
  const nextStep = proc.data?.steps.find((s) => s.seq === proc.data?.nextSeq);

  return (
    <div className="space-y-4">
      {ann.data
        ?.filter((a) => a.level !== "info")
        .slice(0, 2)
        .map((a) => (
          <Alert key={a.id} tone={a.level === "important" ? "red" : "amber"}>
            <b>{a.title}</b>
            <div className="whitespace-pre-wrap">{a.body}</div>
          </Alert>
        ))}
      <div className="relative overflow-hidden rounded-3xl bg-slate-900 p-6 text-white">
        <div className="relative z-10">
          <div className="text-sm text-amber-400">NFC タッチで記録</div>
          <div className="mt-1 text-xl font-bold">設備や部屋のタグに スマホをかざしてください</div>
          <p className="mt-2 text-sm text-slate-300">
            {webNfcSupported ? "「スキャン」を押すとアプリ内で連続読み取りできます。" : "iPhone は画面を点けた状態でタグに上部を近づけると通知が出ます。タップして開いてください。"}
          </p>
          {webNfcSupported && (
            <Link to="/scan">
              <Button variant="accent" size="lg" className="mt-4 w-full">
                スキャン開始
              </Button>
            </Link>
          )}
        </div>
        <div className="pulse-ring absolute -right-10 -bottom-10 h-40 w-40 rounded-full border-4 border-amber-400/60" />
      </div>

      {failed.length > 0 && (
        <Card title="送信できなかった記録">
          <div className="space-y-2">
            {failed.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-2 rounded-xl bg-red-50 p-3 text-sm">
                <div>
                  <div className="font-semibold">
                    {f.kind === "tap" ? "タッチ" : f.kind === "inspection" ? "点検" : "ヒヤリハット"} {fmtTime(f.createdAt)}
                  </div>
                  <div className="text-red-700">{f.error}</div>
                  {f.reportedAt ? <div className="text-xs text-slate-500">管理者に通知済み</div> : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button size="sm" variant="outline" onClick={() => void retryItem(f.id)}>
                    再送
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(f.reportedAt ? "この端末から削除します（管理者には控えが届いています）" : "管理者にまだ届いていません。削除してよいですか？")) void removeItem(f.id);
                    }}
                  >
                    削除
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            内容は自動で管理者にも届いています{failed.some((f) => !f.reportedAt) ? "（一部は電波が戻り次第）" : ""}。資格の更新などで解決した場合は「再送」、不要なら「削除」してください。
          </p>
        </Card>
      )}

      {proc.data && (
        <Card title={<span>作業手順: {proc.data.procedureName}</span>} action={<Badge tone="amber">{proc.data.nextSeq}/{proc.data.total}</Badge>}>
          <div className="rounded-xl bg-amber-50 p-3">
            <div className="text-xs font-semibold text-amber-800">次の手順</div>
            <div className="font-bold">{nextStep?.instruction}</div>
            <div className="mt-1 text-sm text-slate-600">「{nextStep?.label}」のタグにタッチ</div>
          </div>
        </Card>
      )}

      {patrol.data ? (
        <Card title={<span>巡回中: {patrol.data.routeName}</span>} action={<Badge tone="blue">{visited}/{patrol.data.total}</Badge>}>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${(visited / Math.max(1, patrol.data.total)) * 100}%` }} />
          </div>
          <Link to="/patrol">
            <Button variant="outline" className="w-full">
              巡回の詳細
            </Button>
          </Link>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Link to="/patrol" className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="text-2xl">⇢</div>
          <div className="mt-2 font-bold">巡回</div>
          <div className="text-xs text-slate-500">ルートを選んで開始</div>
        </Link>
        <Link to="/deadman" className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="text-2xl">♥</div>
          <div className="mt-2 font-bold">単独作業</div>
          <div className="text-xs text-slate-500">定期的な生存確認</div>
        </Link>
        <Link to="/report" className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="text-2xl text-amber-500">!</div>
          <div className="mt-2 font-bold">ヒヤリハット報告</div>
          <div className="text-xs text-slate-500">写真付きで30秒</div>
        </Link>
        <Link to="/history" className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <div className="text-2xl">≡</div>
          <div className="mt-2 font-bold">自分の記録</div>
          <div className="text-xs text-slate-500">今日のタッチ履歴</div>
        </Link>
      </div>

      {queue.length > 0 && failed.length === 0 && (
        <Alert tone="amber">
          <div className="flex items-center justify-between gap-2">
            <span>電波が戻ると {queue.length} 件の記録を自動送信します</span>
            <Button size="sm" variant="outline" onClick={() => void syncQueue()}>
              今すぐ送信
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}
