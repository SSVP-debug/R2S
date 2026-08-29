// =============================================================================
// Agent-safe request builder (Aug 31)
// =============================================================================
// Builds the AgentDecisionRequest handed to an AIProvider. Takes an already
// -built AgentPaymentContext (Day 1, ground-truth isolated by construction)
// and RecoveryAssessment (Day 2, ground-truth isolated by construction) —
// this module has NO repository access and NO import of anything from
// src/db/ or src/simulation/groundTruth.ts. It only reshapes already-safe
// data into the AI layer's request shape, then validates the result
// against agentDecisionRequestSchema before returning it.
// =============================================================================

import type { AgentPaymentContext } from "../domain/schemas.js";
import type { RecoveryAssessment } from "../assessment/schemas.js";
import { translateCandidateActions } from "./candidateTranslation.js";
import { agentDecisionRequestSchema } from "./schemas.js";
import type { AgentDecisionRequest, MerchantPolicy } from "./types.js";

export function buildAgentDecisionRequest(params: {
  context: AgentPaymentContext;
  assessment: RecoveryAssessment;
  merchantPolicy: MerchantPolicy;
}): AgentDecisionRequest {
  const { context, assessment, merchantPolicy } = params;

  if (context.paymentId !== assessment.paymentId) {
    throw new Error(
      `buildAgentDecisionRequest(): context.paymentId (${context.paymentId}) does not match assessment.paymentId (${assessment.paymentId})`,
    );
  }

  const request: AgentDecisionRequest = {
    paymentId: context.paymentId,
    context,
    assessmentSummary: {
      score: assessment.score,
      scoreBand: assessment.scoreBand,
    },
    candidateActions: translateCandidateActions(assessment.candidateActions),
    merchantPolicy,
    recoveryHistory: {
      attemptsMade: assessment.features.attemptsMade,
      priorFailureCount: assessment.features.priorFailureCount,
      priorSuccessCount: assessment.features.priorSuccessCount,
      priorBlockedCount: assessment.features.priorBlockedCount,
    },
  };

  return agentDecisionRequestSchema.parse(request);
}
