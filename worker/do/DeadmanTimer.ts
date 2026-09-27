import { DurableObject } from "cloudflare:workers";
import { raiseAlert, broadcast, newId } from "../lib/app";
import { recordError } from "../lib/monitor";

/**
 * 単独作業者の生存確認タイマー（セッション1件につき1インスタンス）。
 * 作業員は interval ごとに NFC タグ（または画面ボタン）でチェックインする。
 *   deadline 超過 → 猶予(grace)フェーズ：本人端末に警告 + 管理者へ warning
 *   grace 超過   → alarm フェーズ：管理者へ danger アラート（救助要請）
 * Durable Object Alarm を使うため、Worker が起動していなくても確実に発火する。
 */
interface State {
  sessionId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userName: string;
  intervalSec: number;
  graceSec: number;
  deadlineAt: number;
  phase: "waiting" | "grace" | "alarm" | "ended";
}

export class DeadmanTimer extends DurableObject<Env> {
  private async load() {
    return this.ctx.storage.get<State>("s");
  }

  async start(init: Omit<State, "deadlineAt" | "phase">): Promise<State> {
    const s: State = { ...init, deadlineAt: Date.now() + init.intervalSec * 1000, phase: "waiting" };
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(s.deadlineAt);
    return s;
  }

  async checkin(): Promise<State | null> {
    const s = await this.load();
    if (!s || s.phase === "ended") return null;
    const recovered = s.phase !== "waiting";
    s.deadlineAt = Date.now() + s.intervalSec * 1000;
    s.phase = "waiting";
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(s.deadlineAt);
    await this.env.DB.prepare("UPDATE deadman_sessions SET last_checkin_at = ?, status = 'active' WHERE id = ?").bind(Date.now(), s.sessionId).run();
    if (recovered) {
      await raiseAlert(this.env, {
        orgId: s.orgId,
        siteId: s.siteId,
        type: "deadman_recovered",
        severity: "info",
        userId: s.userId,
        refId: s.sessionId,
        message: `${s.userName} さんの生存応答が再開しました`
      });
    }
    await broadcast(this.env, { type: "deadman", siteId: s.siteId, at: Date.now(), data: { sessionId: s.sessionId, userId: s.userId, phase: s.phase, deadlineAt: s.deadlineAt } });
    return s;
  }

  async end(): Promise<void> {
    const s = await this.load();
    if (!s) return;
    s.phase = "ended";
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.deleteAlarm();
    await broadcast(this.env, { type: "deadman", siteId: s.siteId, at: Date.now(), data: { sessionId: s.sessionId, userId: s.userId, phase: "ended" } });
  }

  async status(): Promise<State | null> {
    return (await this.load()) ?? null;
  }

  async alarm() {
    try {
      await this.fire();
    } catch (e) {
      // 記録やアラート保存に失敗しても見守りを止めない: 記録して30秒後に再試行
      console.error("deadman alarm failed", e);
      await recordError(this.env, { source: "server", path: "DeadmanTimer.alarm", message: e instanceof Error ? e.message : String(e), detail: e instanceof Error ? (e.stack ?? null) : null });
      const s = await this.load();
      if (s && s.phase === "alarm") await this.ctx.storage.setAlarm(Date.now() + 30_000);
      else if (s && s.phase === "grace" && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(s.deadlineAt + s.graceSec * 1000);
    }
  }

  private async fire() {
    const s = await this.load();
    if (!s || s.phase === "ended") return;
    const t = Date.now();
    if (s.phase === "waiting") {
      s.phase = "grace";
      await this.ctx.storage.put("s", s);
      await this.ctx.storage.setAlarm(s.deadlineAt + s.graceSec * 1000);
      await raiseAlert(this.env, {
        orgId: s.orgId,
        siteId: s.siteId,
        type: "deadman_late",
        severity: "warning",
        userId: s.userId,
        refId: s.sessionId,
        message: `${s.userName} さんのチェックインが遅れています（猶予 ${Math.round(s.graceSec / 60)} 分）`
      });
    } else if (s.phase === "grace") {
      s.phase = "alarm";
      await this.ctx.storage.put("s", s);
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE deadman_sessions SET status = 'alarm' WHERE id = ?").bind(s.sessionId),
        this.env.DB.prepare(
          "INSERT INTO incidents (id, org_id, site_id, source, severity, user_id, title, occurred_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(newId(), s.orgId, s.siteId, "deadman", "danger", s.userId, "デッドマン応答なし", t, t)
      ]);
      await raiseAlert(this.env, {
        orgId: s.orgId,
        siteId: s.siteId,
        type: "deadman_missed",
        severity: "danger",
        userId: s.userId,
        refId: s.sessionId,
        message: `【緊急】${s.userName} さんから生存応答がありません。至急確認してください`
      });
      // 応答があるまで 5 分ごとに再通知
      await this.ctx.storage.setAlarm(t + 5 * 60 * 1000);
    } else if (s.phase === "alarm") {
      await raiseAlert(this.env, {
        orgId: s.orgId,
        siteId: s.siteId,
        type: "deadman_missed",
        severity: "danger",
        userId: s.userId,
        refId: s.sessionId,
        message: `【再通知】${s.userName} さんの応答がまだありません`
      });
      await this.ctx.storage.setAlarm(t + 5 * 60 * 1000);
    }
    await broadcast(this.env, { type: "deadman", siteId: s.siteId, at: t, data: { sessionId: s.sessionId, userId: s.userId, phase: s.phase, deadlineAt: s.deadlineAt } });
  }
}
