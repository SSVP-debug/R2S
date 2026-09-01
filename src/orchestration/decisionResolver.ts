// =============================================================================
// Decision resolver (Sep 1)
// =============================================================================
// Thin coordination wrapper: builds the agent-safe request (existing
// src/ai/requestBuilder.ts, unmodified), calls the existing decision agent
// (src/ai/decisionAgent.ts::resolveRecoveryDecision, unmodified), and
// relabels its `source` field ("deterministic"|"provider"|"fallback") into
// the Sep 1 provenance vocabulary requested by the spec
// ("BASELINE"|"AI"|"FALLBACK"). No AI/decision logic is duplicated here.
// =============================================================================

import { buildAgentDecisionRequest } from "../ai/requestBuilder.js";
import { resolveRecoveryDecision } from "../ai/decisionAgent.js";
import type { AIProvider } from "../ai/provider.js";
import type { AgentDecisionRequest, AgentDecisionResult, MerchantPolicy } from "../ai/types.js";
import type { AgentPaymentContext } from "../domain/schemas.js";
import type { RecoveryAssessment } from "../assessment/schemas.js";
import type { DecisionSource } from "./types.js";

const SOURCE_MAP: Record<AgentDecisionResult["source"], DecisionSource> = {
  deterministic: "BASELINE",
  provider: "AI",
  fallback: "FALLBACK",
};

export interface ResolvedDecision {
  request: AgentDecisionRequest;
  result: AgentDecisionResult;
  source: DecisionSource;
}

export async function resolveDecision(params: {
  provider: AIProvider;
  context: AgentPaymentContext;
  assessment: RecoveryAssessment;
  merchantPolicy: MerchantPolicy;
}): Promise<ResolvedDecision> {
  const request = buildAgentDecisionRequest({
    context: params.context,
    assessment: params.assessment,
    merchantPolicy: params.merchantPolicy,
  });

  const result = await resolveRecoveryDecision(params.provider, request);

  return { request, result, source: SOURCE_MAP[result.source] };
}
