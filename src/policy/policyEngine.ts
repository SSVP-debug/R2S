// =============================================================================
// Policy Engine (Aug 31)
// =============================================================================
// Deterministic, rule-based authority. Runs every rule in rules.ts, then
// picks the highest-severity outcome among the ones that fired
// (BLOCK > ESCALATE > MODIFY > ALLOW). The AI's recommendation can never
// override these rules — this module has no knowledge of "the AI" at all,
// only of an AgentDecision value it's evaluating.
//
// Pure function: same PolicyEvaluationInput always produces the same
// PolicyResult.
// =============================================================================

import { ALL_POLICY_RULES, type RuleOutcome } from "./rules.js";
import type { PolicyDecision, PolicyEvaluationInput, PolicyResult } from "./types.js";

const SEVERITY: Record<PolicyDecision, number> = {
  BLOCK: 3,
  ESCALATE: 2,
  MODIFY: 1,
  ALLOW: 0,
};

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyResult {
  const fired: RuleOutcome[] = [];
  for (const rule of ALL_POLICY_RULES) {
    const outcome = rule(input);
    if (outcome) fired.push(outcome);
  }

  if (fired.length === 0) {
    return {
      decision: "ALLOW",
      action: input.recommendation.action,
      reason: "No policy rules were triggered; AI recommendation accepted as-is.",
      appliedRules: [],
    };
  }

  const winner = fired.reduce((best, current) =>
    SEVERITY[current.decision] > SEVERITY[best.decision] ? current : best,
  );

  return {
    decision: winner.decision,
    action:
      winner.decision === "MODIFY"
        ? winner.modifiedDecision?.action
        : winner.decision === "ALLOW"
          ? input.recommendation.action
          : undefined,
    modifiedDecision: winner.decision === "MODIFY" ? winner.modifiedDecision : undefined,
    reason: winner.reason,
    appliedRules: fired.map((f) => f.ruleName),
  };
}
