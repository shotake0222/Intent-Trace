import { Component, type ErrorInfo, type ReactNode } from "react";

/** 画面の予期しないエラー: 真っ白にせず案内を出し、運営へ自動で報告する */
export function reportClientError(message: string, stack?: string | null, componentStack?: string | null) {
  try {
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({ message: message.slice(0, 500), stack: stack?.slice(0, 3000), componentStack: componentStack?.slice(0, 2000), path: location.pathname })
    }).catch(() => {});
  } catch {
    /* noop */
  }
}

// デプロイ直後に古い画面が新しいファイルを読めない場合は、1回だけ自動で再読み込みする
const isChunkError = (m: string) => /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically imported module/i.test(m);
function reloadOnceForChunk(m: string) {
  if (!isChunkError(m)) return false;
  try {
    const k = "it:chunk-reload";
    const last = Number(sessionStorage.getItem(k) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(k, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

export function installGlobalErrorReporting() {
  window.addEventListener("error", (e) => {
    const m = e.message || String(e.error ?? "");
    if (reloadOnceForChunk(m)) return;
    if (!m || m === "Script error.") return;
    reportClientError(m, e.error instanceof Error ? e.error.stack : null);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // 通信エラー・API のエラー応答は各画面で表示済みのため報告しない
    if (r && typeof r === "object" && ("status" in r || r instanceof TypeError)) return;
    const m = r instanceof Error ? r.message : String(r);
    if (reloadOnceForChunk(m)) return;
    reportClientError(`unhandledrejection: ${m}`, r instanceof Error ? r.stack : null);
  });
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (reloadOnceForChunk(error.message)) return;
    reportClientError(error.message, error.stack, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const home = location.pathname.startsWith("/ops") ? "/ops" : location.pathname.startsWith("/admin") ? "/admin" : "/";
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 p-6">
        <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 text-center shadow-lg">
          <div className="text-4xl">⚠</div>
          <h1 className="text-xl font-bold text-slate-900">画面の表示中にエラーが発生しました</h1>
          <p className="text-sm text-slate-600">
            この内容は運営に自動で報告されました。お手数ですが再読み込みしてください。
            <br />
            端末に保存済みの未送信の記録は失われません（入力途中の内容は消える場合があります）。
          </p>
          <div className="flex flex-col gap-2">
            <button className="rounded-xl bg-slate-900 py-3 font-bold text-white" onClick={() => location.reload()}>
              再読み込み
            </button>
            <a className="rounded-xl border border-slate-300 py-3 font-semibold text-slate-700" href={home}>
              トップへ戻る
            </a>
          </div>
          <p className="break-all text-left text-[11px] text-slate-400">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}
