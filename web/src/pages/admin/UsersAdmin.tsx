import { useState } from "react";
import { useApi } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { ApiError, del, patch, post, put } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { fmtDate, tagCode } from "../../lib/format";

interface UserRow {
  id: string;
  role: string;
  name: string;
  email: string | null;
  employee_code: string;
  badge_uid: string | null;
  ble_id: string | null;
  active: number;
  quals: { id: string; code: string; name: string; expiresAt: number | null }[];
}
interface Qual {
  id: string;
  code: string;
  name: string;
}
const ROLE: Record<string, string> = { admin: "管理者", manager: "マネージャー", worker: "作業員" };

export default function UsersAdmin() {
  const { me } = useAuth();
  const users = useApi<UserRow[]>("/admin/users");
  const quals = useApi<Qual[]>("/admin/qualifications");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [grantFor, setGrantFor] = useState<UserRow | null>(null);
  const [badgeFor, setBadgeFor] = useState<UserRow | null>(null);
  const [newQual, setNewQual] = useState({ code: "", name: "" });
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = me?.role === "admin";
  // 固定リーダー・BLE受信機（IoT連携）はオプション機能。契約していなければ関連項目を隠す
  const iot = !!me?.features.includes("devices");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">作業員・資格</h1>
        {isAdmin && <Button onClick={() => setCreating(true)}>＋ ユーザーを追加</Button>}
      </div>
      <Card>
        {!users.data?.length ? (
          <Empty>ユーザーがいません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">社員番号</th>
                  <th>氏名</th>
                  <th>権限</th>
                  <th>資格</th>
                  {iot && <th>社員証 / BLE</th>}
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.data.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "opacity-40"}>
                    <td className="py-2.5 font-mono text-xs">{u.employee_code}</td>
                    <td className="font-semibold">
                      {u.name}
                      {u.email && <div className="text-xs font-normal text-slate-500">{u.email}</div>}
                    </td>
                    <td>
                      <Badge tone={u.role === "worker" ? "slate" : "blue"}>{ROLE[u.role]}</Badge>
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {u.quals.map((q) => {
                          const expired = q.expiresAt && q.expiresAt < Date.now();
                          return (
                            <span key={q.id} className="group inline-flex items-center">
                              <Badge tone={expired ? "red" : "green"}>
                                {q.name}
                                {q.expiresAt ? `（〜${fmtDate(q.expiresAt)}）` : ""}
                              </Badge>
                              <button
                                className="ml-0.5 hidden text-xs text-red-500 group-hover:inline"
                                onClick={async () => {
                                  if (!confirm(`${u.name} さんの「${q.name}」を取り消しますか？`)) return;
                                  await del(`/admin/users/${u.id}/qualifications/${q.id}`);
                                  void users.reload();
                                }}
                              >
                                ✕
                              </button>
                            </span>
                          );
                        })}
                        <button className="text-xs font-semibold text-sky-700" onClick={() => setGrantFor(u)}>
                          ＋付与
                        </button>
                      </div>
                    </td>
                    {iot && (
                      <td className="font-mono text-xs text-slate-500">
                        {u.badge_uid ?? "—"}
                        <br />
                        {u.ble_id ?? "—"}
                      </td>
                    )}
                    <td className="text-right whitespace-nowrap">
                      {iot && (
                        <Button variant="ghost" size="sm" onClick={() => setBadgeFor(u)}>
                          社員証
                        </Button>
                      )}
                      {isAdmin && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                            編集
                          </Button>
                          <Button variant="ghost" size="sm" onClick={async () => (await patch(`/admin/users/${u.id}`, { active: !u.active }), users.reload())}>
                            {u.active ? "無効化" : "有効化"}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="資格マスタ">
        <div className="mb-4 flex flex-wrap gap-2">
          {quals.data?.map((q) => (
            <Badge key={q.id}>
              {q.code}: {q.name}
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="コード">
            <Input value={newQual.code} onChange={(e) => setNewQual({ ...newQual, code: e.target.value })} placeholder="FORKLIFT" className="w-40" />
          </Field>
          <Field label="名称">
            <Input value={newQual.name} onChange={(e) => setNewQual({ ...newQual, name: e.target.value })} placeholder="フォークリフト運転技能講習" className="w-72" />
          </Field>
          <Button
            disabled={!newQual.code || !newQual.name}
            onClick={async () => {
              setErr(null);
              try {
                await post("/admin/qualifications", newQual);
                setNewQual({ code: "", name: "" });
                void quals.reload();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            追加
          </Button>
        </div>
        {err && (
          <div className="mt-3">
            <Alert>{err}</Alert>
          </div>
        )}
      </Card>

      {(creating || editing) && (
        <UserForm
          row={editing}
          onClose={() => (setCreating(false), setEditing(null))}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void users.reload();
          }}
        />
      )}
      {badgeFor && <BadgeModal user={badgeFor} onClose={() => setBadgeFor(null)} onSaved={() => (setBadgeFor(null), void users.reload())} />}
      {grantFor && <GrantModal user={grantFor} quals={quals.data ?? []} onClose={() => setGrantFor(null)} onSaved={() => (setGrantFor(null), void users.reload())} />}
    </div>
  );
}

function UserForm({ row, onClose, onSaved }: { row: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const iot = !!me?.features.includes("devices");
  const [f, setF] = useState({
    role: row?.role ?? "worker",
    name: row?.name ?? "",
    employeeCode: row?.employee_code ?? "",
    email: row?.email ?? "",
    secret: "",
    badgeUid: row?.badge_uid ?? "",
    bleId: row?.ble_id ?? ""
  });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const worker = f.role === "worker";
  async function save() {
    setErr(null);
    const payload: Record<string, unknown> = { role: f.role, name: f.name, employeeCode: f.employeeCode, email: f.email || null, badgeUid: f.badgeUid || null, bleId: f.bleId || null };
    if (f.secret) payload.secret = f.secret;
    try {
      if (row) await patch(`/admin/users/${row.id}`, payload);
      else await post("/admin/users", payload);
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <Modal open onClose={onClose} title={row ? "ユーザーを編集" : "ユーザーを追加"} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="権限">
          <Select value={f.role} onChange={set("role")}>
            {Object.entries(ROLE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="氏名 *">
          <Input value={f.name} onChange={set("name")} />
        </Field>
        <Field label="社員番号 *">
          <Input value={f.employeeCode} onChange={set("employeeCode")} />
        </Field>
        <Field label={worker ? "メール（任意）" : "メール *"}>
          <Input type="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label={worker ? (row ? "PIN（変更時のみ）" : "PIN（4桁以上）*") : row ? "パスワード（変更時のみ）" : "パスワード（8文字以上）*"}>
          <Input type="password" value={f.secret} onChange={set("secret")} inputMode={worker ? "numeric" : undefined} />
        </Field>
        <div />
        {iot && (
          <>
            <Field label="スマート社員証 UID（プランB）" hint="固定リーダーでのタッチ認証に使用">
              <Input value={f.badgeUid} onChange={set("badgeUid")} className="font-mono" />
            </Field>
            <Field label="携帯BLEタグ ID" hint="iBeacon の major:minor 等。重機の接近検知で本人を特定">
              <Input value={f.bleId} onChange={set("bleId")} className="font-mono" placeholder="100:23" />
            </Field>
          </>
        )}
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
        <Button onClick={save} disabled={!f.name || !f.employeeCode || (!row && !f.secret)}>
          保存
        </Button>
      </div>
    </Modal>
  );
}

function GrantModal({ user, quals, onClose, onSaved }: { user: UserRow; quals: Qual[]; onClose: () => void; onSaved: () => void }) {
  const [qid, setQid] = useState("");
  const [expires, setExpires] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={`資格を付与: ${user.name}`}>
      <div className="space-y-4">
        <Field label="資格">
          <Select value={qid} onChange={(e) => setQid(e.target.value)}>
            <option value="">選択</option>
            {quals.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="有効期限（任意）">
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full"
          disabled={!qid}
          onClick={async () => {
            try {
              await put(`/admin/users/${user.id}/qualifications/${qid}`, {
                certifiedAt: Date.now(),
                expiresAt: expires ? new Date(`${expires}T23:59:59+09:00`).getTime() : null
              });
              onSaved();
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          付与する
        </Button>
      </div>
    </Modal>
  );
}

function BadgeModal({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const stock = useApi<{ id: string; item_type: string; uid: string | null; status: string; registered_user_id: string | null }[]>("/admin/tag-stock");
  const badges = (stock.data ?? []).filter((s) => s.item_type === "badge");
  const current = badges.find((b) => b.registered_user_id === user.id);
  const free = badges.filter((b) => b.status === "allocated");
  const [stockId, setStockId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async (id: string | null) => {
    try {
      await put(`/admin/users/${user.id}/badge`, { stockId: id });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <Modal open onClose={onClose} title={`スマート社員証: ${user.name}`}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">運営から届いた社員証を割り当てると、固定NFCリーダー（プランB）でのタッチ打刻・資格判定に使えます。</p>
        {current ? (
          <Alert tone="green">
            割当中: <span className="font-mono">{tagCode(current.id)}</span>（UID {current.uid}）
          </Alert>
        ) : user.badge_uid ? (
          <Alert tone="blue">手入力のUID: {user.badge_uid}</Alert>
        ) : null}
        <Field label="割り当てる社員証">
          <Select value={stockId} onChange={(e) => setStockId(e.target.value)}>
            <option value="">選択</option>
            {free.map((b) => (
              <option key={b.id} value={b.id} disabled={!b.uid}>
                {tagCode(b.id)} {b.uid ? "" : "（UID未登録）"}
              </option>
            ))}
          </Select>
        </Field>
        {!free.length && <p className="text-xs text-slate-500">割当可能な社員証がありません。「契約・サポート」から追加をご依頼ください。</p>}
        {err && <Alert>{err}</Alert>}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={!stockId} onClick={() => void save(stockId)}>
            割り当てる
          </Button>
          {(current || user.badge_uid) && (
            <Button variant="outline" onClick={() => void save(null)}>
              解除
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
