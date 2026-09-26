import { useEffect, useState } from "react";
import { ApiError, get, post } from "../lib/api";
import { Alert, Button, Field, Input, Select } from "./ui";
import { TAG_KIND_LABEL, tagCode } from "../lib/format";

interface Site {
  id: string;
  name: string;
}
interface Zone {
  id: string;
  site_id: string;
  name: string;
}

/**
 * 受領済みタグ（運営から出荷されたもの）を設置場所・設備に登録するフォーム。
 * 管理画面のモーダルと、現場でタグにタッチしたときの画面の両方で使う。
 */
export function TagRegisterForm({
  stockId,
  defaultSiteId,
  touch,
  onDone
}: {
  stockId: string;
  defaultSiteId?: string;
  touch?: { sun?: { picc: string; cmac: string }; serial?: string };
  onDone: (tagId: string) => void;
}) {
  const [sites, setSites] = useState<Site[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [equipment, setEquipment] = useState<{ id: string; name: string; site_id: string }[]>([]);
  const [f, setF] = useState({ siteId: defaultSiteId ?? "", kind: "checkpoint", label: "", zoneId: "", equipmentId: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void get<{ sites: Site[]; zones: Zone[] }>("/admin/sites").then((d) => {
      setSites(d.sites);
      setZones(d.zones);
      setF((x) => ({ ...x, siteId: x.siteId || d.sites[0]?.id || "" }));
    });
    void get<{ id: string; name: string; site_id: string }[]>("/admin/equipment").then(setEquipment);
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const siteZones = zones.filter((z) => z.site_id === f.siteId);
  const siteEq = equipment.filter((e) => e.site_id === f.siteId);

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-100 px-4 py-3">
        <div className="text-xs font-semibold text-slate-500">登録コード</div>
        <div className="font-mono text-lg font-bold">{tagCode(stockId)}</div>
      </div>
      <Field label="現場">
        <Select value={f.siteId} onChange={set("siteId")}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="用途">
        <Select value={f.kind} onChange={set("kind")}>
          {Object.entries(TAG_KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      {(f.kind === "equipment" || f.kind === "procedure_step") && (
        <Field label={f.kind === "equipment" ? "設備 *" : "設備（任意）"}>
          <Select
            value={f.equipmentId}
            onChange={(e) => {
              const eq = siteEq.find((x) => x.id === e.target.value);
              setF({ ...f, equipmentId: e.target.value, label: f.label || eq?.name || "" });
            }}
          >
            <option value="">選択</option>
            {siteEq.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="呼び名（現場での表示名）*">
        <Input value={f.label} onChange={set("label")} placeholder="例: B1F 機械室 入口" />
      </Field>
      <Field label="ゾーン（ヒートマップの集計単位）">
        <Select value={f.zoneId} onChange={set("zoneId")}>
          <option value="">—</option>
          {siteZones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
      </Field>
      {touch && <Alert tone="green">タグへのタッチを確認済みです（{touch.sun ? "暗号署名を検証して登録" : touch.serial ? "物理UIDを照合して登録" : "URLから登録"}）</Alert>}
      {err && <Alert>{err}</Alert>}
      <Button
        size="lg"
        className="w-full"
        disabled={busy || !f.siteId || !f.label || (f.kind === "equipment" && !f.equipmentId)}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await post<{ id: string }>("/admin/tags/register", {
              stockId,
              siteId: f.siteId,
              kind: f.kind,
              label: f.label,
              zoneId: f.zoneId || null,
              equipmentId: f.equipmentId || null,
              sun: touch?.sun,
              serial: touch?.serial
            });
            onDone(r.id);
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "登録中…" : "このタグを登録して稼働させる"}
      </Button>
    </div>
  );
}
