import { useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useApi } from "../../lib/hooks";
import { ApiError, patch, post } from "../../lib/api";
import { webNfcSupported, writeUrl } from "../../lib/nfc";
import { Alert, Badge, Button, Card, Empty, Field, Input, Select } from "../../components/ui";
import { Modal } from "../../components/Modal";
import { TAG_KIND_LABEL, fmtAgo } from "../../lib/format";

interface TagRow {
  id: string;
  site_id: string;
  kind: string;
  label: string;
  security: string;
  uid: string | null;
  active: number;
  zone_name: string | null;
  equipment_name: string | null;
  last_tap_at: number | null;
  sun_last_ctr: number;
}

const tagUrl = (id: string, sun: boolean) => `${location.origin}/t/${id}${sun ? "?picc=00000000000000000000000000000000&cmac=0000000000000000" : ""}`;

export default function TagsAdmin() {
  const { siteId, zones } = useAdmin();
  const tags = useApi<TagRow[]>("/admin/tags");
  const equipment = useApi<{ id: string; name: string }[]>(`/admin/equipment?siteId=${siteId}`, [siteId]);
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState<TagRow | null>(null);
  const rows = (tags.data ?? []).filter((t) => t.site_id === siteId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">NFCタグ（仮想ビーコン）</h1>
        <Button onClick={() => setCreating(true)}>＋ タグを登録</Button>
      </div>
      <Alert tone="blue">
        タグには <b>URL だけ</b> を書き込みます。タグ自体は識別子しか持たず、巡回・点検・権限などの状態はすべてクラウド側で管理されます。
        暗号付きタグ（NTAG 424 DNA）はタッチごとに一回限りの署名付きURLを生成するため、URLの複製による不正打刻を防げます。
      </Alert>
      <Card>
        {!rows.length ? (
          <Empty>タグが登録されていません</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-2">ラベル</th>
                  <th>種類</th>
                  <th>紐付け</th>
                  <th>方式</th>
                  <th>最終タッチ</th>
                  <th>URL</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((t) => (
                  <tr key={t.id} className={t.active ? "" : "opacity-40"}>
                    <td className="py-2.5 font-semibold">{t.label}</td>
                    <td>
                      <Badge>{TAG_KIND_LABEL[t.kind]}</Badge>
                    </td>
                    <td className="text-xs">{t.equipment_name ?? t.zone_name ?? "—"}</td>
                    <td>{t.security === "sun" ? <Badge tone="green">暗号(SUN)</Badge> : t.uid ? <Badge tone="blue">UID登録</Badge> : <Badge tone="amber">URLのみ</Badge>}</td>
                    <td className="text-xs">{fmtAgo(t.last_tap_at)}</td>
                    <td className="font-mono text-xs text-slate-500">/t/{t.id}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="sm" onClick={() => setWriting(t)}>
                        書き込み
                      </Button>
                      <Button variant="ghost" size="sm" onClick={async () => (await patch(`/admin/tags/${t.id}`, { active: !t.active }), tags.reload())}>
                        {t.active ? "無効化" : "有効化"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && (
        <CreateTag
          siteId={siteId}
          zones={zones.filter((z) => z.site_id === siteId)}
          equipment={equipment.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            void tags.reload();
            setWriting(t);
          }}
        />
      )}
      {writing && <WriteTag tag={writing} onClose={() => setWriting(null)} />}
    </div>
  );
}

function CreateTag({ siteId, zones, equipment, onClose, onCreated }: { siteId: string; zones: { id: string; name: string }[]; equipment: { id: string; name: string }[]; onClose: () => void; onCreated: (t: TagRow) => void }) {
  const [f, setF] = useState({ kind: "checkpoint", label: "", zoneId: "", equipmentId: "", security: "static", uid: "", sunMetaKey: "", sunFileKey: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save() {
    setErr(null);
    try {
      const r = await post<{ id: string }>("/admin/tags", {
        siteId,
        kind: f.kind,
        label: f.label,
        zoneId: f.zoneId || null,
        equipmentId: f.equipmentId || null,
        security: f.security,
        uid: f.uid || null,
        sunMetaKey: f.security === "sun" ? f.sunMetaKey : undefined,
        sunFileKey: f.security === "sun" ? f.sunFileKey : undefined
      });
      onCreated({ id: r.id, site_id: siteId, kind: f.kind, label: f.label, security: f.security, uid: f.uid || null, active: 1, zone_name: null, equipment_name: null, last_tap_at: null, sun_last_ctr: -1 });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }
  return (
    <Modal open onClose={onClose} title="NFCタグを登録" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="種類">
          <Select value={f.kind} onChange={set("kind")}>
            {Object.entries(TAG_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ラベル（現場での呼び名）*">
          <Input value={f.label} onChange={set("label")} placeholder="B1F 機械室 入口" />
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
        <Field label={f.kind === "equipment" ? "設備 *" : "設備（任意）"}>
          <Select value={f.equipmentId} onChange={set("equipmentId")}>
            <option value="">—</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="セキュリティ方式">
          <Select value={f.security} onChange={set("security")}>
            <option value="static">標準（NTAG213/215 等・URL）</option>
            <option value="sun">暗号付き（NTAG 424 DNA SUN）</option>
          </Select>
        </Field>
        <Field label="物理UID（任意）" hint="Android のアプリ内スキャン時に照合され、証明レベル「中」になります">
          <Input value={f.uid} onChange={set("uid")} placeholder="04:A1:B2:C3:D4:E5:F6" className="font-mono" />
        </Field>
        {f.security === "sun" && (
          <>
            <Field label="SDMMetaReadKey（16バイトhex）*">
              <Input value={f.sunMetaKey} onChange={set("sunMetaKey")} className="font-mono" />
            </Field>
            <Field label="SDMFileReadKey（16バイトhex）*">
              <Input value={f.sunFileKey} onChange={set("sunFileKey")} className="font-mono" />
            </Field>
            <div className="text-xs text-slate-500 sm:col-span-2">鍵はサーバー側で暗号化して保存され、画面には再表示されません。タグ側の SDM 設定は README の「NTAG 424 DNA の設定」を参照してください。</div>
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
        <Button onClick={save} disabled={!f.label}>
          登録
        </Button>
      </div>
    </Modal>
  );
}

function WriteTag({ tag, onClose }: { tag: TagRow; onClose: () => void }) {
  const url = tagUrl(tag.id, tag.security === "sun");
  const [state, setState] = useState<"idle" | "writing" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  return (
    <Modal open onClose={onClose} title={`タグへの書き込み: ${tag.label}`}>
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-sm font-semibold">書き込むURL</div>
          <div className="rounded-xl bg-slate-100 p-3 font-mono text-xs break-all">{url}</div>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void navigator.clipboard.writeText(url)}>
            コピー
          </Button>
        </div>
        {tag.security === "sun" ? (
          <Alert tone="amber">
            暗号付きタグは NXP TagXplorer 等で SDM（Secure Dynamic Messaging）を設定して書き込みます。上のURLの <code>picc=</code> の32桁部分を PICCData
            ミラー位置、<code>cmac=</code> の16桁部分を SDMMAC ミラー位置に指定してください。
          </Alert>
        ) : webNfcSupported ? (
          <>
            <Button
              size="lg"
              className="w-full"
              disabled={state === "writing"}
              onClick={async () => {
                setState("writing");
                try {
                  await writeUrl(url);
                  setState("done");
                } catch (e) {
                  setErr((e as Error).message);
                  setState("error");
                }
              }}
            >
              {state === "writing" ? "タグをかざしてください…" : "この端末でタグに書き込む"}
            </Button>
            {state === "done" && <Alert tone="green">書き込みました。書き込み後はタグのロック（読み取り専用化）を推奨します。</Alert>}
            {state === "error" && <Alert>{err}</Alert>}
          </>
        ) : (
          <Alert tone="blue">Android の Chrome でこの画面を開くと、その場でタグに書き込めます。iPhone の場合は「NFC Tools」等のアプリでURLレコードとして書き込んでください。</Alert>
        )}
      </div>
    </Modal>
  );
}
