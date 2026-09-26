import type { EquipmentCard, LockState, TagResolution } from "../../shared/types";
import { parseJson, fail } from "./app";
import type { TagRow } from "./tags";

const DAY = 86400_000;

export function lockStub(env: Env, equipmentId: string) {
  return env.EQUIPMENT_LOCK.get(env.EQUIPMENT_LOCK.idFromName(equipmentId));
}

export function deadmanStub(env: Env, sessionId: string) {
  return env.DEADMAN.get(env.DEADMAN.idFromName(sessionId));
}

interface EquipmentRow {
  id: string;
  org_id: string;
  site_id: string;
  name: string;
  category: string | null;
  model: string | null;
  serial_no: string | null;
  location_note: string | null;
  lockable: number;
  inspection_interval_days: number | null;
  checklist_json: string | null;
  q_code: string | null;
  q_name: string | null;
  required_qualification_id: string | null;
}

export async function getEquipment(env: Env, id: string, orgId: string) {
  const e = await env.DB.prepare(
    `SELECT e.*, q.code AS q_code, q.name AS q_name FROM equipment e
       LEFT JOIN qualifications q ON q.id = e.required_qualification_id
      WHERE e.id = ? AND e.org_id = ?`
  )
    .bind(id, orgId)
    .first<EquipmentRow>();
  if (!e) fail(404, "設備が見つかりません");
  return e;
}

export async function buildEquipmentCard(env: Env, equipmentId: string, orgId: string): Promise<EquipmentCard> {
  const e = await getEquipment(env, equipmentId, orgId);
  const [docs, insp, procs, lock] = await Promise.all([
    env.DB.prepare("SELECT id, filename, kind, content_type FROM documents WHERE equipment_id = ? AND kind = 'manual' ORDER BY created_at DESC")
      .bind(equipmentId)
      .all<{ id: string; filename: string; kind: string; content_type: string }>(),
    env.DB.prepare(
      `SELECT i.id, i.completed_at, i.result, i.note, u.name AS user_name FROM inspections i JOIN users u ON u.id = i.user_id
        WHERE i.equipment_id = ? ORDER BY i.completed_at DESC LIMIT 10`
    )
      .bind(equipmentId)
      .all<{ id: string; completed_at: number; result: string; note: string | null; user_name: string }>(),
    env.DB.prepare(
      `SELECT p.id, p.name, p.unlocks_equipment, (SELECT COUNT(*) FROM procedure_steps s WHERE s.procedure_id = p.id) AS steps
         FROM procedures p WHERE p.equipment_id = ?`
    )
      .bind(equipmentId)
      .all<{ id: string; name: string; unlocks_equipment: number; steps: number }>(),
    e.lockable ? lockStub(env, equipmentId).status() : Promise.resolve<LockState>({ lockedBy: null, since: null, armed: false })
  ]);
  const last = insp.results[0];
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    model: e.model,
    serialNo: e.serial_no,
    locationNote: e.location_note,
    lockable: !!e.lockable,
    requiredQualification: e.q_code ? { code: e.q_code, name: e.q_name! } : null,
    checklist: parseJson<string[]>(e.checklist_json, []),
    inspectionIntervalDays: e.inspection_interval_days,
    lastInspection: last ? { at: last.completed_at, result: last.result, userName: last.user_name } : null,
    nextDueAt: last && e.inspection_interval_days ? last.completed_at + e.inspection_interval_days * DAY : null,
    documents: docs.results.map((d) => ({ id: d.id, filename: d.filename, kind: d.kind, contentType: d.content_type })),
    recentInspections: insp.results.map((i) => ({ id: i.id, at: i.completed_at, result: i.result, userName: i.user_name, note: i.note })),
    lock,
    procedures: procs.results.map((p) => ({ id: p.id, name: p.name, steps: p.steps, unlocksEquipment: !!p.unlocks_equipment }))
  };
}

/** 資格の保有・有効期限を判定 */
export async function checkQualification(env: Env, userId: string, qualificationId: string | null) {
  if (!qualificationId) return { ok: true as const };
  const q = await env.DB.prepare(
    `SELECT q.name, uq.expires_at FROM qualifications q
       LEFT JOIN user_qualifications uq ON uq.qualification_id = q.id AND uq.user_id = ?
      WHERE q.id = ?`
  )
    .bind(userId, qualificationId)
    .first<{ name: string; expires_at: number | null | undefined }>();
  if (!q) return { ok: false as const, reason: "資格マスタが見つかりません" };
  const held = await env.DB.prepare("SELECT 1 AS x FROM user_qualifications WHERE user_id = ? AND qualification_id = ?").bind(userId, qualificationId).first();
  if (!held) return { ok: false as const, reason: `「${q.name}」の資格がありません` };
  if (q.expires_at && q.expires_at < Date.now()) return { ok: false as const, reason: `「${q.name}」の資格が有効期限切れです` };
  return { ok: true as const };
}

