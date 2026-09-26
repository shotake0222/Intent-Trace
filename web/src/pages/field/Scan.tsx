import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { parseTagUrl, scanOnce, webNfcSupported } from "../../lib/nfc";
import { Alert, Button } from "../../components/ui";

/** Android Chrome: アプリ内で NFC を読み取り、物理UID付きでタッチを記録（証明レベル「中」以上） */
export default function Scan() {
  const nav = useNavigate();
  const [state, setState] = useState<"idle" | "scanning" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  async function start() {
    setErr(null);
    setState("scanning");
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    try {
      const r = await scanOnce(ctrl.current.signal);
      const parsed = r.url ? parseTagUrl(r.url) : null;
      if (!parsed) throw new Error("Intent-Trace のタグではありません");
      const q = parsed.sun ? `?picc=${parsed.sun.picc}&cmac=${parsed.sun.cmac}` : "";
      nav(`/t/${parsed.tagId}${q}`, { state: { serial: r.serial } });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setErr((e as Error).message);
      setState("error");
    }
  }

  useEffect(() => () => ctrl.current?.abort(), []);

  if (!webNfcSupported)
    return <Alert tone="amber">この端末のブラウザはアプリ内NFC読み取りに対応していません。スマホをタグに直接かざしてください（iPhone は通知から開きます）。</Alert>;

  return (
    <div className="space-y-6 pt-6 text-center">
      <div className="relative mx-auto grid h-48 w-48 place-items-center">
        {state === "scanning" && <div className="pulse-ring absolute inset-0 rounded-full border-4 border-amber-400" />}
        <div className="grid h-36 w-36 place-items-center rounded-full bg-slate-900 text-5xl text-amber-400">◎</div>
      </div>
      <div className="text-lg font-bold">{state === "scanning" ? "タグにスマホの背面をかざしてください" : "NFCスキャン"}</div>
      {err && <Alert>{err}</Alert>}
      {state !== "scanning" && (
        <Button variant="accent" size="lg" className="w-full" onClick={start}>
          スキャン開始
        </Button>
      )}
    </div>
  );
}
