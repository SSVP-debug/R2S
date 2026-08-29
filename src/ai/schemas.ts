// =============================================================================
// AI Decision Agent — schemas (Aug 31)
// =============================================================================
// Validates every AgentDecision returned by any provider (mock or real,
// later) before it is trusted. Rejects unknown actions, out-of-range
// confidence, and malformed/missing conditional fields (delayHours for
// RETRY_LATER, incentivePercent for OFFER_INCENTIVE).
//
// agentDecisionRequestSchema reuses domain/schemas.ts's
// agentPaymentContextSchema for the `context` field — the same
// ground-truth-isolated schema used since Day 1 — so this schema cannot
// accidentally validate a request that carries ground truth.
// =============================================================================

import { z } from "zod";
import { agentPaymentContextSchema } from "../domain/schemas.js";
import { RECOVERY_ACTIONS } from "./types.js";

export const recoveryActionSchema = z.enum(RECOVERY_ACTIONS);

export const agentDecisionSchema = z
  .object({
    action: recoveryActionSchema,
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
    delayHours: z.number().positive().optional(),
    incentivePercent: z.number().min(0).max(100).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === "RETRY_LATER" && val.delayHours === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "delayHours is required when action is RETRY_LATER",
        path: ["delayHours"],
      });
    }
    if (val.action === "OFFER_INCENTIVE" && val.incentivePercent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "incentivePercent is required when action is OFFER_INCENTIVE",
        path: ["incentivePercent"],
      });
    }
  });

export const candidateActionForAISchema = z.object({
  action: recoveryActionSchema,
  rationale: z.string().min(1),
  priority: z.number().int().positive(),
});

export const merchantPolicySchema = z.object({
  maxRetries: z.number().int().positive(),
  recoveryWindowDays: z.number().int().positive(),
  maxIncentivePercent: z.number().min(0).max(100),
  highValueThresholdMinor: z.number().int().positive(),
});

export const assessmentSummarySchema = z.object({
  score: z.number().min(0).max(1),
  scoreBand: z.enum(["low", "medium", "high"]),
});

export const recoveryHistorySummarySchema = z.object({
  attemptsMade: z.number().int().min(0),
  priorFailureCount: z.number().int().min(0),
  priorSuccessCount: z.number().int().min(0),
  priorBlockedCount: z.number().int().min(0),
});

export const agentDecisionRequestSchema = z.object({
  paymentId: z.string().min(1),
  context: agentPaymentContextSchema,
  assessmentSummary: assessmentSummarySchema,
  candidateActions: z.array(candidateActionForAISchema).min(1),
  merchantPolicy: merchantPolicySchema,
  recoveryHistory: recoveryHistorySummarySchema,
});
