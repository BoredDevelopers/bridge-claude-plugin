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
  }

  /** The entry left pending (confirmed, dismissed, or acked by a read tool). */
  settled(id: string): void {
    this.pushes.delete(id);
    this.noticed.delete(id);
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
