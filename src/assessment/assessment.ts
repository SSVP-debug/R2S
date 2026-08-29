// =============================================================================
// Recovery Assessment Engine — structured assessment (Aug 30)
// =============================================================================
// Top-level entry points that tie together:
//   context builder -> feature extraction -> deterministic scoring
//   -> candidate action generation -> structured, validated output.
//
// This is an ANALYSIS-ONLY component:
//   - No AI/LLM anywhere in this module or anything it imports.
//   - No policy: it does not pick a single "the" action, only ranks
//     candidates with rationale.
//   - No executor: it never calls repo.update*/insert* — read-only.
//   - No UI.
//
// GROUND-TRUTH ISOLATION: this file's import list is exhaustive proof of
// isolation — it imports contextBuilder, features, scoring,
// candidateActions, schemas, and versioning. None of those import
// src/simulation/groundTruth.ts, and this file does not either.
// =============================================================================

import type { R2SRepository } from "../db/repository.js";
import type { AgentPaymentContext } from "../domain/schemas.js";
import { buildAssessmentContext } from "./contextBuilder.js";
import { extractFeatures } from "./features.js";
import { computeRecoveryScore, scoreBand } from "./scoring.js";
import { generateCandidateActions } from "./candidateActions.js";
import { recoveryAssessmentSchema, type RecoveryAssessment } from "./schemas.js";
import { ASSESSMENT_ENGINE_VERSION } from "../meta/versioning.js";

/**
 * Builds a structured RecoveryAssessment directly from an already-built
 * AgentPaymentContext. Useful when the caller already has the context
 * (e.g. tests, or future callers batching multiple assessments).
 */
export function assessFromContext(
  context: AgentPaymentContext,
  now: Date,
): RecoveryAssessment {
  const features = extractFeatures(context, now);
  const score = computeRecoveryScore(features);
  const candidateActions = generateCandidateActions(features, score);

  const assessment: RecoveryAssessment = {
    paymentId: context.paymentId,
    assessedAt: now,
    engineVersion: ASSESSMENT_ENGINE_VERSION,
    score,
    scoreBand: scoreBand(score),
    features,
    candidateActions,
  };

  return recoveryAssessmentSchema.parse(assessment);
}

/**
 * Convenience entry point: builds the context for `paymentId` from the
 * repository, then produces a structured assessment.
 */
export function assessPayment(
  repo: R2SRepository,
  paymentId: string,
  now: Date,
): RecoveryAssessment {
  const context = buildAssessmentContext(repo, paymentId);
  return assessFromContext(context, now);
}
