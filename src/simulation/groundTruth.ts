// =============================================================================
// Hidden ground truth (EVALUATION-ONLY)
// =============================================================================
// This is the ONLY module in R2S allowed to compute ground-truth fields:
// recoverability, ground-truth recovery probability, ground-truth best
// action, and ground-truth recovered amount.
//
// CRITICAL ISOLATION RULE:
// Nothing in src/domain/agentContext.ts or src/domain/schemas.ts's
// agentPaymentContextSchema may import from this file. This file may be
// imported by src/outcome/simulateOutcome.ts (to drive outcome simulation)
// and by src/seed.ts (to persist GroundTruth rows into their own isolated
// table), and by tests — never by anything agent-facing.
// =============================================================================

import type { Rng } from "./rng.js";
import { FAILURE_TAXONOMY } from "./failureTaxonomy.js";
import type {
  BestAction,
  Customer,
  FailureCategory,
  GroundTruth,
  Payment,
  RiskProfile,
} from "../domain/types.js";

/** Risk-profile adjustment applied on top of the failure category's base
 * recovery probability. Higher risk customers are somewhat harder to
 * recover, even for the same failure category. */
const RISK_PROFILE_RECOVERY_ADJUSTMENT: Record<RiskProfile, number> = {
  low: 0.1,
  medium: 0.0,
  high: -0.15,
};

const BEST_ACTION_BY_CATEGORY: Record<FailureCategory, BestAction> = {
  temporary_bank_failure: "retry_immediate",
  insufficient_funds: "retry_delayed",
  authentication_failure: "prompt_instrument_update",
  invalid_instrument: "prompt_instrument_update",
  repeated_failure: "escalate_to_human",
  unknown: "retry_delayed",
};

function clampProbability(p: number): number {
  return Math.min(0.98, Math.max(0.02, p));
}

/**
 * Computes the hidden ground truth for a single failed payment.
 * Deterministic given the same rng state, payment, and customer.
 *
 * Only meaningful for payments with status "failed" (i.e. a non-null
 * failureCategory) — the caller is expected to only compute this for
 * payments that actually failed.
 */
export function computeGroundTruth(
  rng: Rng,
  id: string,
  payment: Payment,
  customer: Customer,
): GroundTruth {
  if (!payment.failureCategory) {
    throw new Error(
      `computeGroundTruth(): payment ${payment.id} has no failureCategory`,
    );
  }

  const profile = FAILURE_TAXONOMY[payment.failureCategory];
  const adjustment = RISK_PROFILE_RECOVERY_ADJUSTMENT[customer.riskProfile];

  // Small amount of per-payment noise so not every payment in the same
  // category/risk bucket has an identical probability — still fully
  // deterministic given the seeded rng.
  const noise = rng.float(-0.07, 0.07);

  const recoveryProbability = clampProbability(
    profile.baseRecoveryProbability + adjustment + noise,
  );

  // A payment is considered "recoverable" ground truth if its probability
  // clears a threshold AND the category is fundamentally retryable.
  const recoverable = profile.retryable && recoveryProbability >= 0.3;

  const bestAction: BestAction = recoverable
    ? BEST_ACTION_BY_CATEGORY[payment.failureCategory]
    : "no_action";

  // Ground-truth recovered amount: full amount if recoverable, otherwise 0.
  // (Partial recovery is out of scope for the Aug 29 milestone.)
  const recoveredAmount = recoverable ? payment.amount : 0;

  return {
    id,
    paymentId: payment.id,
    recoverable,
    recoveryProbability,
    bestAction,
    recoveredAmount,
    simulationRunId: payment.simulationRunId,
  };
}
