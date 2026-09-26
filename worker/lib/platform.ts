// プラン・契約状態・利用上限・運営監査
import { fail, newId, now, parseJson } from "./app";

export type Feature = "reports" | "devices" | "analytics" | "sun";

export interface OrgContract {
  orgId: string;
  name: string;
  status: "trial" | "active" | "suspended" | "cancelled";
  trialEndsAt: number | null;
  plan: {
    code: string;
    name: string;
    monthlyFee: number;
    feePerTag: number;
    feePerUser: number;
    includedTags: number;
    includedUsers: number;
    features: Feature[];
  };
  limits: { tags: number | null; users: number | null; sites: number | null };
}

interface Row {
  id: string;
  name: string;
  status: OrgContract["status"];
  trial_ends_at: number | null;
  max_tags_override: number | null;
  max_users_override: number | null;
  code: string;
  plan_name: string;
  monthly_fee: number;
  fee_per_tag: number;
  fee_per_user: number;
  included_tags: number;
  included_users: number;
  max_tags: number | null;
  max_users: number | null;
  max_sites: number | null;
  features_json: string;
}

export async function getContract(env: Env, orgId: string): Promise<OrgContract> {
  const r = await env.DB.prepare(
    `SELECT o.id, o.name, o.status, o.trial_ends_at, o.max_tags_override, o.max_users_override,
            p.code, p.name AS plan_name, p.monthly_fee, p.fee_per_tag, p.fee_per_user, p.included_tags, p.included_users,
            p.max_tags, p.max_users, p.max_sites, p.features_json
       FROM organizations o LEFT JOIN plans p ON p.code = o.plan WHERE o.id = ?`
  )
    .bind(orgId)
    .first<Row>();
  if (!r) fail(404, "組織が見つかりません");
  return {
    orgId: r.id,
    name: r.name,
    status: r.status,
    trialEndsAt: r.trial_ends_at,
    plan: {
      code: r.code ?? "standard",
      name: r.plan_name ?? "スタンダード",
      monthlyFee: r.monthly_fee ?? 0,
      feePerTag: r.fee_per_tag ?? 0,
      feePerUser: r.fee_per_user ?? 0,
      includedTags: r.included_tags ?? 0,
      includedUsers: r.included_users ?? 0,
      features: parseJson<Feature[]>(r.features_json, [])
    },
    limits: { tags: r.max_tags_override ?? r.max_tags, users: r.max_users_override ?? r.max_users, sites: r.max_sites }
  };
}

/** 契約が有効か（停止・解約・トライアル期限切れを遮断） */
export function contractBlockReason(c: Pick<OrgContract, "status" | "trialEndsAt">): string | null {
  if (c.status === "suspended") return "ご契約が一時停止されています。運営までお問い合わせください";
  if (c.status === "cancelled") return "ご契約は終了しています";
  if (c.status === "trial" && c.trialEndsAt && c.trialEndsAt < Date.now()) return "トライアル期間が終了しました。本契約のお手続きをお願いします";
  return null;
}

export async function assertFeature(env: Env, orgId: string, feature: Feature, label: string) {
  const c = await getContract(env, orgId);
  if (!c.plan.features.includes(feature)) fail(403, `${label}は現在のプラン（${c.plan.name}）ではご利用いただけません`, "plan_required");
}

export async function usage(env: Env, orgId: string) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM tags WHERE org_id = ?1 AND active = 1) AS tags,
            (SELECT COUNT(*) FROM users WHERE org_id = ?1 AND active = 1) AS users,
            (SELECT COUNT(*) FROM sites WHERE org_id = ?1) AS sites,
            (SELECT COUNT(*) FROM devices WHERE org_id = ?1) AS devices,
            (SELECT COUNT(*) FROM tag_stock WHERE org_id = ?1 AND status = 'allocated') AS stock_unregistered`
  )
    .bind(orgId)
    .first<{ tags: number; users: number; sites: number; devices: number; stock_unregistered: number }>();
  return r ?? { tags: 0, users: 0, sites: 0, devices: 0, stock_unregistered: 0 };
}

export async function assertLimit(env: Env, orgId: string, kind: "tags" | "users" | "sites") {
  const [c, u] = await Promise.all([getContract(env, orgId), usage(env, orgId)]);
  const limit = c.limits[kind];
  const label = { tags: "タグ", users: "ユーザー", sites: "現場" }[kind];
  if (limit !== null && u[kind] >= limit) fail(403, `${label}数がプランの上限（${limit}）に達しています。プラン変更をご検討ください`, "limit_reached");
}

export async function platformAudit(env: Env, adminId: string | null, action: string, targetType: string | null, targetId: string | null, detail?: unknown) {
  await env.DB.prepare("INSERT INTO platform_audit_logs (id, admin_id, action, target_type, target_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(newId(), adminId, action, targetType, targetId, detail === undefined ? null : JSON.stringify(detail), now())
    .run();
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM platform_settings").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

/** 月次請求額の計算（プラン基本料 + 超過タグ + 超過ユーザー） */
export async function computeInvoice(env: Env, orgId: string) {
  const [c, u] = await Promise.all([getContract(env, orgId), usage(env, orgId)]);
  const settings = await getSettings(env);
  const taxRate = Number(settings.tax_rate ?? 10) / 100;
  const items: { label: string; qty: number; unit: number; amount: number }[] = [];
  items.push({ label: `${c.plan.name}プラン 月額基本料`, qty: 1, unit: c.plan.monthlyFee, amount: c.plan.monthlyFee });
  const extraTags = Math.max(0, u.tags - c.plan.includedTags);
  if (extraTags && c.plan.feePerTag) items.push({ label: `追加タグ（基本 ${c.plan.includedTags} 枚超過分）`, qty: extraTags, unit: c.plan.feePerTag, amount: extraTags * c.plan.feePerTag });
  const extraUsers = Math.max(0, u.users - c.plan.includedUsers);
  if (extraUsers && c.plan.feePerUser) items.push({ label: `追加ユーザー（基本 ${c.plan.includedUsers} 名超過分）`, qty: extraUsers, unit: c.plan.feePerUser, amount: extraUsers * c.plan.feePerUser });
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const tax = Math.floor(subtotal * taxRate);
  return { plan: c.plan, usage: u, items, subtotal, tax, total: subtotal + tax };
}

export function monthKey(ms = Date.now()) {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 7);
}

export { parseJson };
