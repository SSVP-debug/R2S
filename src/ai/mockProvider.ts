// =============================================================================
// MockAIProvider (Aug 31)
// =============================================================================
// A deterministic stand-in AIProvider, for tests and local development. It
// is NOT an AI/LLM — it is a pure rule-based function of its input, used so
// the rest of the pipeline (decision agent, policy engine) can be tested
// without any external service. Real provider selection is a separate,
// later milestone.
// =============================================================================

import type { AIProvider } from "./provider.js";
import type { AgentDecision, AgentDecisionRequest } from "./types.js";

const DEFAULT_RETRY_DELAY_HOURS = 24;
const DEFAULT_INCENTIVE_PERCENT = 10;

export class MockAIProvider implements AIProvider {
  async generateDecision(request: AgentDecisionRequest): Promise<AgentDecision> {
    const top = [...request.candidateActions].sort((a, b) => a.priority - b.priority)[0];

    if (!top) {
      // Defensive: should not happen (candidateActions is validated
      // non-empty upstream), but the safe answer is always available.
      return {
        action: "STOP",
        confidence: 0,
        reasoning: "No candidate actions were supplied; stopping is the safe default.",
      };
    }

    const confidence = clamp01(request.assessmentSummary.score);
    const reasoning =
      `Selected ${top.action} (highest-priority supplied candidate). ` +
      `Rationale: ${top.rationale} Recovery score ${request.assessmentSummary.score.toFixed(2)} ` +
      `(${request.assessmentSummary.scoreBand}), ${request.recoveryHistory.priorFailureCount} prior failure(s).`;

    const decision: AgentDecision = { action: top.action, confidence, reasoning };

    if (top.action === "RETRY_LATER") {
      decision.delayHours = DEFAULT_RETRY_DELAY_HOURS;
    }
    if (top.action === "OFFER_INCENTIVE") {
      decision.incentivePercent = Math.min(
        DEFAULT_INCENTIVE_PERCENT,
        request.merchantPolicy.maxIncentivePercent,
      );
    }

    return decision;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
