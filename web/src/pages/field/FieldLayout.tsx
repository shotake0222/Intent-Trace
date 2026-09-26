import { NavLink, Outlet, Link } from "react-router";
import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { useInterval, useNow, useOnline, useQueue } from "../../lib/hooks";
import { get } from "../../lib/api";
import { syncQueue } from "../../lib/offline";
import { cx } from "../../components/ui";
import { webNfcSupported } from "../../lib/nfc";

interface DeadmanState {
  sessionId: string;
  deadlineAt: number;
  phase: string;
}

export default function FieldLayout() {
  const { me, logout } = useAuth();
  const online = useOnline();
  const queue = useQueue();
  const pending = queue.filter((q) => !q.failed).length;
  const failed = queue.filter((q) => q.failed).length;
  const [dm, setDm] = useState<DeadmanState | null>(null);
  const now = useNow(1000);

  const loadDm = () =>
    void get<DeadmanState | null>("/deadman/current")
      .then(setDm)
      .catch(() => {});
  useEffect(loadDm, []);
  useInterval(loadDm, 20_000);
  useEffect(() => {
    const h = () => loadDm();
    window.addEventListener("it:deadman", h);
    return () => window.removeEventListener("it:deadman", h);
  }, []);

  const remaining = dm ? Math.round((dm.deadlineAt - now) / 1000) : null;
  useEffect(() => {
    if (remaining !== null && (remaining === 60 || remaining === 0) && "vibrate" in navigator) navigator.vibrate([300, 150, 300]);
  }, [remaining]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 bg-slate-900 px-4 pt-[max(.75rem,env(safe-area-inset-top))] pb-3 text-white">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2">
            <img src="/icon.svg" className="h-8 w-8" alt="" />
            <div className="leading-tight">
              <div className="text-sm font-bold">{me?.name}</div>
              <div className="text-xs text-slate-400">{me?.orgName}</div>
            </div>
          </Link>
          <div className="flex items-center gap-2 text-xs">
            {(pending > 0 || failed > 0) && (
              <button onClick={() => void syncQueue()} className={cx("rounded-full px-2.5 py-1 font-semibold", failed ? "bg-red-500" : "bg-amber-500 text-slate-900")}>
                未送信 {pending + failed}
              </button>
            )}
            <span className={cx("flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold", online ? "bg-emerald-600/30 text-emerald-300" : "bg-red-600/40 text-red-200")}>
              <span className={cx("h-2 w-2 rounded-full", online ? "bg-emerald-400" : "bg-red-400")} />
              {online ? "オンライン" : "オフライン"}
            </span>
            {me?.role !== "worker" && (
              <Link to="/admin" className="rounded-full bg-slate-700 px-2.5 py-1 font-semibold">
                管理
              </Link>
            )}
            <button onClick={() => void logout()} className="text-slate-400">
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {dm && remaining !== null && (
        <Link
          to="/deadman"
          className={cx(
            "sticky top-[60px] z-10 block px-4 py-2 text-center text-sm font-bold",
            remaining <= 0 ? "animate-pulse bg-red-600 text-white" : remaining <= 120 ? "bg-amber-400 text-slate-900" : "bg-slate-800 text-slate-100"
          )}
        >
          {remaining <= 0 ? "⚠ 生存確認の期限を過ぎています。すぐにタグへタッチしてください" : `生存確認 残り ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
        </Link>
      )}

      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-4 pb-28">
        <Outlet />
      </main>

      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto grid max-w-xl grid-cols-4 pt-2 text-xs font-semibold">
          {[
            { to: "/", label: "ホーム", icon: "⌂" },
            webNfcSupported ? { to: "/scan", label: "スキャン", icon: "◎" } : { to: "/patrol", label: "巡回", icon: "⇢" },
            { to: "/report", label: "ヒヤリハット", icon: "!" },
            { to: "/history", label: "履歴", icon: "≡" }
          ].map((n) => (
            <NavLink key={n.to} to={n.to} end className={({ isActive }) => cx("flex flex-col items-center gap-0.5 py-1", isActive ? "text-slate-900" : "text-slate-400")}>
              <span className="text-xl leading-none">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
