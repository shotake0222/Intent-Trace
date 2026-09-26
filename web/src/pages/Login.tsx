import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Navigate } from "react-router";
import { post, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Alert, Button, Field, Input, cx } from "../components/ui";

const ORG_KEY = "it:orgCode";

export default function Login() {
  const [params] = useSearchParams();
  const next = params.get("next");
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"worker" | "admin">(next?.startsWith("/admin") ? "admin" : "worker");
  const [orgCode, setOrgCode] = useState(() => {
    try {
      return localStorage.getItem(ORG_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [employeeCode, setEmployeeCode] = useState("");
  const [pin, setPin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={next ?? (me.role === "worker" ? "/" : "/admin")} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "worker") {
        await post("/auth/worker-login", { orgCode: orgCode.trim(), employeeCode: employeeCode.trim(), pin });
        try {
          localStorage.setItem(ORG_KEY, orgCode.trim().toUpperCase());
        } catch {
          /* noop */
        }
      } else {
        await post("/auth/login", { email: email.trim(), password });
      }
      await refresh();
      nav(next ?? (mode === "worker" ? "/" : "/admin"), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "通信できません。電波の良い場所で再度お試しください");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 px-4 py-10 text-white">
      <div className="mx-auto max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <div>
            <div className="text-2xl font-bold tracking-tight">Intent-Trace</div>
            <div className="text-sm text-slate-400">空間・設備・安全の統合マネジメント</div>
          </div>
        </div>
        <div className="mb-4 grid grid-cols-2 rounded-xl bg-slate-800 p-1 text-sm font-semibold">
          {(["worker", "admin"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cx("rounded-lg py-2", mode === m ? "bg-white text-slate-900" : "text-slate-300")}>
              {m === "worker" ? "作業員" : "管理者"}
            </button>
          ))}
        </div>
        {next?.startsWith("/t/") && (
          <div className="mb-4">
            <Alert tone="amber">ログインするとタッチが記録されます</Alert>
          </div>
        )}
        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-5 text-slate-900">
          {mode === "worker" ? (
            <>
              <Field label="会社コード">
                <Input value={orgCode} onChange={(e) => setOrgCode(e.target.value)} autoCapitalize="characters" required />
              </Field>
              <Field label="社員番号">
                <Input value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} inputMode="text" autoComplete="username" required />
              </Field>
              <Field label="PIN">
                <Input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" autoComplete="current-password" minLength={4} required />
              </Field>
            </>
          ) : (
            <>
              <Field label="メールアドレス">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
              </Field>
              <Field label="パスワード">
                <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
              </Field>
            </>
          )}
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? "確認中…" : "ログイン"}
          </Button>
        </form>
      </div>
    </div>
  );
}
