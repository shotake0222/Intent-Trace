import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useOutletContext } from "react-router";
import { useAuth } from "../../lib/auth";
import { useApi } from "../../lib/hooks";
import { Alert, Button, Select, cx } from "../../components/ui";
import { post, ApiError } from "../../lib/api";
import { TERMS_VERSION } from "../../../../shared/types";

export interface Site {
  id: string;
  name: string;
  address: string | null;
}
export interface Zone {
  id: string;
  site_id: string;
  name: string;
  floor: string | null;
  pos_x: number | null;
  pos_y: number | null;
}
export interface AdminCtx {
  sites: Site[];
  zones: Zone[];
  siteId: string;
  setSiteId: (s: string) => void;
  reloadSites: () => Promise<void>;
}
export const useAdmin = () => useOutletContext<AdminCtx>();

const NAV = [
  { to: "/admin", label: "ダッシュボード", end: true },
  { to: "/admin/analytics", label: "分析・ヒートマップ" },
  { to: "/admin/records", label: "記録・レポート" },
  { to: "/admin/equipment", label: "設備カルテ" },
  { to: "/admin/tags", label: "NFCタグ" },
  { to: "/admin/workflows", label: "巡回・作業手順" },
  { to: "/admin/users", label: "作業員・資格" },
  { to: "/admin/devices", label: "IoTデバイス" },
  { to: "/admin/sites", label: "現場・ゾーン" },
  { to: "/admin/account", label: "契約・サポート" }
];

export default function AdminLayout() {
  const { me, logout } = useAuth();
  const { data, reload } = useApi<{ sites: Site[]; zones: Zone[] }>("/admin/sites");
  const [siteId, setSiteIdState] = useState<string>(() => {
    try {
      return localStorage.getItem("it:site") ?? "";
    } catch {
      return "";
    }
  });
  const [menu, setMenu] = useState(false);
  const setSiteId = (s: string) => {
    setSiteIdState(s);
    try {
      localStorage.setItem("it:site", s);
    } catch {
      /* noop */
    }
  };
  useEffect(() => {
    if (data?.sites.length && !data.sites.some((s) => s.id === siteId)) setSiteId(data.sites[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const ctx: AdminCtx = { sites: data?.sites ?? [], zones: data?.zones ?? [], siteId, setSiteId, reloadSites: reload };

  return (
    <div className="min-h-screen lg:flex">
      <aside className={cx("bg-slate-900 text-slate-200 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-60 lg:shrink-0", menu ? "block" : "hidden")}>
        <div className="hidden items-center gap-2 px-5 py-5 lg:flex">
          <img src="/icon.svg" className="h-8 w-8" alt="" />
          <div className="font-bold text-white">Intent-Trace</div>
        </div>
        <nav className="space-y-0.5 px-3 pb-4">
          {NAV.filter((n) => n.to !== "/admin/devices" || me?.features.includes("devices")).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setMenu(false)}
              className={({ isActive }) => cx("block rounded-lg px-3 py-2 text-sm font-medium", isActive ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white")}
            >
              {n.label}
            </NavLink>
          ))}
          <Link to="/" className="mt-4 block rounded-lg px-3 py-2 text-sm text-amber-400 hover:bg-white/5">
            現場アプリを開く →
          </Link>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:px-8">
          <button className="rounded-lg px-2 py-1 text-xl lg:hidden" onClick={() => setMenu(!menu)} aria-label="メニュー">
            ☰
          </button>
          <div className="w-56 max-w-[50vw]">
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="py-1.5 text-sm">
              {ctx.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-slate-500 sm:inline">
              {me?.orgName} ・ {me?.name}
              {me?.plan === "pro" && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800">PRO</span>}
            </span>
            <button onClick={() => void logout()} className="text-slate-500 hover:text-slate-900">
              ログアウト
            </button>
          </div>
        </header>
        {me?.impersonatedBy && (
          <div className="bg-indigo-700 px-4 py-2 text-center text-sm font-semibold text-white">運営サポートが代理ログイン中です（操作はすべて監査ログに記録されます）</div>
        )}
        {me?.orgStatus === "trial" && me.trialEndsAt && (
          <Link to="/admin/account" className="block bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
            トライアル期間中（残り {Math.max(0, Math.ceil((me.trialEndsAt - Date.now()) / 86400000))} 日）— ご契約内容の確認はこちら
          </Link>
        )}
        <Announcements />
        <TermsGate />
        <main className="mx-auto max-w-7xl p-4 lg:p-8">{siteId ? <Outlet context={ctx} /> : null}</main>
      </div>
    </div>
  );
}

function Announcements() {
  const { data } = useApi<{ id: string; title: string; body: string; level: string }[]>("/account/announcements");
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("it:ann-hidden") ?? "[]");
    } catch {
      return [];
    }
  });
  const shown = (data ?? []).filter((a) => !hidden.includes(a.id)).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="space-y-1 px-4 pt-3 lg:px-8">
      {shown.map((a) => (
        <div key={a.id} className={cx("flex items-start justify-between gap-3 rounded-xl px-4 py-2 text-sm ring-1", a.level === "important" ? "bg-red-50 ring-red-200" : a.level === "maintenance" ? "bg-amber-50 ring-amber-200" : "bg-sky-50 ring-sky-200")}>
          <div>
            <b>{a.level === "maintenance" ? "【メンテナンス】" : a.level === "important" ? "【重要】" : "【お知らせ】"}{a.title}</b>
            <div className="whitespace-pre-wrap text-slate-600">{a.body}</div>
          </div>
          <button
            className="text-slate-400"
            onClick={() => {
              const n = [...hidden, a.id];
              setHidden(n);
              try {
                localStorage.setItem("it:ann-hidden", JSON.stringify(n));
              } catch {
                /* noop */
              }
            }}
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** 管理者が現行の利用規約に同意するまで操作をブロックする（マネージャーには案内のみ） */
function TermsGate() {
  const { me, refresh } = useAuth();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me || me.termsAccepted || me.impersonatedBy) return null;
  if (me.role !== "admin")
    return <div className="bg-slate-100 px-4 py-2 text-center text-sm text-slate-700">管理者による利用規約への同意が完了していません。管理者にご確認ください。</div>;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-xl font-bold">利用規約への同意のお願い</h2>
        <p className="text-sm text-slate-600">
          Intent-Trace をご利用いただくには、貴社を代表して管理者の方に
          <a href="/lp/terms" target="_blank" rel="noreferrer" className="mx-1 text-indigo-700 underline">利用規約</a>
          と
          <a href="/lp/privacy" target="_blank" rel="noreferrer" className="mx-1 text-indigo-700 underline">プライバシーポリシー</a>
          へご同意いただく必要があります（版: {TERMS_VERSION}）。
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{me.orgName} を代表して、利用規約およびプライバシーポリシーに同意します</span>
        </label>
        {err && <Alert>{err}</Alert>}
        <Button
          className="w-full"
          disabled={!agree || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await post("/account/terms/accept", { version: TERMS_VERSION });
              await refresh();
            } catch (e) {
              setErr(e instanceof ApiError ? e.message : "通信できませんでした");
            } finally {
              setBusy(false);
            }
          }}
        >
          同意して利用を開始する
        </Button>
      </div>
    </div>
  );
}
