import { useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { EquipmentCard } from "../../../../shared/types";
import { ApiError, isNetworkError, post, uploadFile, uuid } from "../../lib/api";
import { enqueue } from "../../lib/offline";
import { useApi } from "../../lib/hooks";
import { Alert, Button, Card, Field, Spinner, Textarea, cx } from "../../components/ui";
import { PhotoPicker, type Photo } from "../../components/PhotoPicker";

export default function Inspect() {
  const { equipmentId = "" } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { data: eq, error } = useApi<EquipmentCard>(`/equipment/${equipmentId}`);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<"ok" | "ng" | "needs_followup">("ok");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"sent" | "queued" | null>(null);

  if (error && !eq) return <Alert tone="amber">設備情報を取得できません。{error.message}</Alert>;
  if (!eq)
    return (
      <div className="py-20 text-center">
        <Spinner />
      </div>
    );

  const checklist = eq.checklist;
  const allChecked = checklist.every((c) => checks[c] !== undefined);
  const anyNg = checklist.some((c) => checks[c] === false);

  async function submit() {
    setBusy(true);
    setErr(null);
    const clientEventId = uuid();
    const payload = {
      equipmentId,
      clientEventId,
      tapEventId: sp.get("tap") ?? undefined,
      tapClientEventId: sp.get("tapc") ?? undefined,
      result: anyNg && result === "ok" ? "needs_followup" : result,
      checklist: checklist.map((item) => ({ item, ok: checks[item] !== false })),
      note: note || undefined,
      startedAt: sp.get("at") ? Number(sp.get("at")) : undefined,
      completedAt: Date.now(),
      photoKeys: [] as string[]
    };
    try {
      if (!navigator.onLine) throw new TypeError("offline");
      for (const p of photos) payload.photoKeys.push((await uploadFile(p.blob, p.name, { kind: "photo", equipmentId })).id);
      await post("/inspections", payload);
      setDone("sent");
    } catch (e) {
      if (isNetworkError(e)) {
        await enqueue({ id: clientEventId, kind: "inspection", payload, photos: photos.map((p) => ({ blob: p.blob, name: p.name })) });
        setDone("queued");
      } else {
        setErr(e instanceof ApiError ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="space-y-4">
        <div className={cx("rounded-2xl p-6 text-center", done === "sent" ? "bg-emerald-600 text-white" : "bg-amber-400 text-slate-900")}>
          <div className="text-4xl">✓</div>
          <div className="mt-2 text-xl font-bold">{done === "sent" ? "点検記録を送信しました" : "端末に保存しました"}</div>
          {done === "queued" && <div className="mt-1 text-sm">電波が戻ると自動で送信されます</div>}
        </div>
        <Button size="lg" className="w-full" onClick={() => nav("/")}>
          ホームへ
        </Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-semibold text-slate-500">点検記録</div>
        <h1 className="text-xl font-bold">{eq.name}</h1>
      </div>
      {!sp.get("tap") && !sp.get("tapc") && <Alert tone="amber">設備のNFCタグにタッチしてから30分以内の記録のみ受け付けられます</Alert>}

      {checklist.length > 0 && (
        <Card title="点検項目">
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item} className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
                <span className="text-sm font-medium">{item}</span>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => setChecks({ ...checks, [item]: true })} className={cx("rounded-lg px-3 py-2 text-sm font-bold", checks[item] === true ? "bg-emerald-600 text-white" : "bg-white ring-1 ring-slate-300")}>
                    良
                  </button>
                  <button onClick={() => setChecks({ ...checks, [item]: false })} className={cx("rounded-lg px-3 py-2 text-sm font-bold", checks[item] === false ? "bg-red-600 text-white" : "bg-white ring-1 ring-slate-300")}>
                    否
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="総合判定">
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["ok", "異常なし", "bg-emerald-600"],
              ["needs_followup", "要フォロー", "bg-amber-500"],
              ["ng", "異常あり", "bg-red-600"]
            ] as const
          ).map(([v, label, color]) => (
            <button key={v} onClick={() => setResult(v)} className={cx("rounded-xl py-3 text-sm font-bold", result === v ? `${color} text-white` : "bg-slate-100 text-slate-700")}>
              {label}
            </button>
          ))}
        </div>
        {anyNg && result === "ok" && <p className="mt-2 text-xs text-amber-700">「否」の項目があるため「要フォロー」として記録されます</p>}
        <div className="mt-4">
          <Field label="所見・メモ">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="気づいたことを入力" />
          </Field>
        </div>
        <div className="mt-4">
          <PhotoPicker photos={photos} onChange={setPhotos} />
        </div>
      </Card>

      {err && <Alert>{err}</Alert>}
      <Button variant="accent" size="lg" className="w-full" onClick={submit} disabled={busy || (checklist.length > 0 && !allChecked)}>
        {busy ? "送信中…" : checklist.length > 0 && !allChecked ? "全項目を入力してください" : "記録する"}
      </Button>
    </div>
  );
}
