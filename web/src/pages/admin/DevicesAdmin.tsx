import { useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { ApiError, del, post } from "../../lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { fmtAgo } from "../../lib/format";

interface Device {
  id: string;
  site_id: string;
  kind: string;
  name: string;
  equipment_name: string | null;
  last_seen_at: number | null;
}

export default function DevicesAdmin() {
  const { siteId } = useAdmin();
  const devices = useApi<Device[]>("/admin/devices");
  const equipment = useApi<{ id: string; name: string }[]>(`/admin/equipment?siteId=${siteId}`, [siteId]);
  const tags = useApi<{ id: string; site_id: string; label: string }[]>("/admin/tags");
  const [creating, setCreating] = useState(false);
  const [credential, setCredential] = useState<string | null>(null);
  const rows = (devices.data ?? []).filter((d) => d.site_id === siteId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">IoTデバイス</h1>
        <Button onClick={() => setCreating(true)}>＋ デバイスを登録</Button>
      </div>
      <Alert tone="blue">
        <b>重機側BLEレシーバー</b>：作業員の携帯BLEタグを検知し、<b>ネットワークを介さずローカルで</b>警報・停止を行います。クラウドへは後から接近ログのみ送信します。
        <br />
        <b>固定NFCリーダー</b>（プランB）：スマート社員証のタッチで資格判定・打刻を行います。
      </Alert>
      <Card>
        {!rows.length ? (
          <Empty>デバイスが登録されていません</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-2">名称</th>
                <th>種類</th>
                <th>設備</th>
                <th>最終通信</th>
                <th>ID</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((d) => {
                const stale = !d.last_seen_at || Date.now() - d.last_seen_at > 3600_000;
                return (
                  <tr key={d.id}>
                    <td className="py-2.5 font-semibold">{d.name}</td>
                    <td>
                      <Badge tone={d.kind === "ble_receiver" ? "amber" : "blue"}>{d.kind === "ble_receiver" ? "BLEレシーバー" : "NFCリーダー"}</Badge>
                    </td>
                    <td className="text-xs">{d.equipment_name ?? "—"}</td>
                    <td className={stale ? "text-xs text-red-600" : "text-xs"}>{fmtAgo(d.last_seen_at)}</td>
                    <td className="font-mono text-xs text-slate-500">{d.id}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (!confirm("認証情報を再発行しますか？ 現在の認証情報は無効になります")) return;
                          setCredential((await post<{ credential: string }>(`/admin/devices/${d.id}/rotate`)).credential);
                        }}
                      >
                        再発行
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          if (!confirm("削除しますか？")) return;
                          await del(`/admin/devices/${d.id}`);
                          void devices.reload();
                        }}
                      >
                        削除
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {creating && (
        <CreateDevice
          siteId={siteId}
          equipment={equipment.data ?? []}
          tags={(tags.data ?? []).filter((t) => t.site_id === siteId)}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCredential(c);
            void devices.reload();
          }}
        />
      )}
      {credential && (
        <Modal open onClose={() => setCredential(null)} title="デバイス認証情報">
          <div className="space-y-3">
            <Alert tone="amber">この認証情報は<b>今回のみ表示</b>されます。デバイスの設定ファイルに保存してください。</Alert>
            <div className="rounded-xl bg-slate-900 p-3 font-mono text-xs break-all text-emerald-300">{credential}</div>
            <div className="text-xs text-slate-500">
              HTTP ヘッダ: <code>Authorization: Device {credential.slice(0, 20)}…</code>
            </div>
            <Button className="w-full" onClick={() => void navigator.clipboard.writeText(credential)}>
              コピー
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateDevice({ siteId, equipment, tags, onClose, onCreated }: { siteId: string; equipment: { id: string; name: string }[]; tags: { id: string; label: string }[]; onClose: () => void; onCreated: (c: string) => void }) {
  const [f, setF] = useState({ kind: "ble_receiver", name: "", equipmentId: "", tagId: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title="デバイスを登録">
      <div className="space-y-4">
        <Field label="種類">
          <Select value={f.kind} onChange={set("kind")}>
            <option value="ble_receiver">重機側 BLE レシーバー</option>
            <option value="nfc_reader">固定 NFC リーダー（プランB）</option>
          </Select>
        </Field>
        <Field label="名称 *">
          <Input value={f.name} onChange={set("name")} placeholder="フォークリフト1号機 受信機" />
        </Field>
        <Field label="紐付ける設備">
          <Select value={f.equipmentId} onChange={set("equipmentId")}>
            <option value="">—</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        {f.kind === "nfc_reader" && (
          <Field label="リーダーが代理する地点タグ *" hint="社員証タッチはこのタグへのタッチとして記録されます">
            <Select value={f.tagId} onChange={set("tagId")}>
              <option value="">—</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full"
          disabled={!f.name || (f.kind === "nfc_reader" && !f.tagId)}
          onClick={async () => {
            try {
              const r = await post<{ credential: string }>("/admin/devices", { siteId, kind: f.kind, name: f.name, equipmentId: f.equipmentId || null, tagId: f.tagId || null });
              onCreated(r.credential);
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          登録
        </Button>
      </div>
    </Modal>
  );
}
