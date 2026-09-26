// R2 ファイル（マニュアルPDF・点検写真）
import { createRouter, fail, newId, now } from "../lib/app";
import { requireAuth } from "../lib/auth";

const r = createRouter();
r.use("*", requireAuth);

const MAX_SIZE = 50 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|video\/mp4|text\/plain)$/;

/**
 * アップロード: 生バイナリを PUT 相当で POST。メタ情報はクエリ/ヘッダで渡す。
 *   POST /api/files?kind=photo&equipmentId=...  (Content-Type: image/jpeg, X-Filename: xxx.jpg)
 * 作業員は写真のみ、マニュアル登録は管理者のみ。
 */
r.post("/", async (c) => {
  const u = c.get("user");
  const kind = c.req.query("kind") ?? "photo";
  if (!["photo", "manual", "report"].includes(kind)) fail(400, "kind が不正です");
  if (kind !== "photo" && u.role === "worker") fail(403, "マニュアルの登録は管理者のみ可能です");
  const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim();
  if (!ALLOWED.test(contentType)) fail(400, `未対応のファイル形式です: ${contentType}`);
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_SIZE) fail(400, "ファイルサイズが大きすぎます（上限50MB）");
  const filename = decodeURIComponent(c.req.header("x-filename") ?? "file").replace(/[\\/]/g, "_").slice(0, 200);
  const equipmentId = c.req.query("equipmentId") ?? null;
  if (equipmentId) {
    const e = await c.env.DB.prepare("SELECT id FROM equipment WHERE id = ? AND org_id = ?").bind(equipmentId, u.orgId).first();
    if (!e) fail(404, "設備が見つかりません");
  }
  const id = newId();
  const key = `org/${u.orgId}/${kind}/${id}`;
  const obj = await c.env.FILES.put(key, c.req.raw.body, {
    httpMetadata: { contentType, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}` },
    customMetadata: { orgId: u.orgId, uploadedBy: u.id }
  });
  if (!obj) fail(500, "保存に失敗しました");
  if (obj.size > MAX_SIZE) {
    await c.env.FILES.delete(key);
    fail(400, "ファイルサイズが大きすぎます（上限50MB）");
  }
  await c.env.DB.prepare(
    "INSERT INTO documents (id, org_id, equipment_id, kind, r2_key, filename, content_type, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(id, u.orgId, equipmentId, kind, key, filename, contentType, obj.size, u.id, now())
    .run();
  return c.json({ id, key: id, filename, size: obj.size });
});

r.get("/:id", async (c) => {
  const u = c.get("user");
  const d = await c.env.DB.prepare("SELECT r2_key, content_type, filename FROM documents WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), u.orgId)
    .first<{ r2_key: string; content_type: string; filename: string }>();
  if (!d) fail(404, "ファイルが見つかりません");
  const obj = await c.env.FILES.get(d.r2_key, { range: c.req.raw.headers });
  if (!obj) fail(404, "ファイルが見つかりません");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=86400");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");
  const range = (obj as R2ObjectBody & { range?: { offset: number; length?: number } }).range;
  if (range && c.req.header("range")) {
    const end = range.offset + (range.length ?? obj.size - range.offset) - 1;
    headers.set("content-range", `bytes ${range.offset}-${end}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
});

r.delete("/:id", async (c) => {
  const u = c.get("user");
  if (u.role === "worker") fail(403, "権限がありません");
  const d = await c.env.DB.prepare("SELECT r2_key FROM documents WHERE id = ? AND org_id = ?").bind(c.req.param("id"), u.orgId).first<{ r2_key: string }>();
  if (!d) fail(404, "ファイルが見つかりません");
  await c.env.FILES.delete(d.r2_key);
  await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

export default r;
