import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ApiError, get, post } from "../../lib/api";
import { Alert, Button, Field, Input, Spinner, cx } from "../../components/ui";
import { MfaCard } from "./OpsSecurity";

export interface OpsMe {
  id: string;
  name: string;
  email: string;
  role: "owner" | "staff";
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  mfaSetupRequired: boolean;
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
  { to: "/ops/notifications", label: "通知履歴" },
  { to: "/ops/settings", label: "設定・通知・セキュリティ" },
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
            {me.mfaSetupRequired ? (
              <div className="mx-auto max-w-xl space-y-4">
                <Alert tone="amber">運営コンソールでは二段階認証が必須に設定されています。設定を完了すると各機能を利用できます。</Alert>
                <MfaCard onChanged={() => void load()} />
              </div>
            ) : (
              <Outlet />
            )}
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
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mode, setMode] = useState<"login" | "forgot" | "sent">("login");
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
      if (initialized) {
        const r = await post<{ ok?: boolean; mfaRequired?: boolean; mfaToken?: string }>("/ops/login", { email: f.email, password: f.password });
        if (r.mfaRequired && r.mfaToken) {
          setMfaToken(r.mfaToken);
          return;
        }
      } else await post("/ops/bootstrap", { setupToken: f.setupToken.trim(), name: f.name, email: f.email, password: f.password });
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
        ) : mfaToken ? (
          <MfaStep mfaToken={mfaToken} onDone={() => nav(next, { replace: true })} onExpired={() => (setMfaToken(null), setErr("有効期限が切れました。もう一度ログインしてください"))} />
        ) : mode !== "login" ? (
          <div className="space-y-4 rounded-2xl bg-white p-5 text-slate-900">
            {mode === "sent" ? (
              <Alert tone="green">登録されているアドレスであれば、再設定用のリンクを送信しました。メールをご確認ください（有効期限1時間）。</Alert>
            ) : (
              <>
                <Field label="登録メールアドレス">
                  <Input type="email" value={f.email} onChange={set("email")} />
                </Field>
                <Button className="w-full !bg-indigo-700" disabled={!f.email} onClick={async () => (await post("/ops/forgot", { email: f.email }).catch(() => {}), setMode("sent"))}>
                  再設定リンクを送る
                </Button>
              </>
            )}
            <button className="text-sm text-indigo-700" onClick={() => setMode("login")}>
              ‹ ログインに戻る
            </button>
          </div>
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
            {initialized && (
              <button type="button" className="text-sm text-indigo-700" onClick={() => setMode("forgot")}>
                パスワードを忘れた方
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

function MfaStep({ mfaToken, onDone, onExpired }: { mfaToken: string; onDone: () => void; onExpired: () => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post("/ops/login/mfa", recovery ? { mfaToken, recoveryCode: code } : { mfaToken, code });
      onDone();
    } catch (x) {
      if (x instanceof ApiError && x.code === "mfa_expired") onExpired();
      else setErr(x instanceof ApiError ? x.message : "通信エラー");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-5 text-slate-900">
      <div className="font-bold">二段階認証</div>
      <p className="text-sm text-slate-600">{recovery ? "保管しているリカバリーコード（XXXX-XXXX）を入力してください。各コードは1回だけ使えます。" : "認証アプリ（Google Authenticator など）に表示されている6桁のコードを入力してください。"}</p>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode={recovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoFocus
        maxLength={recovery ? 9 : 6}
        className="text-center font-mono text-2xl tracking-[.3em]"
        placeholder={recovery ? "XXXX-XXXX" : "000000"}
      />
      {err && <Alert>{err}</Alert>}
      <Button type="submit" size="lg" className="w-full !bg-indigo-700" disabled={busy || code.replace(/[\s-]/g, "").length < (recovery ? 8 : 6)}>
        {busy ? "確認中…" : "確認"}
      </Button>
      <button type="button" className="text-sm text-indigo-700" onClick={() => (setRecovery(!recovery), setCode(""))}>
        {recovery ? "認証アプリのコードを使う" : "認証アプリが使えない場合（リカバリーコード）"}
      </button>
    </form>
  );
}

/** メールのリンクから開くパスワード再設定（運営・テナント共通） */
export function ResetPassword({ kind }: { kind: "ops" | "user" }) {
  const nav = useNavigate();
  const token = new URLSearchParams(useLocation().search).get("token") ?? "";
  const [pw, setPw] = useState({ a: "", b: "" });
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const min = kind === "ops" ? 10 : 8;
  return (
    <div className={cx("min-h-screen px-4 py-12 text-white", kind === "ops" ? "bg-indigo-950" : "bg-slate-900")}>
      <div className="mx-auto max-w-sm">
        <div className="mb-8 text-2xl font-bold">パスワードの再設定</div>
        <div className="space-y-4 rounded-2xl bg-white p-5 text-slate-900">
          {done ? (
            <>
              <Alert tone="green">パスワードを変更しました。新しいパスワードでログインしてください。</Alert>
              <Button className="w-full" onClick={() => nav(kind === "ops" ? "/ops/login" : "/login?next=/admin")}>
                ログイン画面へ
              </Button>
            </>
          ) : (
            <>
              <Field label={`新しいパスワード（${min}文字以上）`}>
                <Input type="password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="新しいパスワード（確認）">
                <Input type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} autoComplete="new-password" />
              </Field>
              {err && <Alert>{err}</Alert>}
              <Button
                className="w-full"
                disabled={pw.a.length < min || pw.a !== pw.b || !token}
                onClick={async () => {
                  try {
                    await post(kind === "ops" ? "/ops/reset" : "/auth/reset", { token, password: pw.a });
                    setDone(true);
                  } catch (x) {
                    setErr(x instanceof ApiError ? x.message : "通信エラー");
                  }
                }}
              >
                変更する
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