/** 「そのユーザーが直近にその設備のタグに物理タッチしたか」— ゼロ距離の証明 */
export async function findRecentEquipmentTap(env: Env, userId: string, equipmentId: string, withinMs: number) {
  return env.DB.prepare(
    `SELECT te.id, te.occurred_at, te.assurance FROM tap_events te JOIN tags t ON t.id = te.tag_id
      WHERE te.user_id = ? AND t.equipment_id = ? AND te.occurred_at >= ?
      ORDER BY te.occurred_at DESC LIMIT 1`
  )
    .bind(userId, equipmentId, Date.now() - withinMs)
    .first<{ id: string; occurred_at: number; assurance: string }>();
}

export async function activePatrolFor(env: Env, userId: string) {
  const run = await env.DB.prepare(
    `SELECT r.id, r.route_id, r.next_seq, pr.name AS route_name, pr.enforce_order,
            (SELECT COUNT(*) FROM patrol_route_points p WHERE p.route_id = r.route_id) AS total
       FROM patrol_runs r JOIN patrol_routes pr ON pr.id = r.route_id
      WHERE r.user_id = ? AND r.status = 'in_progress' ORDER BY r.started_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ id: string; route_id: string; next_seq: number; route_name: string; enforce_order: number; total: number }>();
  return run;
}

export async function activeProcedureFor(env: Env, userId: string) {
  return env.DB.prepare(
    `SELECT r.id, r.procedure_id, r.next_seq, p.name AS procedure_name, p.equipment_id, p.unlocks_equipment,
            (SELECT COUNT(*) FROM procedure_steps s WHERE s.procedure_id = r.procedure_id) AS total
       FROM procedure_runs r JOIN procedures p ON p.id = r.procedure_id
      WHERE r.user_id = ? AND r.status = 'in_progress' ORDER BY r.started_at DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ id: string; procedure_id: string; next_seq: number; procedure_name: string; equipment_id: string | null; unlocks_equipment: number; total: number }>();
}

export async function activeDeadmanFor(env: Env, userId: string) {
  return env.DB.prepare("SELECT id FROM deadman_sessions WHERE user_id = ? AND status IN ('active','alarm') ORDER BY started_at DESC LIMIT 1")
    .bind(userId)
    .first<{ id: string }>();
}

export async function resolveTag(env: Env, tag: TagRow, userId: string, orgId: string): Promise<TagResolution> {
  const [equipment, patrol, proc, dm] = await Promise.all([
    tag.equipment_id ? buildEquipmentCard(env, tag.equipment_id, orgId) : Promise.resolve(null),
    activePatrolFor(env, userId),
    activeProcedureFor(env, userId),
    activeDeadmanFor(env, userId)
  ]);
  let activePatrol: TagResolution["activePatrol"] = null;
  if (patrol) {
    const next = await env.DB.prepare("SELECT tag_id FROM patrol_route_points WHERE route_id = ? AND seq = ?").bind(patrol.route_id, patrol.next_seq).first<{ tag_id: string }>();
    activePatrol = { runId: patrol.id, routeName: patrol.route_name, nextSeq: patrol.next_seq, total: patrol.total, expectedTagId: next?.tag_id ?? null };
  }
  let activeProcedure: TagResolution["activeProcedure"] = null;
  if (proc) {
    const step = await env.DB.prepare("SELECT tag_id, instruction FROM procedure_steps WHERE procedure_id = ? AND seq = ?")
      .bind(proc.procedure_id, proc.next_seq)
      .first<{ tag_id: string; instruction: string }>();
    activeProcedure = {
      runId: proc.id,
      procedureName: proc.procedure_name,
      nextSeq: proc.next_seq,
      total: proc.total,
      expectedTagId: step?.tag_id ?? null,
      instruction: step?.instruction ?? null
    };
  }
  let deadman: TagResolution["deadman"] = null;
  if (dm) {
    const st = await deadmanStub(env, dm.id).status();
    if (st && st.phase !== "ended") deadman = { sessionId: dm.id, deadlineAt: st.deadlineAt };
  }
  return {
    tag: {
      id: tag.id,
      kind: tag.kind,
      label: tag.label,
      siteId: tag.site_id,
      siteName: tag.site_name,
      zoneName: tag.zone_name,
      security: tag.security
    },
    equipment,
    activePatrol,
    activeProcedure,
    deadman
  };
}
