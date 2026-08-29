// =============================================================================
// Policy rules (Aug 31)
// =============================================================================
// Each rule is a pure function: (PolicyEvaluationInput) -> RuleOutcome | null.
// `null` means the rule did not fire. The Policy Engine (policyEngine.ts)
// runs all rules and picks the highest-severity outcome among the ones that
// fired (BLOCK > ESCALATE > MODIFY > ALLOW), so rules don't need to know
// about each other's precedence — severity ordering handles it.
// =============================================================================

import type { AgentDecision, RecoveryAction } from "../ai/types.js";
import type { PolicyDecision, PolicyEvaluationInput } from "./types.js";

export interface RuleOutcome {
  ruleName: string;
  decision: PolicyDecision;
  reason: string;
  /** Present only for MODIFY outcomes: the corrected decision. */
  modifiedDecision?: AgentDecision;
}

const RECOVERY_ATTEMPT_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  "RETRY_NOW",
  "RETRY_LATER",
  "SEND_PAYMENT_LINK",
  "SEND_REMINDER",
  "OFFER_INCENTIVE",
]);

/** (a) Retry limit: if retryCount >= maxRetries, RETRY_NOW/RETRY_LATER must
 * be blocked. */
export function retryLimitRule(input: PolicyEvaluationInput): RuleOutcome | null {
  const { action } = input.recommendation;
  if (action !== "RETRY_NOW" && action !== "RETRY_LATER") return null;
  if (input.retryCount < input.merchantPolicy.maxRetries) return null;

  return {
    ruleName: "retry_limit_reached",
    decision: "BLOCK",
    reason: `Retry count (${input.retryCount}) has reached the merchant's max retries (${input.merchantPolicy.maxRetries}); ${action} is blocked.`,
  };
}

/** (b) Recovery window: if the recovery window has expired, further
 * recovery-attempt actions must be blocked. ESCALATE/STOP are unaffected
 * (they aren't attempts to recover the payment). */
export function recoveryWindowRule(input: PolicyEvaluationInput): RuleOutcome | null {
  if (input.windowRemainingHours === null) return null;
  if (input.windowRemainingHours > 0) return null;
  if (!RECOVERY_ATTEMPT_ACTIONS.has(input.recommendation.action)) return null;

  return {
    ruleName: "recovery_window_expired",
    decision: "BLOCK",
    reason: `Recovery window has expired (${input.windowRemainingHours.toFixed(1)}h remaining); ${input.recommendation.action} is blocked.`,
  };
}

/** (c) Incentive ceiling: if the requested incentive exceeds the policy
 * maximum, modify it down to the maximum. If it's wildly excessive (more
 * than double the ceiling), treat it as an unsafe recommendation and block
 * it outright rather than silently "fixing" it. */
export function incentiveCeilingRule(input: PolicyEvaluationInput): RuleOutcome | null {
  if (input.recommendation.action !== "OFFER_INCENTIVE") return null;

  const requested = input.recommendation.incentivePercent ?? 0;
  const ceiling = input.merchantPolicy.maxIncentivePercent;
  if (requested <= ceiling) return null;

  if (requested > ceiling * 2) {
    return {
      ruleName: "incentive_ceiling_exceeded_severely",
      decision: "BLOCK",
      reason: `Requested incentive (${requested}%) is more than double the policy maximum (${ceiling}%); blocked rather than modified.`,
    };
  }

  return {
    ruleName: "incentive_ceiling_exceeded",
    decision: "MODIFY",
    reason: `Requested incentive (${requested}%) exceeds the policy maximum (${ceiling}%); capped to ${ceiling}%.`,
    modifiedDecision: { ...input.recommendation, incentivePercent: ceiling },
  };
}

/** (d) High-value incentive: incentive offers on high-value payments always
 * require human escalation, regardless of the incentive size. */
export function highValueIncentiveRule(input: PolicyEvaluationInput): RuleOutcome | null {
  if (input.recommendation.action !== "OFFER_INCENTIVE") return null;
  if (input.paymentAmount < input.merchantPolicy.highValueThresholdMinor) return null;

  return {
    ruleName: "high_value_incentive_escalation",
    decision: "ESCALATE",
    reason: `Payment amount (${input.paymentAmount}) meets or exceeds the high-value threshold (${input.merchantPolicy.highValueThresholdMinor}); incentive offers on high-value payments require human sign-off.`,
  };
}

/** (e) Repeated failure: prevent unsafe repeated *immediate* retries. If
 * there have already been 2+ failures on this case and the AI recommends
 * an immediate retry, soften it to a delayed retry instead. (If the
 * retry-limit is also already reached, retryLimitRule's BLOCK outranks
 * this MODIFY via severity ordering in the engine.) */
export function repeatedFailureRule(input: PolicyEvaluationInput): RuleOutcome | null {
  if (input.recommendation.action !== "RETRY_NOW") return null;
  if (input.priorFailureCount < 2) return null;

  return {
    ruleName: "repeated_failure_cooldown",
    decision: "MODIFY",
    reason: `${input.priorFailureCount} prior failed attempts on this case; an immediate retry is unsafe. Modified to a delayed retry instead.`,
    modifiedDecision: {
      ...input.recommendation,
      action: "RETRY_LATER",
      delayHours: input.recommendation.delayHours ?? 24,
      incentivePercent: undefined,
    },
  };
}

export const ALL_POLICY_RULES = [
  recoveryWindowRule,
  retryLimitRule,
  incentiveCeilingRule,
  highValueIncentiveRule,
  repeatedFailureRule,
] as const;
