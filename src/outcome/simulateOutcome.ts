// =============================================================================
// Recovery attempt outcome simulation (action-conditioned, Sep 1 correction)
// =============================================================================
// This module is the ONLY consumer of GroundTruth outside of tests and the
// seed script. It uses the hidden recoveryProbability to decide whether a
// given retry attempt succeeds — but its return type (AttemptOutcome) never
// includes any ground-truth field. Callers only ever learn success/failure
// and the (possibly partial) amount recovered, exactly like a real payment
// gateway callback would report.
//
// SEP 1 CORRECTION (Issue 1): the model now varies by the concrete
// RecoveryAction actually selected (RETRY_NOW, RETRY_LATER,
// SEND_PAYMENT_LINK, SEND_REMINDER, OFFER_INCENTIVE, ESCALATE, STOP) —
// previously every action was treated identically, which made it
// impossible to ever measure whether smarter action selection improves
// recovery. `RecoveryAction` is imported (type-only) from src/ai/types.ts
// rather than re-declared, to avoid a second copy of the same vocabulary
// drifting out of sync; this is the vocabulary, not any AI/decision logic,
// so no runtime coupling to the AI layer is introduced.
//
// BACKWARD COMPATIBILITY WITH AUG 29: ACTION_EFFECTIVENESS["RETRY_NOW"] is
// defined as exactly 1.0 (neutral), which makes the action-conditioned
// formula for RETRY_NOW numerically IDENTICAL to the pre-correction
// formula. Aug 29's baseline simulation (src/simulation/runSimulation.ts)
// always calls this function with selectedAction: "RETRY_NOW" (the
// baseline strategy's only concept of "retry"), so its outcomes,
// reproducibility, and existing statistical tests are unaffected byte-for-
// byte — same rng draw sequence, same effective probability formula.
//
// These per-action multipliers are CLEARLY-DOCUMENTED SYNTHETIC SIMULATION
// PARAMETERS, not real-world Razorpay or industry statistics. They exist
// only to give the simulated environment a measurable difference between
// action choices, so a future evaluation harness (Sep 2+) can meaningfully
// score "did picking a better action improve recovery."
// =============================================================================

import type { Rng } from "../simulation/rng.js";
import type { GroundTruth } from "../domain/types.js";
import type { RecoveryAction } from "../ai/types.js";

export interface AttemptOutcome {
  success: boolean;
  amountRecovered: number;
}

/** Synthetic, documented effectiveness multiplier per action, applied on
 * top of the ground-truth recovery probability. 1.0 = neutral (no change
 * from the pre-correction, action-agnostic model). These are illustrative
 * simulation parameters, not real payment-industry statistics:
 *   - RETRY_NOW:          1.00  (reference/baseline — matches Aug 29 exactly)
 *   - RETRY_LATER:        0.90  (delay trades a little urgency for patience)
 *   - SEND_PAYMENT_LINK:  1.05  (an explicit fresh payment path helps slightly)
 *   - SEND_REMINDER:      0.85  (a passive nudge alone is the weakest tactic)
 *   - OFFER_INCENTIVE:    1.15  (a concrete incentive meaningfully helps)
 * ESCALATE and STOP are not genuine recovery attempts at all — see
 * `simulateAttemptOutcome`'s early return below — so they have no
 * multiplier entry. */
export const ACTION_EFFECTIVENESS: Record<
  Exclude<RecoveryAction, "ESCALATE" | "STOP">,
  number
> = {
  RETRY_NOW: 1.0,
  RETRY_LATER: 0.9,
  SEND_PAYMENT_LINK: 1.05,
  SEND_REMINDER: 0.85,
  OFFER_INCENTIVE: 1.15,
};

const NON_RECOVERY_ACTIONS: ReadonlySet<RecoveryAction> = new Set(["ESCALATE", "STOP"]);

/**
 * Simulates the outcome of a single recovery attempt for the given
 * `selectedAction`.
 *
 * Internally reads `groundTruth.recoveryProbability`, applies (a)
 * diminishing returns per additional attempt and (b) the selected
 * action's synthetic effectiveness multiplier, then draws a single
 * deterministic random number from `rng` to decide success.
 *
 * Returns `null` for ESCALATE and STOP: those actions do not execute
 * payment recovery at all (see src/execution/recoveryExecutor.ts, which
 * marks them "skipped" rather than "executed"), so there is no recovery
 * attempt outcome to simulate — calling this for either is a caller
 * error the type system now makes easy to avoid, but is handled
 * gracefully rather than thrown, since ESCALATE/STOP requests could
 * still legitimately reach here from defensive/future call sites.
 *
 * The returned object intentionally has no `recoveryProbability`,
 * `bestAction`, or `recoverable` field — only what a real gateway callback
 * would tell you.
 */
export function simulateAttemptOutcome(
  rng: Rng,
  groundTruth: GroundTruth,
  selectedAction: RecoveryAction,
  attemptNumber: number,
  paymentAmount: number,
): AttemptOutcome | null {
  if (NON_RECOVERY_ACTIONS.has(selectedAction)) {
    return null;
  }

  if (!groundTruth.recoverable) {
    return { success: false, amountRecovered: 0 };
  }

  // Diminishing returns per additional attempt (unchanged from Aug 29).
  const decay = Math.pow(0.8, Math.max(0, attemptNumber - 1));

  const actionMultiplier =
    ACTION_EFFECTIVENESS[selectedAction as Exclude<RecoveryAction, "ESCALATE" | "STOP">];

  const effectiveProbability = Math.min(
    0.98,
    Math.max(0.01, groundTruth.recoveryProbability * decay * actionMultiplier),
  );

  const success = rng.next() < effectiveProbability;

  if (!success) {
    return { success: false, amountRecovered: 0 };
  }

  // On success, recover the full payment amount (partial recovery is out of
  // scope). Capped defensively at the ground-truth recoverable amount and
  // the actual payment amount.
  const amountRecovered = Math.min(groundTruth.recoveredAmount, paymentAmount);
  return { success: true, amountRecovered };
}

/**
 * Pure helper exposing the effective probability calculation directly
 * (without drawing from the RNG), so action-conditioning can be tested
 * deterministically without depending on any single random draw. Returns
 * null for ESCALATE/STOP, matching simulateAttemptOutcome's behavior.
 */
export function computeEffectiveProbability(
  groundTruth: GroundTruth,
  selectedAction: RecoveryAction,
  attemptNumber: number,
): number | null {
  if (NON_RECOVERY_ACTIONS.has(selectedAction)) return null;
  if (!groundTruth.recoverable) return 0;

  const decay = Math.pow(0.8, Math.max(0, attemptNumber - 1));
  const actionMultiplier =
    ACTION_EFFECTIVENESS[selectedAction as Exclude<RecoveryAction, "ESCALATE" | "STOP">];

  return Math.min(0.98, Math.max(0.01, groundTruth.recoveryProbability * decay * actionMultiplier));
}
