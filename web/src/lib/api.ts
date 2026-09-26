export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null
  ) {
    super(message);
  }
}

export function isNetworkError(e: unknown) {
  return e instanceof TypeError || (e instanceof ApiError && e.status === 0);
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let bodyInit = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    bodyInit = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body: bodyInit, credentials: "same-origin" });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const d = data as { error?: string; code?: string };
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("it:unauthorized"));
    throw new ApiError(res.status, d?.error ?? `エラー (${res.status})`, d?.code ?? null);
  }
  return data as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, json?: unknown) => api<T>(p, { method: "POST", json: json ?? {} });
export const patch = <T,>(p: string, json: unknown) => api<T>(p, { method: "PATCH", json });
export const put = <T,>(p: string, json: unknown) => api<T>(p, { method: "PUT", json });
export const del = <T,>(p: string) => api<T>(p, { method: "DELETE" });

export async function uploadFile(file: Blob, filename: string, opts: { kind: "photo" | "manual"; equipmentId?: string }) {
  const q = new URLSearchParams({ kind: opts.kind });
  if (opts.equipmentId) q.set("equipmentId", opts.equipmentId);
  return api<{ id: string; filename: string }>(`/files?${q}`, {
    method: "POST",
    body: file,
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(filename) }
  });
}

export function uuid() {
  return crypto.randomUUID();
}
