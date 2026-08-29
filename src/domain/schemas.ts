// =============================================================================
// R2S Zod schemas
// =============================================================================
// Runtime validation mirroring src/domain/types.ts.
//
// GROUND-TRUTH ISOLATION:
// `agentPaymentContextSchema` is the ONLY schema a future recovery agent may
// ever be given. It is intentionally built as its own object shape (not via
// `.extend()` on anything that includes GroundTruth) so ground-truth fields
// can never leak in through an accidental merge. groundTruthSchema exists
// only for internal simulation/evaluation code and tests.
// =============================================================================

import { z } from "zod";
import {
  MERCHANT_CATEGORIES,
  RISK_PROFILES,
  PAYMENT_STATUSES,
  FAILURE_CATEGORIES,
  RECOVERY_CASE_STATUSES,
  RECOVERY_ATTEMPT_OUTCOMES,
  EVENT_TYPES,
  AUDIT_ENTITY_TYPES,
  BEST_ACTIONS,
} from "./types.js";

export const merchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(MERCHANT_CATEGORIES),
  createdAt: z.date(),
  simulationRunId: z.string().min(1),
});

export const customerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  riskProfile: z.enum(RISK_PROFILES),
  createdAt: z.date(),
  merchantId: z.string().min(1),
  simulationRunId: z.string().min(1),
});

export const paymentSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3),
  status: z.enum(PAYMENT_STATUSES),
  failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  attemptCount: z.number().int().min(0),
  createdAt: z.date(),
  updatedAt: z.date(),
  merchantId: z.string().min(1),
  customerId: z.string().min(1),
  simulationRunId: z.string().min(1),
});

export const recoveryCaseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(RECOVERY_CASE_STATUSES),
  openedAt: z.date(),
  closedAt: z.date().nullable(),
  recoveryWindowEndsAt: z.date(),
  paymentId: z.string().min(1),
  simulationRunId: z.string().min(1),
});

export const recoveryAttemptSchema = z.object({
  id: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  strategy: z.string().min(1),
  scheduledAt: z.date(),
  executedAt: z.date().nullable(),
  outcome: z.enum(RECOVERY_ATTEMPT_OUTCOMES),
  amountRecovered: z.number().int().nonnegative().nullable(),
  recoveryCaseId: z.string().min(1),
  simulationRunId: z.string().min(1),
});

export const recoveryPolicySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxRetries: z.number().int().positive(),
  retryIntervalHours: z.array(z.number().int().positive()),
  recoveryWindowDays: z.number().int().positive(),
  createdAt: z.date(),
});

export const auditEventSchema = z.object({
  id: z.string().min(1),
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.date(),
  paymentId: z.string().min(1).nullable(),
  simulationRunId: z.string().min(1),
});

// ---- Hidden ground truth — internal/evaluation-only. NOT agent-facing. -------
export const groundTruthSchema = z.object({
  id: z.string().min(1),
  paymentId: z.string().min(1),
  recoverable: z.boolean(),
  recoveryProbability: z.number().min(0).max(1),
  bestAction: z.enum(BEST_ACTIONS),
  recoveredAmount: z.number().int().nonnegative(),
  simulationRunId: z.string().min(1),
});

export const simulationRunSchema = z.object({
  id: z.string().min(1),
  seed: z.string().min(1),
  generatorVersion: z.string().min(1),
  datasetVersion: z.string().min(1),
  createdAt: z.date(),
});

// =============================================================================
// AGENT-FACING SCHEMA — the ONLY shape a future recovery agent may see.
// Deliberately hand-written as its own object (never derived from a schema
// that includes GroundTruth) so ground-truth fields cannot leak in.
// =============================================================================
export const agentPaymentContextSchema = z.object({
  paymentId: z.string().min(1),
  amount: z.number().int().positive(),
  currency: z.string().min(3).max(3),
  status: z.enum(PAYMENT_STATUSES),
  failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  attemptCount: z.number().int().min(0),
  createdAt: z.date(),
  updatedAt: z.date(),

  merchant: z.object({
    id: z.string().min(1),
    category: z.enum(MERCHANT_CATEGORIES),
  }),

  customer: z.object({
    id: z.string().min(1),
    // riskProfile is a coarse behavioral signal, not ground truth — it is
    // known ahead of time from the customer's account, unlike recoverability.
    riskProfile: z.enum(RISK_PROFILES),
  }),

  recoveryCase: z
    .object({
      id: z.string().min(1),
      status: z.enum(RECOVERY_CASE_STATUSES),
      openedAt: z.date(),
      recoveryWindowEndsAt: z.date(),
    })
    .nullable(),

  priorAttempts: z.array(
    z.object({
      attemptNumber: z.number().int().positive(),
      strategy: z.string().min(1),
      scheduledAt: z.date(),
      executedAt: z.date().nullable(),
      outcome: z.enum(RECOVERY_ATTEMPT_OUTCOMES),
    }),
  ),
});

export type AgentPaymentContext = z.infer<typeof agentPaymentContextSchema>;

// Field names that must NEVER appear on an agent-facing object. Used by
// structural isolation tests.
export const GROUND_TRUTH_FIELD_NAMES = [
  "recoverable",
  "recoveryProbability",
  "bestAction",
  "recoveredAmount",
] as const;
