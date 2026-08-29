// =============================================================================
// Assessment schemas (Aug 30)
// =============================================================================
// Zod schema for the structured RecoveryAssessment output. Deliberately its
// own hand-written object (never `.extend()`-ed from anything containing
// GroundTruth), same isolation pattern as
// src/domain/schemas.ts::agentPaymentContextSchema.
// =============================================================================

import { z } from "zod";
import {
  FAILURE_CATEGORIES,
  RISK_PROFILES,
  MERCHANT_CATEGORIES,
  RECOVERY_CASE_STATUSES,
  BEST_ACTIONS,
} from "../domain/types.js";

export const recoveryFeaturesSchema = z.object({
  paymentId: z.string().min(1),
  failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  riskProfile: z.enum(RISK_PROFILES),
  merchantCategory: z.enum(MERCHANT_CATEGORIES),
  hasOpenCase: z.boolean(),
  recoveryCaseStatus: z.enum(RECOVERY_CASE_STATUSES).nullable(),
  attemptsMade: z.number().int().min(0),
  priorFailureCount: z.number().int().min(0),
  priorSuccessCount: z.number().int().min(0),
  priorBlockedCount: z.number().int().min(0),
  windowRemainingHours: z.number().nullable(),
  hoursSinceCaseOpened: z.number().nullable(),
});

export const candidateActionSchema = z.object({
  action: z.enum(BEST_ACTIONS),
  rationale: z.string().min(1),
  priority: z.number().int().positive(),
});

export const recoveryAssessmentSchema = z.object({
  paymentId: z.string().min(1),
  assessedAt: z.date(),
  engineVersion: z.string().min(1),
  score: z.number().min(0).max(1),
  scoreBand: z.enum(["low", "medium", "high"]),
  features: recoveryFeaturesSchema,
  candidateActions: z.array(candidateActionSchema).min(1),
});

export type RecoveryAssessment = z.infer<typeof recoveryAssessmentSchema>;
