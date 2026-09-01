// =============================================================================
// Evaluation metrics — types (Sep 1)
// =============================================================================
// Minimal evaluation primitives. This is NOT the multi-strategy experiment
// harness (that's Sep 2) — just the raw metric calculations against a set
// of payments/attempts/policy results from one run (e.g. one merchant
// policy, one provider) so results can start being measured today.
// =============================================================================

import type { Payment, RecoveryAttempt } from "../domain/types.js";
import type { PolicyResult } from "../policy/types.js";

/** The minimal per-payment record the metrics module needs. Callers
 * assemble this from repository data + orchestration results — this
 * module itself never touches the repository. */
export interface EvaluationRecord {
  payment: Payment;
  attempts: RecoveryAttempt[];
  policyResult: PolicyResult | null;
}

export interface RecoveryMetrics {
  eligibleFailedPayments: number;
  recoveredPayments: number;
  /** recoveredPayments / eligibleFailedPayments. 0 if eligibleFailedPayments is 0. */
  recoveryRate: number;
  /** Sum of `amount` for every recovered payment, in minor units. */
  recoveredRevenue: number;
  /** Total count of RecoveryAttempt rows with status !== "pending" across
   * all eligible payments (i.e. attempts that were actually executed). */
  recoveryAttempts: number;
  blockedRecommendations: number;
  escalationCount: number;
  /** recoveredRevenue / recoveryAttempts. 0 if recoveryAttempts is 0. */
  recoveryEfficiency: number;
}
