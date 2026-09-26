import { DurableObject } from "cloudflare:workers";
import type { LockState } from "../../shared/types";

/**
 * 設備1台につき1インスタンス。「今誰がこの機械を操作中か」を排他的に管理するバーチャルキー。
 * - acquire: 資格判定を通過したユーザーのみ呼ばれる（判定は Worker 側）
 * - arm:     手順インターロック完了で「起動許可」状態にする
 * - 固定リーダー/重機コントローラは lock-state を参照してイグニッション許可を決める
 */
interface Stored {
  lockedBy: { userId: string; userName: string } | null;
  since: number | null;
  armed: boolean;
  requiresProcedure: boolean;
}

const MAX_HOLD_MS = 12 * 3600 * 1000; // 取り忘れ防止の自動解除

export class EquipmentLock extends DurableObject<Env> {
  private async load(): Promise<Stored> {
    return (await this.ctx.storage.get<Stored>("s")) ?? { lockedBy: null, since: null, armed: false, requiresProcedure: false };
  }

  private view(s: Stored): LockState {
    return { lockedBy: s.lockedBy, since: s.since, armed: s.armed };
  }

  async status(): Promise<LockState> {
    return this.view(await this.load());
  }

  async acquire(user: { userId: string; userName: string }, requiresProcedure: boolean): Promise<{ ok: boolean; state: LockState; reason?: string }> {
    const s = await this.load();
    if (s.lockedBy && s.lockedBy.userId !== user.userId) {
      return { ok: false, state: this.view(s), reason: `${s.lockedBy.userName} さんが操作中です` };
    }
    if (s.lockedBy?.userId === user.userId) return { ok: true, state: this.view(s) };
    const next: Stored = { lockedBy: user, since: Date.now(), armed: !requiresProcedure, requiresProcedure };
    await this.ctx.storage.put("s", next);
    await this.ctx.storage.setAlarm(Date.now() + MAX_HOLD_MS);
    return { ok: true, state: this.view(next) };
  }

  async arm(userId: string): Promise<{ ok: boolean; state: LockState }> {
    const s = await this.load();
    if (s.lockedBy?.userId !== userId) return { ok: false, state: this.view(s) };
    s.armed = true;
    await this.ctx.storage.put("s", s);
    return { ok: true, state: this.view(s) };
  }

  async release(userId: string, force = false): Promise<{ ok: boolean; state: LockState; previous: Stored["lockedBy"] }> {
    const s = await this.load();
    if (!s.lockedBy) return { ok: true, state: this.view(s), previous: null };
    if (s.lockedBy.userId !== userId && !force) return { ok: false, state: this.view(s), previous: s.lockedBy };
    const previous = s.lockedBy;
    const cleared: Stored = { lockedBy: null, since: null, armed: false, requiresProcedure: false };
    await this.ctx.storage.put("s", cleared);
    await this.ctx.storage.deleteAlarm();
    return { ok: true, state: this.view(cleared), previous };
  }

  async alarm() {
    await this.ctx.storage.put("s", { lockedBy: null, since: null, armed: false, requiresProcedure: false } satisfies Stored);
  }
}
