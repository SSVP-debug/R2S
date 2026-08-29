// =============================================================================
// Baseline recovery strategy: simple deterministic retry
// =============================================================================
// This is intentionally "dumb" — it does NOT look at ground truth, does NOT
// use any ML/AI, and does NOT adapt based on failure category beyond what's
// already visible in agent-facing data. It exists as (a) the Aug 29
// fallback recovery behavior and (b) the baseline that a future AI agent
// will be compared against. It only ever sees agent-facing information
// (attempt count, elapsed time) — never ground truth.
// =============================================================================

import type { RecoveryPolicy } from "../domain/types.js";

export const BASELINE_RETRY_POLICY: RecoveryPolicy = {
  id: "policy_baseline_001",
  name: "baseline_deterministic_retry",
  maxRetries: 3,
  // Hours after the case opens at which each retry is attempted.
  retryIntervalHours: [1, 24, 72],
  recoveryWindowDays: 7,
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
};

export type BaselineDecision =
  | { action: "retry_now"; attemptNumber: number }
  | { action: "wait"; nextRetryAt: Date }
  | { action: "stop_max_retries_reached" }
  | { action: "stop_window_expired" };

/**
 * Deterministic decision function for the baseline strategy.
 *
 * @param attemptsMade  number of retry attempts already made for this case
 * @param caseOpenedAt  when the RecoveryCase was opened
 * @param now           current simulated time
 * @param policy        retry policy to apply (defaults to the baseline policy)
 */
export function decideBaselineAction(
  attemptsMade: number,
  caseOpenedAt: Date,
  now: Date,
  policy: RecoveryPolicy = BASELINE_RETRY_POLICY,
): BaselineDecision {
  const windowEndsAt = new Date(
    caseOpenedAt.getTime() + policy.recoveryWindowDays * 24 * 60 * 60 * 1000,
  );

  if (now.getTime() > windowEndsAt.getTime()) {
    return { action: "stop_window_expired" };
  }

  if (attemptsMade >= policy.maxRetries) {
    return { action: "stop_max_retries_reached" };
  }

  const nextAttemptNumber = attemptsMade + 1;
  const offsetHours = policy.retryIntervalHours[attemptsMade];
  if (offsetHours === undefined) {
    // Defensive: policy misconfigured (fewer intervals than maxRetries).
    return { action: "stop_max_retries_reached" };
  }

  const nextRetryAt = new Date(
    caseOpenedAt.getTime() + offsetHours * 60 * 60 * 1000,
  );

  if (now.getTime() >= nextRetryAt.getTime()) {
    return { action: "retry_now", attemptNumber: nextAttemptNumber };
  }

  return { action: "wait", nextRetryAt };
}

export function recoveryWindowEndsAt(
  caseOpenedAt: Date,
  policy: RecoveryPolicy = BASELINE_RETRY_POLICY,
): Date {
  return new Date(
    caseOpenedAt.getTime() + policy.recoveryWindowDays * 24 * 60 * 60 * 1000,
  );
}
