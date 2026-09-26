import { useState } from "react";
import type { LockState } from "../../../../shared/types";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { ApiError, del, patch, post, uploadFile } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Textarea, resultTone } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { RESULT_LABEL, fmtDate } from "../../lib/format";

interface Row {
  id: string;
  name: string;
  category: string | null;
  model: string | null;
  serial_no: string | null;
  location_note: string | null;
  zone_id: string | null;
  zone_name: string | null;
  required_qualification_id: string | null;
  qualification_name: string | null;
  lockable: number;
  inspection_interval_days: number | null;
  checklist: string[];
  last_inspected_at: number | null;
  last_result: string | null;
  manuals: number;
  lock: LockState | null;
}

export default function EquipmentAdmin() {
  const { siteId, zones } = useAdmin();
  const list = useApi<Row[]>(`/admin/equipment?siteId=${siteId}`, [siteId]);
  const quals = useApi<{ id: string; name: string }[]>("/admin/qualifications");
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [docsFor, setDocsFor] = useState<Row | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">設備カルテ</h1>
        <Button onClick={() => setEditing("new")}>＋ 設備を登録</Button>
      </div>
      <Card>
        {!list.data?.length ? (
          <Empty>設備が登録されていません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">設備</th>
                  <th>場所</th>
                  <th>必要資格</th>
                  <th>前回点検</th>
                  <th>周期</th>
                  <th>キー</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((e) => {
                  const overdue = e.inspection_interval_days && (!e.last_inspected_at || e.last_inspected_at + e.inspection_interval_days * 86400_000 < Date.now());
                  return (
                    <tr key={e.id}>
                      <td className="py-2.5">
                        <div className="font-semibold">{e.name}</div>
                        <div className="text-xs text-slate-500">{[e.category, e.model].filter(Boolean).join(" / ")}</div>
                      </td>
                      <td className="text-xs">{[e.zone_name, e.location_note].filter(Boolean).join(" ・ ") || "—"}</td>
                      <td className="text-xs">{e.qualification_name ?? "—"}</td>
                      <td>
                        {e.last_inspected_at ? (
                          <span className="flex items-center gap-1">
                            {fmtDate(e.last_inspected_at)} <Badge tone={resultTone(e.last_result!)}>{RESULT_LABEL[e.last_result!]}</Badge>
                          </span>
                        ) : (
                          "—"
                        )}
                        {overdue ? <div className="text-xs font-bold text-red-600">期限切れ</div> : null}
                      </td>
                      <td className="text-xs">{e.inspection_interval_days ? `${e.inspection_interval_days}日` : "—"}</td>
                      <td>{e.lockable ? e.lock?.lockedBy ? <Badge tone="amber">{e.lock.lockedBy.userName}</Badge> : <Badge>空き</Badge> : "—"}</td>
                      <td className="text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => setDocsFor(e)}>
                          資料({e.manuals})
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(e)}>
                          編集
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <EquipmentForm
          row={editing === "new" ? null : editing}
          siteId={siteId}
          zones={zones.filter((z) => z.site_id === siteId)}
          quals={quals.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
      {docsFor && <DocsModal row={docsFor} onClose={() => (setDocsFor(null), void list.reload())} />}
    </div>
  );
}

function EquipmentForm({ row, siteId, zones, quals, onClose, onSaved }: { row: Row | null; siteId: string; zones: { id: string; name: string }[]; quals: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? "",
    category: row?.category ?? "",
    model: row?.model ?? "",
    serialNo: row?.serial_no ?? "",
    locationNote: row?.location_note ?? "",
    zoneId: row?.zone_id ?? "",
    requiredQualificationId: row?.required_qualification_id ?? "",
    lockable: !!row?.lockable,
    inspectionIntervalDays: row?.inspection_interval_days?.toString() ?? "",
    checklist: (row?.checklist ?? []).join("\n")
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setErr(null);
    const payload = {
      siteId,
      name: f.name,
      category: f.category || null,
      model: f.model || null,
      serialNo: f.serialNo || null,
      locationNote: f.locationNote || null,
      zoneId: f.zoneId || null,
      requiredQualificationId: f.requiredQualificationId || null,
      lockable: f.lockable,
      inspectionIntervalDays: f.inspectionIntervalDays ? Number(f.inspectionIntervalDays) : null,
      checklist: f.checklist.split("\n").map((s) => s.trim()).filter(Boolean)
    };
    try {
      if (row) await patch(`/admin/equipment/${row.id}`, payload);
      else await post("/admin/equipment", payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }

  return (
    <Modal open onClose={onClose} title={row ? "設備を編集" : "設備を登録"} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="設備名 *">
          <Input value={f.name} onChange={set("name")} />
        </Field>
        <Field label="種別">
          <Input value={f.category} onChange={set("category")} placeholder="配電盤 / 消火器 / フォークリフト" />
        </Field>
        <Field label="型式">
          <Input value={f.model} onChange={set("model")} />
        </Field>
        <Field label="製造番号">
          <Input value={f.serialNo} onChange={set("serialNo")} />
        </Field>
        <Field label="ゾーン">
          <Select value={f.zoneId} onChange={set("zoneId")}>
            <option value="">—</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="設置場所メモ">
          <Input value={f.locationNote} onChange={set("locationNote")} />
        </Field>
        <Field label="操作に必要な資格">
          <Select value={f.requiredQualificationId} onChange={set("requiredQualificationId")}>
            <option value="">不要</option>
            {quals.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="点検周期（日）">
          <Input type="number" min={1} value={f.inspectionIntervalDays} onChange={set("inspectionIntervalDays")} />
        </Field>
        <label className="flex items-center gap-2 text-sm font-semibold sm:col-span-2">
          <input type="checkbox" checked={f.lockable} onChange={(e) => setF({ ...f, lockable: e.target.checked })} className="h-5 w-5" />
          バーチャルキーで操作権限を管理する（重機・危険機械）
        </label>
        <div className="sm:col-span-2">
          <Field label="点検項目（1行に1項目）">
            <Textarea rows={5} value={f.checklist} onChange={set("checklist")} placeholder={"外観に損傷がない\n異音・異臭がない"} />
          </Field>
        </div>
      </div>
      {err && (
        <div className="mt-3">
          <Alert>{err}</Alert>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          キャンセル
        </Button>
        <Button onClick={save} disabled={!f.name}>
          保存
        </Button>
      </div>
    </Modal>
  );
}

function DocsModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const docs = useApi<{ id: string; kind: string; filename: string; size: number; created_at: number }[]>(`/admin/equipment/${row.id}/documents`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`資料: ${row.name}`}>
      <div className="space-y-3">
        {docs.data?.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {docs.data.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 py-2">
                <a href={`/api/files/${d.id}`} target="_blank" rel="noreferrer" className="font-medium text-sky-700">
                  {d.kind === "photo" ? "📷" : "📄"} {d.filename}
                </a>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  {(d.size / 1024).toFixed(0)}KB
                  <button
                    className="text-red-600"
                    onClick={async () => {
                      if (!confirm("削除しますか？")) return;
                      await del(`/files/${d.id}`);
                      void docs.reload();
                    }}
                  >
                    削除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>資料はまだありません</Empty>
        )}
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">マニュアル（PDF・画像）を追加</span>
          <input
            type="file"
            accept="application/pdf,image/*"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              setErr(null);
              try {
                await uploadFile(file, file.name, { kind: "manual", equipmentId: row.id });
                await docs.reload();
              } catch (x) {
                setErr(x instanceof ApiError ? x.message : String(x));
              } finally {
                setBusy(false);
              }
            }}
            className="block w-full text-sm"
          />
        </label>
        {busy && <div className="text-sm text-slate-500">アップロード中…</div>}
        {err && <Alert>{err}</Alert>}
      </div>
    </Modal>
  );
}
