// =============================================================================
// Deterministic ID generation
// =============================================================================
// IDs are derived from sequential counters, not crypto.randomUUID() or any
// other non-seedable source, so that full datasets (including IDs) are
// byte-for-byte reproducible given the same seed and generator version.
// =============================================================================

export function makeId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(6, "0")}`;
}

/** Small stateful counter factory, one per entity prefix, so callers don't
 * have to thread indices through the whole generator by hand. */
export class IdSequence {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const current = this.counters.get(prefix) ?? 0;
    const n = current + 1;
    this.counters.set(prefix, n);
    return makeId(prefix, n);
  }
}
