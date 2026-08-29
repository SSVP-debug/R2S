// =============================================================================
// Prompt / request template (Aug 31)
// =============================================================================
// The system instruction and user-prompt serialization a REAL provider
// would use. Kept entirely separate from provider implementations
// (MockAIProvider does not use this — it's rule-based) so that plugging in
// a real free/local provider later is just "read this template, call the
// model, parse with agentDecisionSchema" — no prompt-design work needed at
// that point.
//
// Nothing here calls any external service. This module only builds strings.
// =============================================================================

import type { AgentDecisionRequest } from "./types.js";

export const AI_SYSTEM_INSTRUCTION = `You are a payment recovery decision advisor for R2S (Revenue Recovery System).

Your job:
- Select EXACTLY ONE action from the candidate actions supplied in the request. You may never propose an action that is not in the supplied candidate list.
- Provide a confidence score between 0 and 1.
- Provide concise, evidence-based reasoning that only references information actually present in the request.
- Respect all supplied constraints (merchant policy limits, recovery window, retry history).
- Never invent facts about the payment, customer, or merchant that are not present in the request.
- Never use, request, or assume access to any hidden evaluation information (ground truth, true recovery probability, or "correct" answer). No such information is ever provided to you, and none exists in this request.
- Never execute any action yourself. Your output is a recommendation only; a separate, deterministic policy engine has final authority over what actually happens.
- If the available evidence is insufficient to make a confident recommendation, prefer ESCALATE or STOP over guessing.

You must respond with a single structured decision containing: action, confidence, reasoning, and (only when relevant) delayHours or incentivePercent.`;

/**
 * Serializes an AgentDecisionRequest into a deterministic, human-readable
 * prompt body for a real LLM provider. Pure string construction — no
 * network calls, no side effects.
 */
export function buildUserPrompt(request: AgentDecisionRequest): string {
  const lines: string[] = [];

  lines.push(`Payment ID: ${request.paymentId}`);
  lines.push(`Amount: ${request.context.amount} ${request.context.currency} (minor units)`);
  lines.push(`Failure category: ${request.context.failureCategory ?? "none"}`);
  lines.push(`Customer risk profile: ${request.context.customer.riskProfile}`);
  lines.push(`Merchant category: ${request.context.merchant.category}`);
  lines.push("");

  lines.push(`Recovery assessment: score=${request.assessmentSummary.score.toFixed(2)} band=${request.assessmentSummary.scoreBand}`);
  lines.push(
    `Recovery history: attemptsMade=${request.recoveryHistory.attemptsMade}, ` +
      `priorFailures=${request.recoveryHistory.priorFailureCount}, ` +
      `priorSuccesses=${request.recoveryHistory.priorSuccessCount}, ` +
      `priorBlocked=${request.recoveryHistory.priorBlockedCount}`,
  );
  lines.push("");

  lines.push("Candidate actions (choose exactly one of these):");
  for (const c of [...request.candidateActions].sort((a, b) => a.priority - b.priority)) {
    lines.push(`  [priority ${c.priority}] ${c.action} — ${c.rationale}`);
  }
  lines.push("");

  lines.push("Merchant policy constraints:");
  lines.push(`  maxRetries: ${request.merchantPolicy.maxRetries}`);
  lines.push(`  recoveryWindowDays: ${request.merchantPolicy.recoveryWindowDays}`);
  lines.push(`  maxIncentivePercent: ${request.merchantPolicy.maxIncentivePercent}`);
  lines.push(`  highValueThresholdMinor: ${request.merchantPolicy.highValueThresholdMinor}`);

  if (request.context.recoveryCase) {
    lines.push("");
    lines.push(`Recovery case status: ${request.context.recoveryCase.status}`);
    lines.push(`Recovery window ends at: ${request.context.recoveryCase.recoveryWindowEndsAt.toISOString()}`);
  }

  return lines.join("\n");
}
