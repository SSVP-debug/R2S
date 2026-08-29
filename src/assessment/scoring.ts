// =============================================================================
// Deterministic recovery scoring (Aug 30)
// =============================================================================
// Produces a 0..1 "recovery score" from RecoveryFeatures using a fixed,
// hand-authored heuristic — no ML, no AI/LLM, no randomness, no access to
// GroundTruth.
//
// IMPORTANT — evaluative independence from ground truth:
// The category-level priors below are a SEPARATE, independently authored
// table from src/simulation/failureTaxonomy.ts's baseRecoveryProbability.
// They deliberately use different numbers and a different risk-profile
// adjustment. This is intentional: src/simulation/groundTruth.ts computes
// the hidden "true" recovery probability (used only for evaluation and
// outcome simulation); this module computes what a recovery system could
// plausibly *estimate* from public, category-level domain knowledge alone.
// If this heuristic simply reproduced the ground-truth formula, comparing
// this score against ground truth later (to evaluate how good the
// assessment engine actually is) would be meaningless.
//
// This module never imports src/simulation/groundTruth.ts or
// src/simulation/failureTaxonomy.ts.
// =============================================================================

import type { RecoveryFeatures } from "./features.js";
import type { FailureCategory, RiskProfile } from "../domain/types.js";

export type ScoreBand = "low" | "medium" | "high";

/** Independently-authored, category-level heuristic prior — NOT derived
 * from or copied out of src/simulation/failureTaxonomy.ts. */
export const ASSESSMENT_CATEGORY_PRIOR: Record<FailureCategory, number> = {
  temporary_bank_failure: 0.7,
  authentication_failure: 0.5,
  unknown: 0.3,
  insufficient_funds: 0.35,
  repeated_failure: 0.15,
  invalid_instrument: 0.1,
};

/** Independently-authored risk adjustment — deliberately different
 * magnitude/shape from the ground-truth generator's adjustment. */
export const ASSESSMENT_RISK_ADJUSTMENT: Record<RiskProfile, number> = {
  low: 0.05,
  medium: 0,
  high: -0.1,
};

/** Multiplicative decay applied per prior failed attempt — repeated
 * failures on the same case make the engine less confident. */
const PRIOR_FAILURE_DECAY = 0.85;

export function computeRecoveryScore(features: RecoveryFeatures): number {
  // No open case, or the recovery window has already elapsed: nothing left
  // to recover.
  if (!features.hasOpenCase) return 0;
  if (features.windowRemainingHours !== null && features.windowRemainingHours <= 0) {
    return 0;
  }

  if (!features.failureCategory) {
    // Should not normally happen for a payment with an open recovery case,
    // but handle defensively rather than throwing mid-score.
    return 0;
  }

  const categoryPrior = ASSESSMENT_CATEGORY_PRIOR[features.failureCategory];
  const riskAdjustment = ASSESSMENT_RISK_ADJUSTMENT[features.riskProfile];
  const decay = Math.pow(PRIOR_FAILURE_DECAY, features.priorFailureCount);

  const raw = (categoryPrior + riskAdjustment) * decay;
  return clamp01(raw);
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 0.6) return "high";
  if (score >= 0.3) return "medium";
  return "low";
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
