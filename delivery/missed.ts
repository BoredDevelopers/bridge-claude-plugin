/**
 * When a pushed entry counts as MISSED (RFC-027 D7, amended by measurement).
 *
 * The RFC's first rule — "a later UserPromptSubmit that does not carry it, ≥ 2 s
 * after the push" — is wrong. Measured 2026-10-10 (Claude Code 2.1.296): a prompt
 * the user types while a tool runs fires `UserPromptSubmit` AT ONCE, while a
 * channel entry pushed during the same tool call is handed over only after the
 * tool result (16 s later in the probe). The typed prompt would have marked a
 * perfectly delivered entry as missed.
 *
 * So the host has had its chance only when:
 * - the entry was pushed while the session was IDLE (the host wakes it at once,
 *   measured < 1 s) and the prompt is ≥ GRACE_MS after the push, or
 * - a turn ENDED (`Stop`) after the push, and the prompt is ≥ GRACE_MS after that.
 *
 * Turn state comes from the hooks: `UserPromptSubmit` → in a turn, `Stop` → idle.
 * An interrupted turn fires no `Stop`; its entries are then never called missed —
 * the safe side (no false notice; `status` still counts them pending).
 *
 * A missed entry stays pending: it is redelivered on the next resume, and a read
 * tool that returns it confirms it. The notice is shown in full ONCE per entry,
 * then as a one-line count on later prompts while any noticed entry is still
 * pending (decided 2026-10-10: nothing redelivers while the socket stays up, so a
 * once-only notice could strand an entry for days).
 */
export const GRACE_MS = 2000;

/**
 * The tracker's memory is bounded on its own: `prompt()` prunes against the pending set, but
 * a session whose hooks never report never calls it, and every push would stay forever.
 * Past either limit the OLDEST push is forgotten — never judged missed, the safe side.
 */
export const MAX_TRACKED = 1000;
export const MAX_TRACKED_AGE_MS = 24 * 60 * 60 * 1000;

export interface MissedSplit<T> {
  /** Missed and never noticed: show in full. */
  fresh: T[];
  /** Noticed on an earlier prompt and still pending: show as a count. */
  outstanding: T[];
}

interface Push {
  at: number;
  idle: boolean;
}

export class MissedTracker<T extends { id: string }> {
  private inTurn = false;
  private lastStopAt = -Infinity;
  private readonly pushes = new Map<string, Push>();
  private readonly noticed = new Set<string>();

  /** The adapter pushed this entry to the host. A redelivery keeps the first push. */
  pushed(id: string, at: number): void {
    if (!this.pushes.has(id)) this.pushes.set(id, { at, idle: !this.inTurn });
    this.bound(at);
  }

  private bound(at: number): void {
    for (const [id, push] of this.pushes) {
      if (this.pushes.size <= MAX_TRACKED && at - push.at <= MAX_TRACKED_AGE_MS) break;
      this.settled(id);
    }
  }

  /** The entry left pending (confirmed, dismissed, or acked by a read tool). */
  settled(id: string): void {
    this.pushes.delete(id);
    this.noticed.delete(id);
  }

  /** Read-only, for `status`: entries a prompt found missed that are still pending. */
  missed(pending: readonly T[]): number {
    return pending.filter((e) => this.noticed.has(e.id)).length;
  }

  stopped(at: number): void {
    this.inTurn = false;
    this.lastStopAt = at;
  }

  /**
   * A `UserPromptSubmit` at `at`, AFTER its own entry (if any) was confirmed and
   * settled. `pending` is the adapter's current pending set.
   */
  prompt(pending: readonly T[], at: number): MissedSplit<T> {
    const fresh: T[] = [];
    const outstanding: T[] = [];
    // Forget entries that left pending by any other route (a read tool returned
    // them, a dismissal): a later redelivery is then a fresh push, judged on its
    // own turn — and the maps stay bounded by the pending set.
    const live = new Set(pending.map((e) => e.id));
    for (const id of this.pushes.keys()) if (!live.has(id)) this.settled(id);
    for (const entry of pending) {
      const push = this.pushes.get(entry.id);
      if (!push) continue;
      if (this.noticed.has(entry.id)) {
        outstanding.push(entry);
        continue;
      }
      const hadChance =
        (push.idle && at - push.at >= GRACE_MS) || (this.lastStopAt > push.at && at - this.lastStopAt >= GRACE_MS);
      if (hadChance) {
        fresh.push(entry);
        this.noticed.add(entry.id);
      }
    }
    this.inTurn = true;
    return { fresh, outstanding };
  }
}
