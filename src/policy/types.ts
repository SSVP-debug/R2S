// =============================================================================
// Policy Engine — types (Aug 31)
// =============================================================================
// The Policy Engine is a deterministic, rule-based authority layer that
// sits downstream of the AI Decision Agent. AI = advisor only. Policy =
// authority. Nothing here calls an AI provider, executes an action, or
// touches the repository — it is a pure function of its inputs.
// =============================================================================

import type { AgentDecision, RecoveryAction } from "../ai/types.js";

export interface MerchantPolicy {
  maxRetries: number;
  recoveryWindowDays: number;
  maxIncentivePercent: number;
  highValueThresholdMinor: number;
}

/** Reasonable illustrative defaults — not a product decision about what
 * every merchant should have, just a usable default for tests/local dev.
 * A real deployment would source this per-merchant. */
export const DEFAULT_MERCHANT_POLICY: MerchantPolicy = {
  maxRetries: 3,
  recoveryWindowDays: 7,
  maxIncentivePercent: 15,
  highValueThresholdMinor: 500000, // 5,000.00 INR, in paise
};

export type PolicyDecision = "ALLOW" | "MODIFY" | "BLOCK" | "ESCALATE";

export interface PolicyResult {
  decision: PolicyDecision;
  /** The action that is actually authorized to proceed, if any. Present
   * for ALLOW (echoes the AI's action) and MODIFY (the corrected action).
   * Absent for BLOCK/ESCALATE — nothing is authorized to proceed. */
  action?: RecoveryAction;
  /** Present only when decision === "MODIFY": the full corrected decision
   * (e.g. incentivePercent capped, or action changed to a safer one) that
   * should be used in place of the AI's original recommendation. */
  modifiedDecision?: AgentDecision;
  reason: string;
  appliedRules: string[];
}

export interface PolicyEvaluationInput {
  /** Payment amount in minor units. */
  paymentAmount: number;
  /** Number of retry attempts already made on this recovery case. */
  retryCount: number;
  /** Hours remaining until the recovery window closes. Null if there is no
   * open recovery case / no window applies. */
  windowRemainingHours: number | null;
  priorFailureCount: number;
  recommendation: AgentDecision;
  merchantPolicy: MerchantPolicy;
}
