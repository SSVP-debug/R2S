// =============================================================================
// Feature extraction (Aug 30)
// =============================================================================
// Derives a flat, structured set of features from an AgentPaymentContext.
// Input is exclusively AgentPaymentContext — the agent-facing shape from
// Day 1 that structurally cannot contain ground truth (see
// src/domain/schemas.ts::agentPaymentContextSchema). This module has no
// import of GroundTruth or anything from src/simulation/groundTruth.ts.
//
// `now` is passed in explicitly (never read from the wall clock) so
// feature extraction — and everything downstream of it — stays
// deterministic and testable.
// =============================================================================

import type { AgentPaymentContext } from "../domain/schemas.js";
import type {
  FailureCategory,
  MerchantCategory,
  RecoveryCaseStatus,
  RiskProfile,
} from "../domain/types.js";

export interface RecoveryFeatures {
  paymentId: string;
  failureCategory: FailureCategory | null;
  riskProfile: RiskProfile;
  merchantCategory: MerchantCategory;

  hasOpenCase: boolean;
  recoveryCaseStatus: RecoveryCaseStatus | null;

  /** Number of retry attempts already made for this case. */
  attemptsMade: number;
  priorFailureCount: number;
  priorSuccessCount: number;
  priorBlockedCount: number;

  /** Hours remaining until the recovery window closes, relative to `now`.
   * Null if there is no recovery case. Can be negative if already expired. */
  windowRemainingHours: number | null;

  /** Hours elapsed since the recovery case was opened. Null if no case. */
  hoursSinceCaseOpened: number | null;
}

export function extractFeatures(
  context: AgentPaymentContext,
  now: Date,
): RecoveryFeatures {
  const { recoveryCase, priorAttempts } = context;

  const priorFailureCount = priorAttempts.filter((a) => a.outcome === "failure").length;
  const priorSuccessCount = priorAttempts.filter((a) => a.outcome === "success").length;
  const priorBlockedCount = priorAttempts.filter((a) => a.outcome === "blocked").length;

  const windowRemainingHours = recoveryCase
    ? (recoveryCase.recoveryWindowEndsAt.getTime() - now.getTime()) / (60 * 60 * 1000)
    : null;

  const hoursSinceCaseOpened = recoveryCase
    ? (now.getTime() - recoveryCase.openedAt.getTime()) / (60 * 60 * 1000)
    : null;

  return {
    paymentId: context.paymentId,
    failureCategory: context.failureCategory,
    riskProfile: context.customer.riskProfile,
    merchantCategory: context.merchant.category,
    hasOpenCase: recoveryCase !== null,
    recoveryCaseStatus: recoveryCase ? recoveryCase.status : null,
    attemptsMade: priorAttempts.length,
    priorFailureCount,
    priorSuccessCount,
    priorBlockedCount,
    windowRemainingHours,
    hoursSinceCaseOpened,
  };
}
