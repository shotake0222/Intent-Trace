import { useState } from "react";
import { useApi, useNow } from "../../lib/hooks";
import { ApiError, post } from "../../lib/api";
import { Alert, Button, Card, Field, Select, Spinner, cx } from "../../components/ui";

interface Current {
  sessionId: string;
  deadlineAt: number;
  phase: string;
  intervalSec: number;
  graceSec: number;
}

export default function Deadman() {
  const cur = useApi<Current | null>("/deadman/current");
  const sites = useApi<{ id: string; name: string }[]>("/sites");
  const [siteId, setSiteId] = useState("");
  const [interval, setIntervalMin] = useState(30);
  const [grace, setGrace] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await cur.reload();
      window.dispatchEvent(new Event("it:deadman"));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "通信エラー（オフラインでは生存確認を開始できません）");
    }
  };

  if (cur.loading && !cur.data) return <div className="py-20 text-center"><Spinner /></div>;

  if (cur.data) {
    const rem = Math.round((cur.data.deadlineAt - now) / 1000);
    const late = rem <= 0;
    return (
      <div className="space-y-4">
        <div className={cx("rounded-3xl p-8 text-center", late ? "animate-pulse bg-red-600 text-white" : rem < 120 ? "bg-amber-400" : "bg-slate-900 text-white")}>
          <div className="text-sm font-semibold opacity-80">次の生存確認まで</div>
          <div className="mt-2 text-6xl font-bold tabular-nums">{late ? "0:00" : `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, "0")}`}</div>
          <div className="mt-3 text-sm opacity-90">{late ? "期限を過ぎています。管理者に通知されます" : "近くの NFC タグにタッチすると自動で延長されます"}</div>
        </div>
        <Button variant="accent" size="lg" className="w-full" onClick={() => act(() => post("/deadman/checkin"))}>
          無事です（画面で応答）
        </Button>
        <Button variant="outline" className="w-full" onClick={() => act(() => post("/deadman/end"))}>
          単独作業を終了
        </Button>
        {err && <Alert>{err}</Alert>}
        <p className="text-xs text-slate-500">
          間隔 {cur.data.intervalSec / 60} 分・猶予 {cur.data.graceSec / 60} 分。猶予を過ぎても応答がない場合、管理者ダッシュボードに緊急アラートが出ます。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">単独作業の生存確認</h1>
      <Card>
        <div className="space-y-4">
          <Field label="現場">
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">選択してください</option>
              {sites.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="確認間隔">
            <Select value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
              {[5, 10, 15, 30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m} 分ごと
                </option>
              ))}
            </Select>
          </Field>
          <Field label="猶予時間">
            <Select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
              {[1, 3, 5, 10, 15].map((m) => (
                <option key={m} value={m}>
                  {m} 分
                </option>
              ))}
            </Select>
          </Field>
          {err && <Alert>{err}</Alert>}
          <Button size="lg" className="w-full" disabled={!siteId} onClick={() => act(() => post("/deadman/start", { siteId, intervalMin: interval, graceMin: grace }))}>
            開始
          </Button>
        </div>
      </Card>
    </div>
  );
}
