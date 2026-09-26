import { useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { ApiError, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { fmtDateTime } from "../../lib/format";

interface TagOpt {
  id: string;
  site_id: string;
  label: string;
  kind: string;
}
interface RouteRow {
  id: string;
  site_id: string;
  name: string;
  enforce_order: number;
  time_limit_min: number | null;
  points: { seq: number; label: string }[];
}
interface ProcRow {
  id: string;
  name: string;
  equipment_name: string | null;
  unlocks_equipment: number;
  steps: { seq: number; instruction: string; label: string }[];
}
interface RunRow {
  id: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  route_name: string;
  user_name: string;
  visited: number;
  total: number;
}

export default function WorkflowsAdmin() {
  const { siteId } = useAdmin();
  const tags = useApi<TagOpt[]>("/admin/tags");
  const routes = useApi<RouteRow[]>("/admin/routes");
  const procs = useApi<ProcRow[]>("/admin/procedures");
  const runs = useApi<RunRow[]>("/admin/patrol-runs");
  const equipment = useApi<{ id: string; name: string; lockable: number }[]>(`/admin/equipment?siteId=${siteId}`, [siteId]);
  const [newRoute, setNewRoute] = useState(false);
  const [newProc, setNewProc] = useState(false);
  const siteTags = (tags.data ?? []).filter((t) => t.site_id === siteId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">巡回・作業手順</h1>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="巡回ルート" action={<Button size="sm" onClick={() => setNewRoute(true)}>＋ ルート作成</Button>}>
          {!routes.data?.filter((r) => r.site_id === siteId).length ? (
            <Empty>巡回ルートがありません</Empty>
          ) : (
            <ul className="space-y-3">
              {routes.data
                .filter((r) => r.site_id === siteId)
                .map((r) => (
                  <li key={r.id} className="rounded-xl bg-slate-50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{r.name}</span>
                      <span className="flex gap-1">
                        {r.enforce_order ? <Badge tone="amber">順序あり</Badge> : null}
                        {r.time_limit_min ? <Badge>{r.time_limit_min}分</Badge> : null}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-600">{r.points.map((p) => `${p.seq}. ${p.label}`).join(" → ")}</div>
                  </li>
                ))}
            </ul>
          )}
        </Card>

        <Card title="作業手順（インターロック）" action={<Button size="sm" onClick={() => setNewProc(true)}>＋ 手順作成</Button>}>
          {!procs.data?.length ? (
            <Empty>作業手順がありません</Empty>
          ) : (
            <ul className="space-y-3">
              {procs.data.map((p) => (
                <li key={p.id} className="rounded-xl bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">{p.name}</span>
                    {p.unlocks_equipment ? <Badge tone="green">完了で起動許可</Badge> : null}
                  </div>
                  {p.equipment_name && <div className="text-xs text-slate-500">対象: {p.equipment_name}</div>}
                  <ol className="mt-2 space-y-0.5 text-xs text-slate-700">
                    {p.steps.map((s) => (
                      <li key={s.seq}>
                        {s.seq}. {s.instruction} <span className="text-slate-400">［{s.label}］</span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="最近の巡回実績">
        {!runs.data?.length ? (
          <Empty>巡回実績はまだありません</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-2">開始</th>
                <th>ルート</th>
                <th>担当</th>
                <th>到達</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{fmtDateTime(r.started_at)}</td>
                  <td>{r.route_name}</td>
                  <td>{r.user_name}</td>
                  <td className="tabular-nums">
                    {r.visited}/{r.total}
                  </td>
                  <td>
                    <Badge tone={r.status === "completed" ? "green" : r.status === "abandoned" ? "red" : "blue"}>{{ completed: "完了", abandoned: "中断", in_progress: "実施中" }[r.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {newRoute && <RouteForm siteId={siteId} tags={siteTags} onClose={() => setNewRoute(false)} onSaved={() => (setNewRoute(false), void routes.reload())} />}
      {newProc && (
        <ProcForm tags={siteTags} equipment={equipment.data ?? []} onClose={() => setNewProc(false)} onSaved={() => (setNewProc(false), void procs.reload())} />
      )}
    </div>
  );
}

function RouteForm({ siteId, tags, onClose, onSaved }: { siteId: string; tags: TagOpt[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [enforce, setEnforce] = useState(false);
  const [limit, setLimit] = useState("");
  const [points, setPoints] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const label = (id: string) => tags.find((t) => t.id === id)?.label ?? id;
  return (
    <Modal open onClose={onClose} title="巡回ルートを作成" wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ルート名 *">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="夜間巡回 A" />
          </Field>
          <Field label="目安時間（分）">
            <Input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={enforce} onChange={(e) => setEnforce(e.target.checked)} className="h-5 w-5" /> 順番通りの巡回を必須にする
        </label>
        <div>
          <div className="mb-1 text-sm font-semibold">チェックポイント（クリックで追加）</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button key={t.id} onClick={() => setPoints([...points, t.id])} className="rounded-full bg-slate-100 px-3 py-1 text-sm hover:bg-slate-200">
                ＋ {t.label}
              </button>
            ))}
          </div>
        </div>
        <ol className="space-y-1">
          {points.map((p, i) => (
            <li key={i} className="flex items-center justify-between rounded-lg bg-sky-50 px-3 py-1.5 text-sm">
              <span>
                {i + 1}. {label(p)}
              </span>
              <button className="text-red-500" onClick={() => setPoints(points.filter((_, j) => j !== i))}>
                ✕
              </button>
            </li>
          ))}
        </ol>
        {err && <Alert>{err}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            disabled={!name || !points.length}
            onClick={async () => {
              try {
                await post("/admin/routes", { siteId, name, enforceOrder: enforce, timeLimitMin: limit ? Number(limit) : null, tagIds: points });
                onSaved();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            作成
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProcForm({ tags, equipment, onClose, onSaved }: { tags: TagOpt[]; equipment: { id: string; name: string; lockable: number }[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [equipmentId, setEquipmentId] = useState("");
  const [unlocks, setUnlocks] = useState(false);
  const [steps, setSteps] = useState<{ tagId: string; instruction: string }[]>([{ tagId: "", instruction: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const eq = equipment.find((e) => e.id === equipmentId);
  return (
    <Modal open onClose={onClose} title="作業手順を作成" wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="手順名 *">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="始業前点検" />
          </Field>
          <Field label="対象設備">
            <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
              <option value="">—</option>
              {equipment.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {eq?.lockable ? (
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={unlocks} onChange={(e) => setUnlocks(e.target.checked)} className="h-5 w-5" />
            全手順の完了で設備の起動を許可する（インターロック）
          </label>
        ) : null}
        <div className="space-y-2">
          <div className="text-sm font-semibold">手順（タグのタッチ順）</div>
          {steps.map((s, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-6 pt-3 text-sm font-bold">{i + 1}</span>
              <Select value={s.tagId} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, tagId: e.target.value } : x)))} className="w-48">
                <option value="">タグ</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input value={s.instruction} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)))} placeholder="作業内容（例: タイヤの空気圧を確認）" />
              <button className="px-2 text-red-500" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { tagId: "", instruction: "" }])}>
            ＋ 手順を追加
          </Button>
        </div>
        {err && <Alert>{err}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            disabled={!name || !steps.length || steps.some((s) => !s.tagId || !s.instruction)}
            onClick={async () => {
              try {
                await post("/admin/procedures", { name, equipmentId: equipmentId || null, unlocksEquipment: unlocks, steps });
                onSaved();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            作成
          </Button>
        </div>
      </div>
    </Modal>
  );
}
