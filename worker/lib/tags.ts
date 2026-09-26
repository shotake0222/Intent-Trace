import { fail } from "./app";
import { openSecret } from "./crypto";
import { verifySun, SunError } from "./sun";
import type { Assurance, TagKind } from "../../shared/types";

export interface TagRow {
  id: string;
  org_id: string;
  site_id: string;
  zone_id: string | null;
  kind: TagKind;
  label: string;
  equipment_id: string | null;
  security: "static" | "sun";
  uid: string | null;
  active: number;
  site_name: string;
  zone_name: string | null;
}

const CACHE_TTL = 3600;
const key = (id: string) => `tag:${id}`;

/** タグ定義を KV（エッジキャッシュ）→ D1 の順で取得。秘密鍵・カウンタはキャッシュしない */
export async function loadTag(env: Env, tagId: string): Promise<TagRow | null> {
  const cached = await env.CACHE.get<TagRow>(key(tagId), "json");
  if (cached) return cached;
  const row = await env.DB.prepare(
    `SELECT t.id, t.org_id, t.site_id, t.zone_id, t.kind, t.label, t.equipment_id, t.security, t.uid, t.active,
            s.name AS site_name, z.name AS zone_name
       FROM tags t JOIN sites s ON s.id = t.site_id LEFT JOIN zones z ON z.id = t.zone_id
      WHERE t.id = ?`
  )
    .bind(tagId)
    .first<TagRow>();
  if (row) await env.CACHE.put(key(tagId), JSON.stringify(row), { expirationTtl: CACHE_TTL });
  return row;
}

export async function invalidateTag(env: Env, tagId: string) {
  await env.CACHE.delete(key(tagId));
}

export async function invalidateTagsForEquipment(env: Env, equipmentId: string) {
  const { results } = await env.DB.prepare("SELECT id FROM tags WHERE equipment_id = ?").bind(equipmentId).all<{ id: string }>();
  await Promise.all(results.map((r) => invalidateTag(env, r.id)));
}

export interface AssuranceResult {
  assurance: Assurance;
  sunCounter: number | null;
  warnings: string[];
}

/**
 * 物理タッチの確からしさ（証明レベル）を判定する。
 *  high   : NTAG424 SUN の暗号検証に成功（そのタップでしか生成できない URL）/ 固定リーダー
 *  medium : Android Web NFC でタグの物理UIDを読み取り一致
 *  low    : 静的 URL のみ（URL を知っていれば再現可能）
 */
export async function evaluateAssurance(
  env: Env,
  tag: TagRow,
  input: { sun?: { picc: string; cmac: string }; serial?: string; offline?: boolean }
): Promise<AssuranceResult> {
  const warnings: string[] = [];
  if (tag.security === "sun") {
    if (!input.sun) fail(403, "このタグは暗号付きタグです。タグに直接スマホをかざしてください", "sun_required");
    const keys = await env.DB.prepare("SELECT sun_meta_key, sun_file_key, sun_last_ctr FROM tags WHERE id = ?")
      .bind(tag.id)
      .first<{ sun_meta_key: string; sun_file_key: string; sun_last_ctr: number }>();
    if (!keys?.sun_meta_key || !keys.sun_file_key) fail(500, "タグ鍵が未設定です");
    let res;
    try {
      res = await verifySun(
        input.sun.picc,
        input.sun.cmac,
        await openSecret(keys.sun_meta_key, env.TAG_KEY_SECRET),
        await openSecret(keys.sun_file_key, env.TAG_KEY_SECRET)
      );
    } catch (e) {
      if (e instanceof SunError) fail(403, `タグの真正性を確認できません: ${e.message}`, "sun_invalid");
      throw e;
    }
    if (tag.uid && res.uid !== tag.uid.toUpperCase()) fail(403, "登録と異なる物理タグです（複製の可能性）", "sun_uid_mismatch");
    // オンライン時はカウンタ単調増加を必須にする。オフライン再送は古いカウンタでも未使用なら許可（DBの一意制約で二重使用を防止）
    if (!input.offline && res.counter <= keys.sun_last_ctr) fail(409, "このURLは既に使用済みです（再タッチしてください）", "sun_replay");
    return { assurance: "high", sunCounter: res.counter, warnings };
  }
  if (input.serial && tag.uid) {
    const normalized = input.serial.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (normalized === tag.uid.toUpperCase()) return { assurance: "medium", sunCounter: null, warnings };
    warnings.push("読み取った物理UIDが登録と一致しません");
  }
  return { assurance: "low", sunCounter: null, warnings };
}
