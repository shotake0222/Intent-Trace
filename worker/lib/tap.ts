import type { Assurance, TapResponse } from "../../shared/types";
import { newId, now, broadcast, raiseAlert, fail } from "./app";
import type { TagRow } from "./tags";
import { activePatrolFor, activeProcedureFor, activeDeadmanFor, deadmanStub, lockStub } from "./domain";

export interface TapInput {
  tag: TagRow;
  user: { id: string; name: string; orgId: string };
  source: "pwa_url" | "pwa_webnfc" | "pwa_qr" | "reader";
  assurance: Assurance;
  sunCounter: number | null;
  clientEventId: string | null;
  occurredAt: number;
  offline: boolean;
  warnings: string[];
  meta?: Record<string, unknown>;
}

const MAX_CLOCK_SKEW = 5 * 60 * 1000;
const MAX_OFFLINE_AGE = 7 * 86400 * 1000;

/**
 * タップ（物理タッチ）1件を記録し、そのタップが持つ「意図」を解釈して各ワークフローを前進させる。
 * NFCタグ自体は ID しか持たず、状態（巡回の進捗・手順の段階・生存確認）はすべてここでクラウド側に作られる = 仮想ビーコン。
 */
export async function processTap(env: Env, input: TapInput): Promise<TapResponse> {
  const { tag, user } = input;
  const received = now();
  const warnings = [...input.warnings];

  // 時刻の妥当性：オンライン時は端末時計を信用しすぎない
  let occurredAt = input.occurredAt;
  if (!input.offline && Math.abs(occurredAt - received) > MAX_CLOCK_SKEW) {
    warnings.push("端末の時刻がずれているためサーバ時刻で記録しました");
    occurredAt = received;
  }
  if (input.offline && (occurredAt > received + MAX_CLOCK_SKEW || occurredAt < received - MAX_OFFLINE_AGE)) {
    fail(422, "オフライン記録の時刻が不正です");
  }

  // 冪等性：同じ clientEventId の再送は既存を返す
  if (input.clientEventId) {
    const dup = await env.DB.prepare("SELECT id, assurance FROM tap_events WHERE user_id = ? AND client_event_id = ?")
      .bind(user.id, input.clientEventId)
      .first<{ id: string; assurance: Assurance }>();
    if (dup) return { tapEventId: dup.id, assurance: dup.assurance, duplicate: true, warnings: [] };
  }

  const tapId = newId();
  // ワークフロー判定
  let purpose = tag.kind === "equipment" ? "inspection" : tag.kind === "deadman" ? "deadman" : "checkin";
  const res: TapResponse = { tapEventId: tapId, assurance: input.assurance, duplicate: false, warnings };
  const followUps: D1PreparedStatement[] = [];
  const afterCommit: (() => Promise<unknown>)[] = [];

  // --- 手順インターロック ---
  const proc = await activeProcedureFor(env, user.id);
  if (proc) {
    const step = await env.DB.prepare("SELECT seq, tag_id, instruction FROM procedure_steps WHERE procedure_id = ? AND seq = ?")
      .bind(proc.procedure_id, proc.next_seq)
      .first<{ seq: number; tag_id: string; instruction: string }>();
    const inProcedure = await env.DB.prepare("SELECT seq FROM procedure_steps WHERE procedure_id = ? AND tag_id = ?").bind(proc.procedure_id, tag.id).first<{ seq: number }>();
    if (step && step.tag_id === tag.id) {
      purpose = "procedure";
      const nextSeq = proc.next_seq + 1;
      const done = nextSeq > proc.total;
      followUps.push(
        env.DB.prepare("UPDATE procedure_runs SET next_seq = ?, status = ?, finished_at = ? WHERE id = ?").bind(
          nextSeq,
          done ? "completed" : "in_progress",
          done ? received : null,
          proc.id
        )
      );
      let message = done ? `「${proc.procedure_name}」全手順完了` : `手順 ${proc.next_seq}/${proc.total} 完了`;
      if (done && proc.unlocks_equipment && proc.equipment_id) {
        const eqId = proc.equipment_id;
        afterCommit.push(async () => {
          const r = await lockStub(env, eqId).arm(user.id);
          await broadcast(env, { type: "lock", siteId: tag.site_id, at: now(), data: { equipmentId: eqId, ...r.state } });
        });
        message += "。設備の起動が許可されました";
      }
      res.procedure = { runId: proc.id, status: done ? "completed" : "in_progress", nextSeq, total: proc.total, message, ok: true };
    } else if (inProcedure) {
      // 手順のスキップ・順序違反
      purpose = "procedure";
      res.procedure = {
        runId: proc.id,
        status: "in_progress",
        nextSeq: proc.next_seq,
        total: proc.total,
        ok: false,
        message: `順序が違います。先に手順${proc.next_seq}「${step?.instruction ?? ""}」を実施してください`
      };
      afterCommit.push(() =>
        raiseAlert(env, {
          orgId: user.orgId,
          siteId: tag.site_id,
          type: "interlock_violation",
          severity: "warning",
          userId: user.id,
          refId: proc.id,
          message: `${user.name} さんが「${proc.procedure_name}」で手順${inProcedure.seq}を先に実施しようとしました（期待: 手順${proc.next_seq}）`
        })
      );
      followUps.push(
        env.DB.prepare(
          "INSERT INTO incidents (id, org_id, site_id, zone_id, source, severity, user_id, equipment_id, title, occurred_at, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(newId(), user.orgId, tag.site_id, tag.zone_id, "interlock", "warning", user.id, proc.equipment_id, `手順スキップ未遂: ${proc.procedure_name}`, occurredAt, received)
      );
    }
  }

  // --- 巡回 ---
  const patrol = await activePatrolFor(env, user.id);
  if (patrol && purpose !== "procedure") {
    const points = await env.DB.prepare("SELECT seq, tag_id FROM patrol_route_points WHERE route_id = ? ORDER BY seq").bind(patrol.route_id).all<{ seq: number; tag_id: string }>();
    const visited = await env.DB.prepare("SELECT seq FROM patrol_run_visits WHERE run_id = ?").bind(patrol.id).all<{ seq: number }>();
    const visitedSet = new Set(visited.results.map((v) => v.seq));
    const match = points.results.find((p) => p.tag_id === tag.id && !visitedSet.has(p.seq));
    if (match) {
      purpose = "patrol";
      if (patrol.enforce_order && match.seq !== patrol.next_seq) {
        res.patrol = {
          runId: patrol.id,
          status: "in_progress",
          nextSeq: patrol.next_seq,
          total: patrol.total,
          message: `巡回順序が違います（本来は ${patrol.next_seq} 番目の地点）。記録は残しました`
        };
        warnings.push("巡回順序違反");
      }
      visitedSet.add(match.seq);
      followUps.push(env.DB.prepare("INSERT INTO patrol_run_visits (run_id, seq, tap_event_id, visited_at) VALUES (?,?,?,?)").bind(patrol.id, match.seq, tapId, occurredAt));
      const nextSeq = points.results.find((p) => !visitedSet.has(p.seq))?.seq ?? patrol.total + 1;
      const done = visitedSet.size >= patrol.total;
      followUps.push(
        env.DB.prepare("UPDATE patrol_runs SET next_seq = ?, status = ?, finished_at = ? WHERE id = ?").bind(nextSeq, done ? "completed" : "in_progress", done ? received : null, patrol.id)
      );
      res.patrol ??= {
        runId: patrol.id,
        status: done ? "completed" : "in_progress",
        nextSeq,
        total: patrol.total,
        message: done ? `巡回「${patrol.route_name}」完了` : `巡回 ${visitedSet.size}/${patrol.total} 地点`
      };
      res.patrol.status = done ? "completed" : "in_progress";
      res.patrol.nextSeq = nextSeq;
    }
  }

  // --- デッドマン: どのタップも生存応答として扱う ---
  const dm = await activeDeadmanFor(env, user.id);
  if (dm) {
    const st = await deadmanStub(env, dm.id).checkin();
    if (st) res.deadman = { deadlineAt: st.deadlineAt };
    if (tag.kind === "deadman") purpose = "deadman";
  } else if (tag.kind === "deadman") {
    warnings.push("生存確認セッションが開始されていません");
  }

  // 証跡の原本を記録（SUNカウンタの一意制約で二重使用を防止）
  const insertTap = env.DB.prepare(
    `INSERT INTO tap_events (id, org_id, site_id, zone_id, tag_id, user_id, source, assurance, purpose, client_event_id, occurred_at, received_at, offline, sun_ctr, meta_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    tapId,
    user.orgId,
    tag.site_id,
    tag.zone_id,
    tag.id,
    user.id,
    input.source,
    input.assurance,
    purpose,
    input.clientEventId,
    occurredAt,
    received,
    input.offline ? 1 : 0,
    input.sunCounter,
    input.meta ? JSON.stringify(input.meta) : null
  );
  const stmts = [insertTap, ...followUps];
  if (input.sunCounter !== null) {
    stmts.push(env.DB.prepare("UPDATE tags SET sun_last_ctr = MAX(sun_last_ctr, ?) WHERE id = ?").bind(input.sunCounter, tag.id));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (String(e).includes("UNIQUE") && input.sunCounter !== null) fail(409, "このタグURLは既に使用済みです（再タッチしてください）", "sun_replay");
    if (String(e).includes("UNIQUE")) {
      const dup = await env.DB.prepare("SELECT id, assurance FROM tap_events WHERE user_id = ? AND client_event_id = ?")
        .bind(user.id, input.clientEventId)
        .first<{ id: string; assurance: Assurance }>();
      if (dup) return { tapEventId: dup.id, assurance: dup.assurance, duplicate: true, warnings: [] };
    }
    throw e;
  }
  for (const f of afterCommit) await f();

  await broadcast(env, {
    type: "tap",
    siteId: tag.site_id,
    at: occurredAt,
    data: { tapEventId: tapId, tagId: tag.id, tagLabel: tag.label, zoneName: tag.zone_name, userId: user.id, userName: user.name, assurance: input.assurance, purpose, offline: input.offline }
  });
  return res;
}
