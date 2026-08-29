// =============================================================================
// Recovery attempt outcome simulation
// =============================================================================
// This module is the ONLY consumer of GroundTruth outside of tests and the
// seed script. It uses the hidden recoveryProbability to decide whether a
// given retry attempt succeeds — but its return type (AttemptOutcome) never
// includes any ground-truth field. Callers only ever learn success/failure
// and the (possibly partial) amount recovered, exactly like a real payment
// gateway callback would report.
// =============================================================================

import type { Rng } from "../simulation/rng.js";
import type { GroundTruth } from "../domain/types.js";

export interface AttemptOutcome {
  success: boolean;
  amountRecovered: number;
}

/**
 * Simulates the outcome of a single recovery attempt.
 *
 * Internally reads `groundTruth.recoveryProbability`, degrading it slightly
 * on each successive attempt (diminishing returns — real customers don't
 * become more likely to pay just because we retried more), then draws a
 * single deterministic random number from `rng` to decide success.
 *
 * The returned object intentionally has no `recoveryProbability`,
 * `bestAction`, or `recoverable` field — only what a real gateway callback
 * would tell you.
 */
export function simulateAttemptOutcome(
  rng: Rng,
  groundTruth: GroundTruth,
  attemptNumber: number,
  paymentAmount: number,
): AttemptOutcome {
  if (!groundTruth.recoverable) {
    return { success: false, amountRecovered: 0 };
  }

  // Diminishing returns per additional attempt.
  const decay = Math.pow(0.8, Math.max(0, attemptNumber - 1));
  const effectiveProbability = Math.min(
    0.98,
    Math.max(0.01, groundTruth.recoveryProbability * decay),
  );

  const success = rng.next() < effectiveProbability;

  if (!success) {
    return { success: false, amountRecovered: 0 };
  }

  // On success, recover the full payment amount (partial recovery is out of
  // scope for the Aug 29 milestone). Capped defensively at the ground-truth
  // recoverable amount and the actual payment amount.
  const amountRecovered = Math.min(groundTruth.recoveredAmount, paymentAmount);
  return { success: true, amountRecovered };
}
