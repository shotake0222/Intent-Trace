import { useMemo, useState } from "react";
import { useApi } from "../../lib/hooks";
import { ApiError, post } from "../../lib/api";
import { useOps } from "./OpsLayout";
import { AllocateModal } from "./OpsTenantDetail";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Textarea } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { ITEM_TYPE_LABEL, STOCK_STATUS_LABEL, fmtDate, tagCode } from "../../lib/format";

interface SummaryRow {
  batch: string;
  item_type: string;
  chip: string;
  status: string;
  n: number;
  with_uid: number;
  created_at: number;
}
interface StockRow {
  id: string;
  item_type: string;
  chip: string;
  uid: string | null;
  batch: string;
  status: string;
  org_name: string | null;
  allocated_at: number | null;
  shipment_note: string | null;
  tag_label: string | null;
  user_name: string | null;
  has_keys: number;
}

export default function OpsStock() {
  const { me } = useOps();
  const summary = useApi<SummaryRow[]>("/ops/stock/summary");
  const [filter, setFilter] = useState({ batch: "", status: "", q: "" });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const list = useApi<StockRow[]>(`/ops/stock?${qs}`, [qs]);
  const [modal, setModal] = useState<"generate" | "import" | "allocate" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const batches = useMemo(() => {
    const m = new Map<string, { batch: string; item_type: string; chip: string; created_at: number; total: number; with_uid: number; by: Record<string, number> }>();
    for (const s of summary.data ?? []) {
      const k = s.batch;
      const e = m.get(k) ?? { batch: s.batch, item_type: s.item_type, chip: s.chip, created_at: s.created_at, total: 0, with_uid: 0, by: {} };
      e.total += s.n;
      e.with_uid += s.with_uid;
      e.by[s.status] = (e.by[s.status] ?? 0) + s.n;
      m.set(k, e);
    }
    return [...m.values()];
  }, [summary.data]);

  const reloadAll = () => {
    void summary.reload();
    void list.reload();
    setSelected(new Set());
  };
  const bulk = async (path: string, label: string) => {
    try {
      const r = await post<Record<string, number>>(path, { ids: [...selected] });
      setMsg({ tone: "green", text: `${label}: ${Object.values(r)[0]} 件` });
      reloadAll();
    } catch (e) {
      setMsg({ tone: "red", text: e instanceof ApiError ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">NFCタグ在庫・出荷</h1>
        <div className="flex flex-wrap gap-2">
          <Button className="!bg-indigo-700" onClick={() => setModal("generate")}>
            ＋ 登録コードを発行
          </Button>
          <Button variant="outline" onClick={() => setModal("import")}>
            UID取込
          </Button>
          <Button variant="outline" onClick={() => setModal("allocate")}>
            テナントへ出荷割当
          </Button>
        </div>
      </div>
      <Alert tone="blue">
        <b>流れ:</b> ① 登録コードを発行（URL・暗号鍵を生成）→ ② CSVでタグに書き込み（自社またはエンコード業者）→ ③ UIDを取り込み → ④ ラベルを貼って出荷割当 → ⑤ テナントが現地でタッチして設置場所を登録
      </Alert>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <Card title="ロット別">
        {!batches.length ? (
          <Empty>まだ在庫がありません。「登録コードを発行」から作成してください</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">ロット</th>
                  <th>種類</th>
                  <th>チップ</th>
                  <th className="text-right">総数</th>
                  <th className="text-right">在庫</th>
                  <th className="text-right">出荷済</th>
                  <th className="text-right">稼働</th>
                  <th className="pl-4 text-right">UID取込</th>
                  <th className="pl-4">作成</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.map((b) => (
                  <tr key={b.batch}>
                    <td className="py-2 font-semibold">
                      <button className="text-indigo-700" onClick={() => setFilter({ ...filter, batch: b.batch })}>
                        {b.batch}
                      </button>
                    </td>
                    <td>{ITEM_TYPE_LABEL[b.item_type]}</td>
                    <td className="font-mono text-xs">{b.chip}</td>
                    <td className="text-right tabular-nums">{b.total}</td>
                    <td className="text-right tabular-nums">{b.by.in_stock ?? 0}</td>
                    <td className="text-right tabular-nums">{b.by.allocated ?? 0}</td>
                    <td className="text-right tabular-nums">{b.by.registered ?? 0}</td>
                    <td className="pl-4 text-right tabular-nums">
                      {b.with_uid}/{b.total}
                    </td>
                    <td className="pl-4 text-xs">{fmtDate(b.created_at)}</td>
                    <td className="text-right whitespace-nowrap">
                      <a href={`/api/ops/stock/export.csv?batch=${encodeURIComponent(b.batch)}`}>
                        <Button variant="ghost" size="sm">
                          CSV
                        </Button>
                      </a>
                      {b.chip === "ntag424" && me.role === "owner" && (
                        <a
                          href={`/api/ops/stock/export.csv?batch=${encodeURIComponent(b.batch)}&keys=1`}
                          onClick={(e) => {
                            if (!confirm("暗号鍵を含むCSVを書き出します。取り扱いに注意し、書き込み後は削除してください。操作は監査ログに記録されます。")) e.preventDefault();
                          }}
                        >
                          <Button variant="ghost" size="sm">
                            鍵付CSV
                          </Button>
                        </a>
                      )}
                      <a href={`/api/ops/stock/labels?batch=${encodeURIComponent(b.batch)}`} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm">
                          ラベル
                        </Button>
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="個別の在庫"
        action={
          selected.size > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void bulk("/ops/stock/unallocate", "割当解除")}>
                割当解除（{selected.size}）
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  if (confirm(`${selected.size} 件を廃棄扱いにしますか？`)) void bulk("/ops/stock/retire", "廃棄");
                }}
              >
                廃棄
              </Button>
            </div>
          )
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <Input placeholder="登録コード・UIDで検索" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value.replace(/[^0-9A-Za-z]/g, "").toUpperCase() })} className="max-w-xs font-mono" />
          <Select value={filter.batch} onChange={(e) => setFilter({ ...filter, batch: e.target.value })} className="max-w-[200px]">
            <option value="">全ロット</option>
            {batches.map((b) => (
              <option key={b.batch} value={b.batch}>
                {b.batch}
              </option>
            ))}
          </Select>
          <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} className="max-w-[180px]">
            <option value="">全状態</option>
            {Object.entries(STOCK_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        {!list.data?.length ? (
          <Empty>該当なし</Empty>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">
                    <input
                      type="checkbox"
                      onChange={(e) => setSelected(e.target.checked ? new Set(list.data!.map((s) => s.id)) : new Set())}
                      checked={selected.size > 0 && selected.size === list.data.length}
                    />
                  </th>
                  <th>登録コード</th>
                  <th>種類</th>
                  <th>UID</th>
                  <th>状態</th>
                  <th>出荷先</th>
                  <th>設置場所 / 利用者</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((s) => (
                  <tr key={s.id}>
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={(e) => {
                          const n = new Set(selected);
                          if (e.target.checked) n.add(s.id);
                          else n.delete(s.id);
                          setSelected(n);
                        }}
                      />
                    </td>
                    <td className="font-mono">{tagCode(s.id)}</td>
                    <td className="text-xs">
                      {ITEM_TYPE_LABEL[s.item_type]} <span className="text-slate-400">{s.chip}</span>
                      {s.has_keys ? <Badge tone="green">鍵</Badge> : null}
                    </td>
                    <td className="font-mono text-xs">{s.uid ?? <span className="text-amber-600">未取込</span>}</td>
                    <td>
                      <Badge tone={s.status === "registered" ? "green" : s.status === "allocated" ? "blue" : s.status === "retired" ? "red" : "slate"}>{STOCK_STATUS_LABEL[s.status]}</Badge>
                    </td>
                    <td className="text-xs">
                      {s.org_name ?? "—"}
                      {s.shipment_note ? <div className="text-slate-400">{s.shipment_note}</div> : null}
                    </td>
                    <td className="text-xs">{s.tag_label ?? s.user_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {modal === "generate" && <GenerateModal onClose={() => setModal(null)} onDone={(n, batch) => (setModal(null), setMsg({ tone: "green", text: `ロット「${batch}」に ${n} 件発行しました` }), reloadAll())} />}
      {modal === "import" && <ImportModal onClose={() => setModal(null)} onDone={(t) => (setModal(null), setMsg({ tone: "green", text: t }), reloadAll())} />}
      {modal === "allocate" && <AllocateModal onClose={() => setModal(null)} onDone={(n) => (setModal(null), setMsg({ tone: "green", text: `${n} 件を出荷割当しました` }), reloadAll())} />}
    </div>
  );
}

function GenerateModal({ onClose, onDone }: { onClose: () => void; onDone: (n: number, batch: string) => void }) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const [f, setF] = useState({ count: "50", itemType: "location_tag", chip: "ntag213", batch: `L${today}-01`, note: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title="登録コードを発行">
      <div className="space-y-4">
        <Field label="種類">
          <Select value={f.itemType} onChange={set("itemType")}>
            <option value="location_tag">設置タグ（場所・設備に貼る）</option>
            <option value="badge">スマート社員証</option>
          </Select>
        </Field>
        <Field label="チップ">
          <Select value={f.chip} onChange={set("chip")}>
            <option value="ntag213">NTAG213（標準・安価）</option>
            <option value="ntag215">NTAG215</option>
            <option value="ntag216">NTAG216</option>
            <option value="ntag424">NTAG 424 DNA（暗号SUN・なりすまし防止）</option>
            <option value="mifare">MIFARE（社員証）</option>
            <option value="other">その他</option>
          </Select>
        </Field>
        {f.chip === "ntag424" && <Alert tone="blue">タグごとに固有の暗号鍵を自動生成し、サーバーで暗号化して保管します。書き込み時は「鍵付CSV」を使用します。</Alert>}
        <Field label="枚数（最大500）">
          <Input type="number" min={1} max={500} value={f.count} onChange={set("count")} />
        </Field>
        <Field label="ロット名">
          <Input value={f.batch} onChange={set("batch")} />
        </Field>
        <Field label="メモ（仕入先など）">
          <Input value={f.note} onChange={set("note")} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full !bg-indigo-700"
          onClick={async () => {
            try {
              const r = await post<{ created: number }>("/ops/stock/generate", { count: Number(f.count), itemType: f.itemType, chip: f.chip, batch: f.batch, note: f.note || null });
              onDone(r.created, f.batch);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          発行
        </Button>
      </div>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (text: string) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split(/[,\t]/).map((x) => x.trim()))
    .filter((c) => c.length >= 2 && /^[0-9A-Za-z-]{8,}$/.test(c[0]) && /^[0-9A-Fa-f:]{8,}$/.test(c[1]))
    .map(([id, uid]) => ({ id: id.replace(/-/g, "").toUpperCase(), uid }));
  return (
    <Modal open onClose={onClose} title="物理UIDの取り込み" wide>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">書き込みツール・エンコード業者から受け取った「登録コード, UID」の一覧を貼り付けてください（CSV/タブ区切り、1行1枚）。UIDを登録すると、タッチ時に物理タグの照合ができます。</p>
        <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder={"ABCDE12345,04A1B2C3D4E5F6\nFGHJK67890,04:11:22:33:44:55:66"} />
        <div className="text-sm text-slate-500">認識した行: {rows.length}</div>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full !bg-indigo-700"
          disabled={!rows.length}
          onClick={async () => {
            try {
              const r = await post<{ updated: number; errors: string[] }>("/ops/stock/import-uids", { rows });
              onDone(`UIDを ${r.updated} 件取り込みました${r.errors.length ? `（エラー ${r.errors.length} 件: ${r.errors.slice(0, 3).join(" / ")}）` : ""}`);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          取り込む
        </Button>
      </div>
    </Modal>
  );
}
