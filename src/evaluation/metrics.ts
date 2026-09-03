// =============================================================================
// Evaluation metrics (Sep 1)
// =============================================================================
// Pure functions over an array of EvaluationRecord. No repository access,
// no AI, no ground truth (a Payment's `amount`/`status` and a
// RecoveryAttempt's `outcome` are already agent-facing-safe fields — see
// src/domain/types.ts — nothing here reads GroundTruth).
//
// METRIC DEFINITIONS (per Sep 1 spec, item 15):
//
//   eligible failed payments := count of payments with status !== "created"
//     (i.e. every payment that actually failed and entered the recovery
//     pipeline — "created" doubles as the terminal "succeeded" status for
//     payments that never failed at all; see stateMachine.ts).
//
//   recovered payments := count of eligible payments with status === "recovered"
//
//   recovery rate := recovered payments / eligible failed payments
//     (0 when eligible failed payments is 0 — no division by zero)
//
//   recovered revenue := sum of `amount` (minor units) over recovered payments
//
//   recovery attempts := count of RecoveryAttempt rows with outcome !== "pending"
//     across all eligible payments (i.e. attempts that were actually
//     executed, whether they succeeded or failed — a still-"pending"
//     attempt hasn't happened yet and shouldn't be counted as an
//     executed attempt)
//
//   blocked recommendations := count of policy results with decision === "BLOCK"
//
//   escalation count := count of policy results with decision === "ESCALATE"
//
//   recovery efficiency := recovered revenue / recovery attempts
//     (0 when recovery attempts is 0 — no division by zero)
//     NOTE: this is a pure output/input ratio (revenue recovered per
//     executed attempt) — it is NOT a financial cost/ROI figure. No cost
//     model (attempt cost, infrastructure cost, etc.) is assumed or
//     invented here, per explicit scope instruction.
// =============================================================================

import type { EvaluationRecord, RecoveryMetrics } from "./types.js";

// Exported (Sep 2, additive) so the multi-strategy Sep 2 metrics module
// (src/evaluation/strategyMetrics.ts) can reuse the exact same
// zero-denominator convention rather than redefining it.
export function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function computeRecoveryMetrics(records: EvaluationRecord[]): RecoveryMetrics {
  const eligible = records.filter((r) => r.payment.status !== "created");

  const eligibleFailedPayments = eligible.length;
  const recoveredPayments = eligible.filter((r) => r.payment.status === "recovered").length;

  const recoveredRevenue = eligible
    .filter((r) => r.payment.status === "recovered")
    .reduce((sum, r) => sum + r.payment.amount, 0);

  const recoveryAttempts = eligible.reduce(
    (sum, r) => sum + r.attempts.filter((a) => a.outcome !== "pending").length,
    0,
  );

  const blockedRecommendations = records.filter(
    (r) => r.policyResult?.decision === "BLOCK",
  ).length;

  const escalationCount = records.filter((r) => r.policyResult?.decision === "ESCALATE").length;

  return {
    eligibleFailedPayments,
    recoveredPayments,
    recoveryRate: safeDivide(recoveredPayments, eligibleFailedPayments),
    recoveredRevenue,
    recoveryAttempts,
    blockedRecommendations,
    escalationCount,
    recoveryEfficiency: safeDivide(recoveredRevenue, recoveryAttempts),
  };
}
