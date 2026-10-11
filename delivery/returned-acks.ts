/**
 * Acks for entries a read tool RETURNED (RFC-027 D4), including the ones returned while
 * this process has no live Session (login or `connect` mid-flight, a Session being
 * replaced). `session?.ack(...)` there would drop the ack silently: the server would
 * redeliver an entry the model already read, and the missed tracker would have been told
 * it was settled. So the ids are held and handed to the NEXT Session the moment it
 * exists — `Session.ack` queues until the socket authenticates, and the server ignores
 * ids it does not owe, so this can neither lose a confirmation nor ack something that
 * was not returned. Bounded: past the cap the oldest are dropped, and the server
 * redelivers those (a duplicate, never a loss).
 *
 * Whose ids they are matters: a login as a DIFFERENT agent (or into another profile) between
 * the read and the next Session must not ack the old agent's ids against the new one. Each
 * held id is stamped with the profile and the agent it was read as (the agent may still be
 * unknown before the process ever authenticated — then only the profile is compared), and
 * only a Session of the same profile+agent receives it; the rest are dropped (a duplicate
 * later, never a wrong ack). A login or logout clears everything.
 */
export const HELD_ACKS_MAX = 1000;

export interface AckSink {
  ack(ids: string[], how: "model"): void;
}

/** Whose entries these were read as. `agentId` null: not known yet (nothing authenticated in this process). */
export interface AckOwner {
  profile: string;
  agentId: string | null;
}

export class ReturnedAcks {
  private readonly held = new Map<string, AckOwner>();

  /**
   * Ack `ids` now only if the Session that is current NOW is of the identity they were read as
   * (`owner`); otherwise — no Session, or a different profile/agent swapped in during the read —
   * hold them, stamped, for a Session that is.
   */
  confirm(ids: readonly string[], current: { session: AckSink | null; profile: string; agentId: string | null }, owner: AckOwner): void {
    if (ids.length === 0) return;
    const sameIdentity = current.profile === owner.profile && (owner.agentId === null || owner.agentId === current.agentId);
    if (current.session && sameIdentity) return current.session.ack([...ids], "model");
    for (const id of ids) {
      this.held.delete(id);
      this.held.set(id, owner);
    }
    while (this.held.size > HELD_ACKS_MAX) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  /** A Session authenticated as `now`: hand it what was read as that profile+agent; drop the rest. */
  flush(session: AckSink, now: { profile: string; agentId: string }): void {
    if (this.held.size === 0) return;
    const ids: string[] = [];
    for (const [id, o] of this.held) {
      if (o.profile === now.profile && (o.agentId === null || o.agentId === now.agentId)) ids.push(id);
    }
    this.held.clear();
    if (ids.length > 0) session.ack(ids, "model");
  }

  /** A login or logout: what was held belongs to a sign-in that is gone. */
  clear(): void {
    this.held.clear();
  }

  get size(): number {
    return this.held.size;
  }
}
