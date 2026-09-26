import { useState } from "react";
import { useAdmin } from "./AdminLayout";
import { useAuth } from "../../lib/auth";
import { ApiError, post } from "../../lib/api";
import { Alert, Button, Card, Field, Input } from "../../components/ui";

export default function SitesAdmin() {
  const { sites, zones, siteId, reloadSites, setSiteId } = useAdmin();
  const { me } = useAuth();
  const [site, setSite] = useState({ name: "", address: "" });
  const [zone, setZone] = useState({ name: "", floor: "" });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const siteZones = zones.filter((z) => z.site_id === siteId);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reloadSites();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">現場・ゾーン</h1>
      {err && <Alert>{err}</Alert>}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="現場一覧">
          <ul className="mb-4 space-y-1">
            {sites.map((s) => (
              <li key={s.id}>
                <button onClick={() => setSiteId(s.id)} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${s.id === siteId ? "bg-slate-900 text-white" : "hover:bg-slate-100"}`}>
                  <div className="font-semibold">{s.name}</div>
                  {s.address && <div className="text-xs opacity-70">{s.address}</div>}
                </button>
              </li>
            ))}
          </ul>
          {me?.role === "admin" && (
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <Field label="現場名">
                <Input value={site.name} onChange={(e) => setSite({ ...site, name: e.target.value })} />
              </Field>
              <Field label="住所">
                <Input value={site.address} onChange={(e) => setSite({ ...site, address: e.target.value })} />
              </Field>
              <Button className="w-full" disabled={!site.name} onClick={() => run(async () => (await post("/admin/sites", site), setSite({ name: "", address: "" })))}>
                現場を追加
              </Button>
            </div>
          )}
        </Card>

        <Card title="ゾーン（ヒートマップの集計単位）" className="xl:col-span-2">
          <p className="mb-2 text-xs text-slate-500">下の図をクリックしてゾーンの位置を指定し、名称を入力して追加します。</p>
          <div
            className="relative aspect-[16/9] w-full cursor-crosshair overflow-hidden rounded-xl bg-[linear-gradient(#e2e8f0_1px,transparent_1px),linear-gradient(90deg,#e2e8f0_1px,transparent_1px)] bg-[size:40px_40px] ring-1 ring-slate-200"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPos({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            }}
          >
            {siteZones.map((z) =>
              z.pos_x != null && z.pos_y != null ? (
                <div key={z.id} className="absolute -translate-x-1/2 -translate-y-1/2 rounded-lg bg-slate-900 px-2 py-1 text-xs font-semibold text-white" style={{ left: `${z.pos_x * 100}%`, top: `${z.pos_y * 100}%` }}>
                  {z.name}
                </div>
              ) : null
            )}
            {pos && <div className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-500 ring-4 ring-amber-200" style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }} />}
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field label="ゾーン名">
              <Input value={zone.name} onChange={(e) => setZone({ ...zone, name: e.target.value })} placeholder="B1F 機械室" className="w-56" />
            </Field>
            <Field label="階">
              <Input value={zone.floor} onChange={(e) => setZone({ ...zone, floor: e.target.value })} placeholder="B1" className="w-24" />
            </Field>
            <Button
              disabled={!zone.name}
              onClick={() =>
                run(async () => {
                  await post("/admin/zones", { siteId, name: zone.name, floor: zone.floor || null, posX: pos?.x ?? null, posY: pos?.y ?? null });
                  setZone({ name: "", floor: "" });
                  setPos(null);
                })
              }
            >
              ゾーンを追加
            </Button>
          </div>
          <ul className="mt-4 flex flex-wrap gap-2 text-sm">
            {siteZones.map((z) => (
              <li key={z.id} className="rounded-full bg-slate-100 px-3 py-1">
                {z.floor ? `${z.floor} ` : ""}
                {z.name}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
