const dtf = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const tf = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });

export const fmtDateTime = (ms?: number | null) => (ms ? dtf.format(ms) : "—");
export const fmtTime = (ms?: number | null) => (ms ? tf.format(ms) : "—");
export const fmtDate = (ms?: number | null) => (ms ? df.format(ms) : "—");

export function fmtAgo(ms?: number | null) {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

export function fmtDuration(sec?: number | null) {
  if (sec == null) return "—";
  if (sec < 60) return `${Math.round(sec)}秒`;
  if (sec < 3600) return `${Math.round(sec / 60)}分`;
  return `${(sec / 3600).toFixed(1)}時間`;
}

export const ASSURANCE_LABEL: Record<string, string> = { high: "証明:高", medium: "証明:中", low: "証明:低" };
export const RESULT_LABEL: Record<string, string> = { ok: "異常なし", ng: "異常あり", needs_followup: "要フォロー" };
export const SEVERITY_LABEL: Record<string, string> = { info: "情報", warning: "注意", danger: "危険" };
export const PURPOSE_LABEL: Record<string, string> = {
  checkin: "打刻",
  inspection: "設備",
  patrol: "巡回",
  procedure: "手順",
  unlock: "起動",
  deadman: "生存確認"
};
export const TAG_KIND_LABEL: Record<string, string> = { checkpoint: "チェックポイント", equipment: "設備", procedure_step: "手順ステップ", deadman: "生存確認" };

export const yen = (n?: number | null) => (n == null ? "—" : `¥${n.toLocaleString("ja-JP")}`);
export const ORG_STATUS_LABEL: Record<string, string> = { trial: "トライアル", active: "契約中", suspended: "停止中", cancelled: "解約" };
export const STOCK_STATUS_LABEL: Record<string, string> = { in_stock: "在庫", allocated: "出荷済（未登録）", registered: "稼働中", retired: "廃棄" };
export const ITEM_TYPE_LABEL: Record<string, string> = { location_tag: "設置タグ", badge: "社員証" };
export const INVOICE_STATUS_LABEL: Record<string, string> = { draft: "下書き", issued: "発行済", paid: "入金済", void: "無効" };
export const TICKET_STATUS_LABEL: Record<string, string> = { open: "未回答", answered: "回答済", closed: "完了" };
export const TICKET_CATEGORY_LABEL: Record<string, string> = { general: "一般", tags: "タグ・機器", billing: "請求", bug: "不具合", request: "要望" };
export const FEATURE_LABEL: Record<string, string> = { reports: "レポート出力", devices: "IoTデバイス連携", analytics: "ヒートマップ分析", sun: "暗号タグ鍵の手動登録" };
export const tagCode = (id: string) => (id.length === 10 ? `${id.slice(0, 5)}-${id.slice(5)}` : id);
export function parsePlanFeatures(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
