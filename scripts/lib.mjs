// API クライアント（Node 22 の fetch + 簡易 Cookie 管理）
export function client(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function req(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar.size ? { cookie: cookieHeader() } : {}), origin: base, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (!v || /max-age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  const must = async (method, path, body, headers) => {
    const r = await req(method, path, body, headers);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  return { req, must, get: (p) => must("GET", p), post: (p, b) => must("POST", p, b ?? {}), clearCookie: () => jar.clear(), cookie: cookieHeader };
}
