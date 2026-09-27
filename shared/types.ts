// API とフロントで共有する型

export type Role = "admin" | "manager" | "worker";
export type Assurance = "high" | "medium" | "low";
export type TagKind = "checkpoint" | "equipment" | "procedure_step" | "deadman";
export type Severity = "info" | "warning" | "danger";

export interface Me {
  id: string;
  name: string;
  role: Role;
  orgId: string;
  orgName: string;
  plan: string;
  employeeCode: string;
  qualifications: { code: string; name: string; expiresAt: number | null }[];
  features: string[];
  planName: string;
  orgStatus: "trial" | "active" | "suspended" | "cancelled";
  trialEndsAt: number | null;
  /** 運営による代理ログイン中なら運営アカウントID */
  impersonatedBy: string | null;
  /** 現行の利用規約に組織として同意済みか（管理者が同意） */
  termsAccepted: boolean;
  termsVersion: string;
}

/** 利用規約の版。改定したら更新すると、管理者に再同意を求める */
export const TERMS_VERSION = "2026-10-01";

export interface TagResolution {
  tag: {
    id: string;
    kind: TagKind;
    label: string;
    siteId: string;
    siteName: string;
    zoneName: string | null;
    security: "static" | "sun";
  };
  equipment: EquipmentCard | null;
  /** このタグで実施中の巡回・手順の文脈 */
  activePatrol: { runId: string; routeName: string; nextSeq: number; total: number; expectedTagId: string | null } | null;
  activeProcedure: {
    runId: string;
    procedureName: string;
    nextSeq: number;
    total: number;
    expectedTagId: string | null;
    instruction: string | null;
  } | null;
  deadman: { sessionId: string; deadlineAt: number } | null;
}

export interface EquipmentCard {
  id: string;
  name: string;
  category: string | null;
  model: string | null;
  serialNo: string | null;
  locationNote: string | null;
  lockable: boolean;
  requiredQualification: { code: string; name: string } | null;
  checklist: string[];
  inspectionIntervalDays: number | null;
  lastInspection: { at: number; result: string; userName: string } | null;
  nextDueAt: number | null;
  documents: { id: string; filename: string; kind: string; contentType: string }[];
  recentInspections: { id: string; at: number; result: string; userName: string; note: string | null }[];
  lock: LockState;
  procedures: { id: string; name: string; steps: number; unlocksEquipment: boolean }[];
}

export interface LockState {
  lockedBy: { userId: string; userName: string } | null;
  since: number | null;
  /** 手順インターロックで「起動許可」済みか */
  armed: boolean;
}

/** タップ送信（オンライン/オフライン共通） */
export interface TapRequest {
  tagId: string;
  clientEventId: string;
  occurredAt: number;
  source: "pwa_url" | "pwa_webnfc" | "pwa_qr";
  /** NTAG424 SUN パラメータ（URL の picc / cmac） */
  sun?: { picc: string; cmac: string };
  /** Android Web NFC で読んだ物理UID */
  serial?: string;
  offline?: boolean;
}

export interface TapResponse {
  tapEventId: string;
  assurance: Assurance;
  duplicate: boolean;
  patrol?: { runId: string; status: string; nextSeq: number; total: number; message: string };
  procedure?: { runId: string; status: string; nextSeq: number; total: number; message: string; ok: boolean };
  deadman?: { deadlineAt: number };
  warnings: string[];
}

export interface LiveEvent {
  type: "tap" | "incident" | "alert" | "lock" | "deadman" | "inspection";
  siteId: string;
  at: number;
  data: Record<string, unknown>;
}
