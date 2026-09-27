// オフライン送信キュー（IndexedDB）
// 地下室・電波の届かない機械室でも「タッチした事実」を端末内に確保し、復帰後に順番どおり送信する。
import { api, ApiError, uploadFile } from "./api";

export type QueueKind = "tap" | "inspection" | "incident";

export interface QueueItem {
  id: string; // clientEventId
  kind: QueueKind;
  payload: Record<string, unknown>;
  photos?: { blob: Blob; name: string }[];
  createdAt: number;
  attempts: number;
  error?: string;
  errorCode?: string | null;
  failed?: boolean;
  /** 拒否された記録を管理者向けにサーバーへ預けた時刻 */
  reportedAt?: number;
}

const DB_NAME = "intent-trace";
const STORE = "queue";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("createdAt", "createdAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function enqueue(item: Omit<QueueItem, "createdAt" | "attempts">) {
  await tx("readwrite", (s) => s.put({ ...item, createdAt: Date.now(), attempts: 0 }));
  notify();
}

export async function listQueue(): Promise<QueueItem[]> {
  const all = await tx<QueueItem[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeItem(id: string) {
  await tx("readwrite", (s) => s.delete(id));
  notify();
}

async function update(item: QueueItem) {
  await tx("readwrite", (s) => s.put(item));
}

const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify() {
  listeners.forEach((f) => f());
}

const ENDPOINT: Record<QueueKind, string> = { tap: "/tap", inspection: "/inspections", incident: "/incidents" };

let syncing = false;

/** キューを古い順に送信。ネットワークエラーで中断、4xx は失敗として保持（利用者に見せる） */
export async function syncQueue(): Promise<{ sent: number; remaining: number }> {
  if (syncing || !navigator.onLine) return { sent: 0, remaining: (await listQueue()).length };
  syncing = true;
  let sent = 0;
  try {
    for (const item of await listQueue()) {
      if (item.failed) {
        if (!item.reportedAt) await reportRejected(item);
        continue;
      }
      try {
        const payload = { ...item.payload };
        if (item.photos?.length) {
          const keys: string[] = (payload.photoKeys as string[]) ?? [];
          for (const p of item.photos) {
            const up = await uploadFile(p.blob, p.name, { kind: "photo", equipmentId: payload.equipmentId as string | undefined });
            keys.push(up.id);
          }
          payload.photoKeys = keys;
          // アップロード済み写真は二重送信しないよう保存し直す
          await update({ ...item, payload, photos: [] });
        }
        await api(ENDPOINT[item.kind], { method: "POST", json: { ...payload, offline: item.kind === "tap" ? true : undefined } });
        await removeItem(item.id);
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
          const failedItem = { ...item, attempts: item.attempts + 1, failed: true, error: e.message, errorCode: e.code };
          await update(failedItem);
          await reportRejected(failedItem);
          notify();
          continue;
        }
        await update({ ...item, attempts: item.attempts + 1, error: e instanceof Error ? e.message : String(e) });
        break; // ネットワーク断: 次回に持ち越し
      }
    }
  } finally {
    syncing = false;
    notify();
  }
  return { sent, remaining: (await listQueue()).length };
}

/** 拒否された記録を管理者が確認できるようサーバーへ預ける（写真は件数のみ）。失敗しても次回の同期で再試行 */
async function reportRejected(item: QueueItem) {
  try {
    const { photoKeys: _pk, ...payload } = item.payload as Record<string, unknown> & { photoKeys?: unknown };
    await api("/rejected", {
      method: "POST",
      json: {
        clientId: item.id,
        kind: item.kind,
        payload,
        photoCount: (item.photos?.length ?? 0) + (Array.isArray(_pk) ? _pk.length : 0),
        error: item.error ?? "不明なエラー",
        errorCode: item.errorCode ?? null,
        occurredAt: typeof item.payload.occurredAt === "number" ? item.payload.occurredAt : item.createdAt
      }
    });
    await update({ ...item, reportedAt: Date.now() });
  } catch {
    /* 通信できなければ次回 */
  }
}

/** 送信できなかった記録をもう一度送る（資格の更新・設定変更の後など） */
export async function retryItem(id: string) {
  const item = (await listQueue()).find((q) => q.id === id);
  if (!item) return;
  await update({ ...item, failed: false, error: undefined, errorCode: undefined });
  notify();
  await syncQueue();
}

export function startAutoSync() {
  window.addEventListener("online", () => void syncQueue());
  setInterval(() => void syncQueue(), 30_000);
  void syncQueue();
}
