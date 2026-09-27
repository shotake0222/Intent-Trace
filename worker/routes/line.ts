// LINE Messaging API webhook  /api/line/webhook
// 公式アカウントを友だち追加（またはグループに招待）し、管理画面で発行した6桁コードを送ると通知先として連携される
import { createRouter, newId, now, audit } from "../lib/app";
import { getNotifyConfig, verifyLineSignature, lineReply, type NotifyConfig } from "../lib/notify";

const r = createRouter();

interface LineEvent {
  type: string;
  replyToken?: string;
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: { type: string; text?: string };
}

async function lineGet<T>(cfg: NotifyConfig, path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/${path}`, { headers: { authorization: `Bearer ${cfg.lineToken}` }, signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const GUIDE = "Intent-Trace の通知用アカウントです。\n管理画面「契約・サポート」→「通知」で発行した6桁の連携コードを、このトークに送信してください。";

r.post("/webhook", async (c) => {
  const cfg = await getNotifyConfig(c.env);
  if (!cfg.lineSecret) return c.text("not configured", 404);
  const raw = await c.req.text();
  const sig = c.req.header("x-line-signature") ?? "";
  if (!(await verifyLineSignature(cfg.lineSecret, raw, sig))) return c.text("invalid signature", 401);
  let events: LineEvent[] = [];
  try {
    events = (JSON.parse(raw) as { events: LineEvent[] }).events ?? [];
  } catch {
    return c.text("bad request", 400);
  }
  for (const ev of events) {
    const src = ev.source;
    const lineId = src.groupId ?? src.roomId ?? src.userId;
    if (!lineId) continue;
    const reply = async (text: string) => {
      if (ev.replyToken && cfg.lineToken) await lineReply(cfg, ev.replyToken, text).catch((e) => console.error("line reply", e));
    };
    if (ev.type === "follow" || ev.type === "join") {
      await reply(GUIDE);
      continue;
    }
    if (ev.type === "unfollow" || ev.type === "leave") {
      await c.env.DB.prepare("UPDATE line_targets SET active = 0 WHERE line_id = ?").bind(lineId).run();
      continue;
    }
    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const m = /(?:^|\D)(\d{6})(?:\D|$)/.exec(ev.message.text ?? "");
    if (!m) {
      if (src.type === "user") await reply(GUIDE);
      continue;
    }
    const code = await c.env.DB.prepare("SELECT code, org_id, user_id, created_by, expires_at FROM line_link_codes WHERE code = ?")
      .bind(m[1])
      .first<{ code: string; org_id: string; user_id: string | null; created_by: string | null; expires_at: number }>();
    if (!code || code.expires_at < now()) {
      await reply("連携コードが見つからないか、有効期限（15分）が切れています。管理画面で新しいコードを発行してください。");
      continue;
    }
    const kind = src.type === "user" ? "user" : "group";
    let displayName: string | null = null;
    if (kind === "user" && src.userId) displayName = (await lineGet<{ displayName: string }>(cfg, `profile/${src.userId}`))?.displayName ?? null;
    else if (src.groupId) displayName = (await lineGet<{ groupName: string }>(cfg, `group/${src.groupId}/summary`))?.groupName ?? null;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO line_targets (id, org_id, user_id, line_id, kind, display_name, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(org_id, line_id) DO UPDATE SET active = 1, display_name = COALESCE(excluded.display_name, display_name), user_id = COALESCE(excluded.user_id, user_id)`
      ).bind(newId(), code.org_id, kind === "user" ? code.user_id : null, lineId, kind, displayName ?? (kind === "group" ? "LINEグループ" : "LINEユーザー"), now()),
      c.env.DB.prepare("DELETE FROM line_link_codes WHERE code = ?").bind(code.code)
    ]);
    const org = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(code.org_id).first<{ name: string }>();
    await audit(c.env, code.org_id, code.created_by, "line.link", "line_target", lineId.slice(0, 8), { kind, displayName });
    await reply(`✅ ${org?.name ?? ""} の Intent-Trace 通知と連携しました。\n${kind === "group" ? "このグループ" : "このトーク"}に現場のアラートが届きます。`);
  }
  return c.json({ ok: true });
});

export default r;
