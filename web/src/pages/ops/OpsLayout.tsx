import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ApiError, get, post } from "../../lib/api";
import { Alert, Button, Field, Input, Spinner, cx } from "../../components/ui";

export interface OpsMe {
  id: string;
  name: string;
  email: string;
  role: "owner" | "staff";
}
const Ctx = createContext<{ me: OpsMe; reload: () => void }>(null!);
export const useOps = () => useContext(Ctx);

const NAV = [
  { to: "/ops", label: "ダッシュボード", end: true },
  { to: "/ops/tenants", label: "テナント（契約企業）" },
  { to: "/ops/stock", label: "NFCタグ在庫・出荷" },
  { to: "/ops/billing", label: "請求" },
  { to: "/ops/plans", label: "料金プラン" },
  { to: "/ops/announcements", label: "お知らせ配信" },
  { to: "/ops/support", label: "サポート" },
  { to: "/ops/settings", label: "設定・運営アカウント" },
  { to: "/ops/audit", label: "運営監査ログ" }
];

export default function OpsLayout() {
  const [me, setMe] = useState<OpsMe | null | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const load = () =>
    get<OpsMe>("/ops/me")
      .then(setMe)
      .catch(() => setMe(null));
  useEffect(() => {
    void load();
  }, []);
  if (me === undefined)
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  if (!me) return <Navigate to={`/ops/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return (
    <Ctx.Provider value={{ me, reload: load }}>
      <div className="min-h-screen lg:flex">
        <aside className={cx("bg-indigo-950 text-indigo-100 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-64 lg:shrink-0 lg:overflow-y-auto", menu ? "block" : "hidden")}>
          <div className="hidden px-5 py-5 lg:block">
            <div className="flex items-center gap-2">
              <img src="/icon.svg" className="h-8 w-8" alt="" />
              <div className="font-bold text-white">Intent-Trace</div>
            </div>
            <div className="mt-1 text-xs font-semibold tracking-widest text-indigo-300">運営コンソール</div>
          </div>
          <nav className="space-y-0.5 px-3 pb-6">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                onClick={() => setMenu(false)}
                className={({ isActive }) => cx("block rounded-lg px-3 py-2 text-sm font-medium", isActive ? "bg-white/15 text-white" : "text-indigo-300 hover:bg-white/5 hover:text-white")}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 bg-slate-50">
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:px-8">
            <button className="rounded-lg px-2 py-1 text-xl lg:hidden" onClick={() => setMenu(!menu)} aria-label="メニュー">
              ☰
            </button>
            <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-800">運営</span>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-slate-500">
                {me.name}（{me.role === "owner" ? "オーナー" : "スタッフ"}）
              </span>
              <button
                className="text-slate-500 hover:text-slate-900"
                onClick={async () => {
                  await post("/ops/logout");
                  nav("/ops/login");
                }}
              >
                ログアウト
              </button>
            </div>
          </header>
          <main className="mx-auto max-w-7xl p-4 lg:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

/** 運営ログイン／初回セットアップ */
export function OpsLogin() {
  const nav = useNavigate();
  const loc = useLocation();
  const next = new URLSearchParams(loc.search).get("next") ?? "/ops";
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [f, setF] = useState({ setupToken: "", name: "", email: "", password: "", password2: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void get<{ initialized: boolean }>("/ops/status").then((s) => setInitialized(s.initialized));
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!initialized && f.password !== f.password2) return setErr("確認用パスワードが一致しません");
    setBusy(true);
    try {
      if (initialized) await post("/ops/login", { email: f.email, password: f.password });
      else await post("/ops/bootstrap", { setupToken: f.setupToken.trim(), name: f.name, email: f.email, password: f.password });
      nav(next, { replace: true });
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "通信エラー");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-indigo-950 px-4 py-12 text-white">
      <div className="mx-auto max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" className="h-12 w-12" alt="" />
          <div>
            <div className="text-2xl font-bold">Intent-Trace</div>
            <div className="text-sm text-indigo-300">運営コンソール</div>
          </div>
        </div>
        {initialized === null ? (
          <Spinner />
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-5 text-slate-900">
            {!initialized && (
              <>
                <Alert tone="blue">初回セットアップです。デプロイ時に発行されたセットアップトークンで、最初の運営オーナーを作成します。</Alert>
                <Field label="セットアップトークン">
                  <Input value={f.setupToken} onChange={set("setupToken")} className="font-mono" required />
                </Field>
                <Field label="氏名">
                  <Input value={f.name} onChange={set("name")} required />
                </Field>
              </>
            )}
            <Field label="メールアドレス">
              <Input type="email" value={f.email} onChange={set("email")} autoComplete="username" required />
            </Field>
            <Field label={initialized ? "パスワード" : "パスワード（10文字以上）"}>
              <Input type="password" value={f.password} onChange={set("password")} autoComplete={initialized ? "current-password" : "new-password"} minLength={initialized ? 1 : 10} required />
            </Field>
            {!initialized && (
              <Field label="パスワード（確認）">
                <Input type="password" value={f.password2} onChange={set("password2")} autoComplete="new-password" required />
              </Field>
            )}
            {err && <Alert>{err}</Alert>}
            <Button type="submit" size="lg" className="w-full !bg-indigo-700 hover:!bg-indigo-600" disabled={busy}>
              {busy ? "処理中…" : initialized ? "ログイン" : "オーナーを作成してログイン"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
