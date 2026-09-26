// NFC 関連（Web NFC は Android Chrome のみ。iPhone はタグの URL から PWA を開く方式）
import type { TapRequest, TapResponse } from "../../../shared/types";
import { post, isNetworkError, uuid } from "./api";
import { enqueue } from "./offline";

interface NDEFRecordLike {
  recordType: string;
  data?: DataView;
}
interface NDEFReadingEventLike extends Event {
  serialNumber: string;
  message: { records: NDEFRecordLike[] };
}
interface NDEFReaderLike extends EventTarget {
  scan(opts?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: { recordType: string; data: string }[] } | string, opts?: { signal?: AbortSignal }): Promise<void>;
}

export const webNfcSupported = typeof window !== "undefined" && "NDEFReader" in window;

function reader(): NDEFReaderLike {
  const Ctor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
  return new Ctor();
}

/** タグ URL から tagId と SUN パラメータを取り出す */
export function parseTagUrl(url: string): { tagId: string; sun?: { picc: string; cmac: string } } | null {
  try {
    const u = new URL(url);
    const m = /^\/t\/([A-Za-z0-9]+)/.exec(u.pathname);
    if (!m) return null;
    const picc = u.searchParams.get("picc");
    const cmac = u.searchParams.get("cmac");
    return { tagId: m[1], sun: picc && cmac ? { picc, cmac } : undefined };
  } catch {
    return null;
  }
}

/** Android: アプリ内で連続スキャン（物理UIDも取得でき、証明レベル「中」以上になる） */
export async function scanOnce(signal: AbortSignal): Promise<{ url: string | null; serial: string }> {
  const r = reader();
  await r.scan({ signal });
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    r.addEventListener(
      "reading",
      (ev) => {
        const e = ev as NDEFReadingEventLike;
        let url: string | null = null;
        for (const rec of e.message.records) {
          if (rec.recordType === "url" && rec.data) url = new TextDecoder().decode(rec.data);
        }
        resolve({ url, serial: e.serialNumber });
      },
      { once: true }
    );
    r.addEventListener("readingerror", () => reject(new Error("タグを読み取れませんでした。もう一度かざしてください")), { once: true });
  });
}

/** 管理者: Android からタグへ URL を書き込む */
export async function writeUrl(url: string, signal?: AbortSignal) {
  await reader().write({ records: [{ recordType: "url", data: url }] }, { signal });
}

export type TapOutcome = { queued: false; res: TapResponse; clientEventId: string } | { queued: true; clientEventId: string };

/** タップを記録。オフラインなら端末に保存して後で送信 */
export async function recordTap(input: Omit<TapRequest, "clientEventId" | "occurredAt">): Promise<TapOutcome> {
  const req: TapRequest = { ...input, clientEventId: uuid(), occurredAt: Date.now() };
  if (!navigator.onLine) {
    await enqueue({ id: req.clientEventId, kind: "tap", payload: { ...req } });
    return { queued: true, clientEventId: req.clientEventId };
  }
  try {
    return { queued: false, res: await post<TapResponse>("/tap", req), clientEventId: req.clientEventId };
  } catch (e) {
    if (isNetworkError(e)) {
      await enqueue({ id: req.clientEventId, kind: "tap", payload: { ...req } });
      return { queued: true, clientEventId: req.clientEventId };
    }
    throw e;
  }
}
