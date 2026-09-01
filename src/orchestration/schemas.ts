// =============================================================================
// Orchestration schemas (Sep 1)
// =============================================================================
// Zod validation for the structured RecoveryRunResult, reusing existing
// schemas wherever possible (recoveryAssessmentSchema from Day 2,
// agentDecisionSchema from Day 3) rather than re-declaring their shapes.
// =============================================================================

import { z } from "zod";
import { recoveryAssessmentSchema } from "../assessment/schemas.js";
import { agentDecisionSchema, recoveryActionSchema } from "../ai/schemas.js";
import { PAYMENT_STATUSES, RECOVERY_CASE_STATUSES } from "../domain/types.js";
import { ORCHESTRATION_STAGES } from "./types.js";

export const decisionSourceSchema = z.enum(["BASELINE", "AI", "FALLBACK"]);

export const policyDecisionSchema = z.enum(["ALLOW", "MODIFY", "BLOCK", "ESCALATE"]);

export const policyResultSchema = z.object({
  decision: policyDecisionSchema,
  action: recoveryActionSchema.optional(),
  modifiedDecision: agentDecisionSchema.optional(),
  reason: z.string().min(1),
  appliedRules: z.array(z.string()),
});

export const executionStatusSchema = z.enum(["executed", "skipped", "rejected", "pending"]);

export const recoveryExecutionResultSchema = z.object({
  idempotencyKey: z.string().min(1),
  status: executionStatusSchema,
  action: recoveryActionSchema,
  paymentId: z.string().min(1),
  recoveryCaseId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  requestedAt: z.date(),
  executedAt: z.date().nullable(),
  idempotent: z.boolean(),
  rejectionReason: z.string().optional(),
});

export const attemptOutcomeSchema = z.object({
  success: z.boolean(),
  amountRecovered: z.number().int().nonnegative(),
});

export const orchestrationStageSchema = z.enum(ORCHESTRATION_STAGES);

export const recoveryRunResultSchema = z.object({
  paymentId: z.string().min(1),
  assessment: recoveryAssessmentSchema,
  decisionSource: decisionSourceSchema,
  aiDecision: agentDecisionSchema,
  policyResult: policyResultSchema,
  execution: recoveryExecutionResultSchema.nullable(),
  outcome: attemptOutcomeSchema.nullable(),
  finalState: z.object({
    paymentStatus: z.enum(PAYMENT_STATUSES),
    recoveryCaseStatus: z.enum(RECOVERY_CASE_STATUSES).nullable(),
  }),
  stage: orchestrationStageSchema,
  // events: intentionally not deep-validated here (AuditEvent objects are
  // already individually validated by createEvent()/auditEventSchema at
  // construction time — see src/simulation/events.ts).
  events: z.array(z.unknown()),
});
