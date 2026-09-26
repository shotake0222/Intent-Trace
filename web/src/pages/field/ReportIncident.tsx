import { useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, isNetworkError, post, uploadFile, uuid } from "../../lib/api";
import { enqueue } from "../../lib/offline";
import { useApi } from "../../lib/hooks";
import { Alert, Button, Card, Field, Input, Select, Textarea, cx } from "../../components/ui";
import { PhotoPicker, type Photo } from "../../components/PhotoPicker";

const PRESETS = ["重機・フォークリフトとの接近", "転倒・つまずき", "落下物", "挟まれそう", "感電しそう", "その他"];

export default function ReportIncident() {
  const sites = useApi<{ id: string; name: string }[]>("/sites");
  const nav = useNavigate();
  const [siteId, setSiteId] = useState("");
  const [severity, setSeverity] = useState<"info" | "warning" | "danger">("warning");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const effectiveSite = siteId || (sites.data?.length === 1 ? sites.data[0].id : "");

  async function submit() {
    setBusy(true);
    setErr(null);
    const clientEventId = uuid();
    const payload = { clientEventId, siteId: effectiveSite, severity, title, note: note || undefined, occurredAt: Date.now(), photoKeys: [] as string[] };
    try {
      if (!navigator.onLine) throw new TypeError("offline");
      for (const p of photos) payload.photoKeys.push((await uploadFile(p.blob, p.name, { kind: "photo" })).id);
      await post("/incidents", payload);
      setDone("報告を送信しました。ご協力ありがとうございます");
    } catch (e) {
      if (isNetworkError(e)) {
        await enqueue({ id: clientEventId, kind: "incident", payload, photos: photos.map((p) => ({ blob: p.blob, name: p.name })) });
        setDone("端末に保存しました。電波が戻ると送信されます");
      } else setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="space-y-4">
        <Alert tone="green">{done}</Alert>
        <Button className="w-full" onClick={() => nav("/")}>ホームへ</Button>
      </div>
    );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">ヒヤリハット報告</h1>
      <Card>
        <div className="space-y-4">
          {(sites.data?.length ?? 0) > 1 && (
            <Field label="現場">
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">選択してください</option>
                {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          )}
          <div>
            <div className="mb-1 text-sm font-semibold text-slate-700">どんなこと？</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p} onClick={() => setTitle(p)} className={cx("rounded-full px-3 py-1.5 text-sm", title === p ? "bg-slate-900 text-white" : "bg-slate-100")}>{p}</button>
              ))}
            </div>
            <Input className="mt-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="または自由入力" />
          </div>
          <div>
            <div className="mb-1 text-sm font-semibold text-slate-700">危険度</div>
            <div className="grid grid-cols-3 gap-2">
              {([["info", "軽微", "bg-slate-700"], ["warning", "注意", "bg-amber-500"], ["danger", "危険", "bg-red-600"]] as const).map(([v, l, c]) => (
                <button key={v} onClick={() => setSeverity(v)} className={cx("rounded-xl py-3 text-sm font-bold", severity === v ? `${c} text-white` : "bg-slate-100")}>{l}</button>
              ))}
            </div>
          </div>
          <Field label="詳細（任意）">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <PhotoPicker photos={photos} onChange={setPhotos} />
          {err && <Alert>{err}</Alert>}
          <Button variant="accent" size="lg" className="w-full" disabled={busy || !title || !effectiveSite} onClick={submit}>
            {busy ? "送信中…" : "報告する"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
