import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type { EquipmentCard, TagResolution, TapResponse, LockState } from "../../../../shared/types";
import { ApiError, del, get, post } from "../../lib/api";
import { recordTap } from "../../lib/nfc";
import { useAuth } from "../../lib/auth";
import { TagRegisterForm } from "../../components/TagRegisterForm";
import { Alert, Badge, Button, Card, Spinner, assuranceTone, resultTone } from "../../components/ui";
import { ASSURANCE_LABEL, RESULT_LABEL, TAG_KIND_LABEL, fmtAgo, fmtDate, fmtDateTime } from "../../lib/format";

// StrictMode の二重実行や再描画で同じタッチを二重記録しない
const recorded = new Map<string, Promise<TapState>>();

type TapState =
  | { status: "ok"; res: TapResponse; clientEventId: string; at: number }
  | { status: "queued"; clientEventId: string; at: number }
  | { status: "error"; message: string; code: string | null };

export default function TagLanding() {
  const { tagId = "" } = useParams();
  const [sp] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [tap, setTap] = useState<TapState | null>(null);
  const [info, setInfo] = useState<TagResolution | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const { me } = useAuth();
  // 未登録タグをその場で登録するときに使うタッチ情報（URL から除去する前に保持）
  const touchRef = useRef<{ sun?: { picc: string; cmac: string }; serial?: string }>({});

  const load = async () => {
    try {
      setInfo(await get<TagResolution>(`/tags/${tagId}`));
      setInfoError(null);
    } catch (e) {
      setInfoError(e instanceof ApiError ? e.message : "タグ情報を取得できません（オフライン）");
    }
  };

  useEffect(() => {
    const key = loc.key + tagId;
    const picc = sp.get("picc");
    const cmac = sp.get("cmac");
    const serial = (loc.state as { serial?: string } | null)?.serial;
    touchRef.current = { sun: picc && cmac ? { picc, cmac } : undefined, serial };
    let p = recorded.get(key);
    if (!p) {
      p = (async (): Promise<TapState> => {
        const at = Date.now();
        try {
          const r = await recordTap({
            tagId,
            source: serial ? "pwa_webnfc" : sp.get("src") === "qr" ? "pwa_qr" : "pwa_url",
            sun: picc && cmac ? { picc, cmac } : undefined,
            serial
          });
          if (r.queued) return { status: "queued", clientEventId: r.clientEventId, at };
          return { status: "ok", res: r.res, clientEventId: r.clientEventId, at };
        } catch (e) {
          return { status: "error", message: e instanceof ApiError ? e.message : String(e), code: e instanceof ApiError ? e.code : null };
        }
      })();
      recorded.set(key, p);
    }
    let alive = true;
    void p.then((s) => {
      if (!alive) return;
      setTap(s);
      if (s.status === "ok" && s.res.deadman) window.dispatchEvent(new Event("it:deadman"));
      void load();
    });
    // 使い終えた SUN パラメータは URL から除去（再読込でのリプレイ扱いを避ける）
    if (picc || sp.get("src")) window.history.replaceState(window.history.state, "", `/t/${tagId}`);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, loc.key]);

  if (!tap)
    return (
      <div className="grid place-items-center py-24 text-slate-500">
        <Spinner className="h-8 w-8" />
        <div className="mt-3 text-sm">タッチを記録しています…</div>
      </div>
    );

  if (tap.status === "error" && tap.code === "tag_unregistered") {
    const canRegister = me && me.role !== "worker";
    return (
      <div className="space-y-4">
        <div className="rounded-2xl bg-sky-600 p-5 text-white">
          <div className="text-lg font-bold">新しいタグです</div>
          <div className="mt-1 text-sm">このタグはまだ設置場所が登録されていません。</div>
        </div>
        {canRegister ? (
          <Card title="この場所にタグを登録">
            <TagRegisterForm stockId={tagId} touch={touchRef.current} onDone={() => nav(`/t/${tagId}`, { replace: true, state: { registered: Date.now() } })} />
          </Card>
        ) : (
          <Alert tone="amber">管理者またはマネージャーのアカウントでタッチすると、その場で登録できます。管理者に連絡してください。</Alert>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <TapBanner tap={tap} />
      {tap.status === "ok" && tap.res.procedure && (
        <Alert tone={tap.res.procedure.ok ? "green" : "red"}>
          <div className="font-bold">{tap.res.procedure.ok ? "✓ " : "✕ "}{tap.res.procedure.message}</div>
        </Alert>
      )}
      {tap.status === "ok" && tap.res.patrol && (
        <Alert tone={tap.res.patrol.status === "completed" ? "green" : "blue"}>
          <div className="font-bold">{tap.res.patrol.message}</div>
        </Alert>
      )}
      {tap.status === "ok" && tap.res.warnings.map((w) => <Alert key={w} tone="amber">{w}</Alert>)}

      {info ? (
        <>
          <Card>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-500">
                  {info.tag.siteName}
                  {info.tag.zoneName ? ` / ${info.tag.zoneName}` : ""}
                </div>
                <h1 className="text-xl font-bold">{info.tag.label}</h1>
              </div>
              <Badge>{TAG_KIND_LABEL[info.tag.kind]}</Badge>
            </div>
          </Card>
          {info.activeProcedure && (
            <Card title={`作業手順: ${info.activeProcedure.procedureName}`} action={<Badge tone="amber">{info.activeProcedure.nextSeq}/{info.activeProcedure.total}</Badge>}>
              <div className="text-sm text-slate-500">次の手順</div>
              <div className="text-lg font-bold">{info.activeProcedure.instruction}</div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={async () => {
                  await post(`/procedures/runs/${info.activeProcedure!.runId}/abort`);
                  void load();
                }}
              >
                手順を中止
              </Button>
            </Card>
          )}
          {info.equipment && (
            <EquipmentPanel eq={info.equipment} tap={tap} onChange={load} onInspect={() => nav(inspectUrl(info.equipment!.id, tap))} />
          )}
          {info.activePatrol && (
            <Link to="/patrol">
              <Button variant="outline" className="w-full">
                巡回「{info.activePatrol.routeName}」の進捗を見る
              </Button>
            </Link>
          )}
        </>
      ) : infoError ? (
        <Alert tone="amber">{infoError}</Alert>
      ) : (
        <div className="py-6 text-center">
          <Spinner />
        </div>
      )}
      <Link to="/">
        <Button variant="ghost" className="w-full">
          ホームへ戻る
        </Button>
      </Link>
    </div>
  );
}

function inspectUrl(equipmentId: string, tap: TapState) {
  const q = new URLSearchParams();
  if (tap.status === "ok") q.set("tap", tap.res.tapEventId);
  if (tap.status === "ok" || tap.status === "queued") {
    q.set("tapc", tap.clientEventId);
    q.set("at", String(tap.at));
  }
  return `/inspect/${equipmentId}?${q}`;
}

function TapBanner({ tap }: { tap: TapState }) {
  if (tap.status === "error") {
    const retry = tap.code === "sun_replay" || tap.code === "sun_required";
    return (
      <div className="rounded-2xl bg-red-600 p-5 text-white">
        <div className="text-lg font-bold">記録できませんでした</div>
        <div className="mt-1 text-sm">{tap.message}</div>
        {retry && <div className="mt-2 text-sm font-semibold">→ もう一度、タグに直接スマホをかざしてください</div>}
      </div>
    );
  }
  if (tap.status === "queued") {
    return (
      <div className="rounded-2xl bg-amber-400 p-5 text-slate-900">
        <div className="text-lg font-bold">端末に保存しました（オフライン）</div>
        <div className="mt-1 text-sm">電波が戻ると自動で送信されます。タッチ時刻 {fmtDateTime(tap.at)}</div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-emerald-600 p-5 text-white">
      <div className="flex items-center justify-between">
        <div className="text-lg font-bold">✓ タッチを記録しました</div>
        <Badge tone={assuranceTone(tap.res.assurance)}>{ASSURANCE_LABEL[tap.res.assurance]}</Badge>
      </div>
      <div className="mt-1 text-sm text-emerald-50">{fmtDateTime(tap.at)}{tap.res.duplicate ? "（記録済み）" : ""}</div>
    </div>
  );
}

function EquipmentPanel({ eq, tap, onChange, onInspect }: { eq: EquipmentCard; tap: TapState; onChange: () => void; onInspect: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber"; text: string } | null>(null);
  const [lock, setLock] = useState<LockState & { requiresProcedure?: boolean }>(eq.lock);
  const me = useRef<string | null>(null);
  useEffect(() => setLock(eq.lock), [eq.lock]);
  useEffect(() => {
    try {
      me.current = JSON.parse(localStorage.getItem("it:me") ?? "null")?.id ?? null;
    } catch {
      /* noop */
    }
  }, []);
  const mine = lock.lockedBy?.userId === me.current;
  const overdue = eq.nextDueAt && eq.nextDueAt < Date.now();

  async function acquire() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<LockState & { requiresProcedure: boolean }>(`/equipment/${eq.id}/lock`);
      setLock(r);
      setMsg(r.armed ? { tone: "green", text: "バーチャルキーを取得しました。起動できます" } : { tone: "amber", text: "キーを取得しました。起動前点検の手順を完了してください" });
      onChange();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : "通信エラー" });
    } finally {
      setBusy(false);
    }
  }
  async function release() {
    setBusy(true);
    try {
      setLock(await del<LockState>(`/equipment/${eq.id}/lock`));
      setMsg({ tone: "green", text: "キーを返却しました" });
      onChange();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : "通信エラー" });
    } finally {
      setBusy(false);
    }
  }
  async function startProcedure(id: string) {
    setBusy(true);
    try {
      await post(`/procedures/${id}/runs`);
      setMsg({ tone: "amber", text: "手順を開始しました。表示される順にタグへタッチしてください" });
      onChange();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : "通信エラー" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="設備カルテ">
        <dl className="grid grid-cols-3 gap-y-2 text-sm">
          <dt className="text-slate-500">設備名</dt>
          <dd className="col-span-2 font-semibold">{eq.name}</dd>
          {eq.model && (
            <>
              <dt className="text-slate-500">型式</dt>
              <dd className="col-span-2">{eq.model}</dd>
            </>
          )}
          {eq.locationNote && (
            <>
              <dt className="text-slate-500">設置場所</dt>
              <dd className="col-span-2">{eq.locationNote}</dd>
            </>
          )}
          <dt className="text-slate-500">前回点検</dt>
          <dd className="col-span-2">
            {eq.lastInspection ? (
              <>
                {fmtDate(eq.lastInspection.at)} {eq.lastInspection.userName} <Badge tone={resultTone(eq.lastInspection.result)}>{RESULT_LABEL[eq.lastInspection.result]}</Badge>
              </>
            ) : (
              "記録なし"
            )}
          </dd>
          {eq.nextDueAt && (
            <>
              <dt className="text-slate-500">次回期限</dt>
              <dd className={`col-span-2 ${overdue ? "font-bold text-red-600" : ""}`}>
                {fmtDate(eq.nextDueAt)}
                {overdue ? "（期限切れ）" : ""}
              </dd>
            </>
          )}
          {eq.requiredQualification && (
            <>
              <dt className="text-slate-500">必要資格</dt>
              <dd className="col-span-2">{eq.requiredQualification.name}</dd>
            </>
          )}
        </dl>
        <Button variant="accent" size="lg" className="mt-4 w-full" onClick={onInspect} disabled={tap.status === "error"}>
          点検を記録する
        </Button>
      </Card>

      {eq.lockable && (
        <Card title="バーチャルキー（操作権限）" action={lock.lockedBy ? <Badge tone={lock.armed ? "green" : "amber"}>{lock.armed ? "起動許可" : "手順待ち"}</Badge> : <Badge>未使用</Badge>}>
          {lock.lockedBy ? (
            <p className="text-sm">
              <b>{lock.lockedBy.userName}</b> さんが操作中（{fmtAgo(lock.since)}から）
            </p>
          ) : (
            <p className="text-sm text-slate-600">資格を確認し、この設備の操作権限を取得します。</p>
          )}
          <div className="mt-3 flex gap-2">
            {!lock.lockedBy && (
              <Button className="flex-1" onClick={acquire} disabled={busy || tap.status !== "ok"}>
                キーを取得
              </Button>
            )}
            {mine && (
              <Button variant="outline" className="flex-1" onClick={release} disabled={busy}>
                キーを返却
              </Button>
            )}
          </div>
          {mine && !lock.armed && eq.procedures.filter((p) => p.unlocksEquipment).length > 0 && (
            <div className="mt-3 space-y-2">
              {eq.procedures
                .filter((p) => p.unlocksEquipment)
                .map((p) => (
                  <Button key={p.id} variant="accent" className="w-full" onClick={() => void startProcedure(p.id)} disabled={busy}>
                    {p.name}（{p.steps}手順）を開始
                  </Button>
                ))}
            </div>
          )}
          {tap.status === "queued" && <p className="mt-2 text-xs text-slate-500">※ キーの取得にはオンライン接続が必要です</p>}
        </Card>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {eq.procedures.filter((p) => !p.unlocksEquipment).length > 0 && (
        <Card title="作業手順">
          <div className="space-y-2">
            {eq.procedures
              .filter((p) => !p.unlocksEquipment)
              .map((p) => (
                <Button key={p.id} variant="outline" className="w-full justify-between" onClick={() => void startProcedure(p.id)} disabled={busy}>
                  <span>{p.name}</span>
                  <span className="text-sm text-slate-500">{p.steps}手順</span>
                </Button>
              ))}
          </div>
        </Card>
      )}

      {eq.documents.length > 0 && (
        <Card title="マニュアル・資料">
          <ul className="divide-y divide-slate-100">
            {eq.documents.map((d) => (
              <li key={d.id}>
                <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="flex items-center justify-between py-3 text-sm font-semibold text-sky-700">
                  <span>📄 {d.filename}</span>
                  <span className="text-slate-400">開く ›</span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {eq.recentInspections.length > 0 && (
        <Card title="点検履歴">
          <ul className="space-y-2 text-sm">
            {eq.recentInspections.map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-2">
                <div>
                  <div>
                    {fmtDateTime(i.at)} {i.userName}
                  </div>
                  {i.note && <div className="text-xs text-slate-500">{i.note}</div>}
                </div>
                <Badge tone={resultTone(i.result)}>{RESULT_LABEL[i.result]}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
