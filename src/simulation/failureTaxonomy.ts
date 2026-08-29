// =============================================================================
// Failure taxonomy
// =============================================================================
// The six failure categories required by the design freeze, plus the
// metadata the generator and ground-truth modules use to build realistic,
// behaviorally-correlated synthetic data.
//
// This module only describes categories and their *tendencies* — it never
// decides a specific payment's outcome. That happens in generator.ts (which
// category a payment gets) and groundTruth.ts (what the hidden ground truth
// is), both driven by the seeded RNG.
// =============================================================================

import type { FailureCategory, RiskProfile } from "../domain/types.js";
import { FAILURE_CATEGORIES } from "../domain/types.js";

export interface FailureCategoryProfile {
  category: FailureCategory;
  /** Base generation likelihood weight (relative, not a probability). */
  baseWeight: number;
  /** Baseline recovery probability before behavioral adjustments. */
  baseRecoveryProbability: number;
  /** Whether repeated retries meaningfully help this category at all. */
  retryable: boolean;
}

export const FAILURE_TAXONOMY: Record<FailureCategory, FailureCategoryProfile> = {
  temporary_bank_failure: {
    category: "temporary_bank_failure",
    baseWeight: 30,
    baseRecoveryProbability: 0.75,
    retryable: true,
  },
  insufficient_funds: {
    category: "insufficient_funds",
    baseWeight: 25,
    baseRecoveryProbability: 0.4,
    retryable: true,
  },
  authentication_failure: {
    category: "authentication_failure",
    baseWeight: 15,
    baseRecoveryProbability: 0.55,
    retryable: true,
  },
  invalid_instrument: {
    category: "invalid_instrument",
    baseWeight: 10,
    baseRecoveryProbability: 0.15,
    retryable: false,
  },
  repeated_failure: {
    category: "repeated_failure",
    baseWeight: 10,
    baseRecoveryProbability: 0.2,
    retryable: false,
  },
  unknown: {
    category: "unknown",
    baseWeight: 10,
    baseRecoveryProbability: 0.35,
    retryable: true,
  },
};

/** Behavioral correlation: how much a customer's risk profile shifts the
 * generation weight for each failure category. Multiplicative factor. */
export const RISK_PROFILE_CATEGORY_MULTIPLIER: Record<
  RiskProfile,
  Record<FailureCategory, number>
> = {
  low: {
    temporary_bank_failure: 1.0,
    insufficient_funds: 0.5,
    authentication_failure: 0.8,
    invalid_instrument: 0.6,
    repeated_failure: 0.4,
    unknown: 1.0,
  },
  medium: {
    temporary_bank_failure: 1.0,
    insufficient_funds: 1.0,
    authentication_failure: 1.0,
    invalid_instrument: 1.0,
    repeated_failure: 1.0,
    unknown: 1.0,
  },
  high: {
    temporary_bank_failure: 0.9,
    insufficient_funds: 2.2,
    authentication_failure: 1.3,
    invalid_instrument: 1.5,
    repeated_failure: 2.5,
    unknown: 1.0,
  },
};

export function weightedFailureCategories(
  riskProfile: RiskProfile,
): { category: FailureCategory; weight: number }[] {
  return FAILURE_CATEGORIES.map((category) => {
    const base = FAILURE_TAXONOMY[category].baseWeight;
    const multiplier = RISK_PROFILE_CATEGORY_MULTIPLIER[riskProfile][category];
    return { category, weight: base * multiplier };
  });
}
