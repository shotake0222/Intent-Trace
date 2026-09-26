// API クライアント（Node 22 の fetch + 簡易 Cookie 管理）
export function client(base) {
  let cookie = "";
  async function req(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), origin: base, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith("it_session=")) cookie = c.split(";")[0];
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  const must = async (method, path, body, headers) => {
    const r = await req(method, path, body, headers);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { req, must, get: (p) => must("GET", p), post: (p, b) => must("POST", p, b ?? {}), clearCookie: () => (cookie = "") };
}
