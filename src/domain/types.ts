// =============================================================================
// R2S domain types
// =============================================================================
// These literal-union types are the actual source of truth for allowed
// enum-like values across the system (Prisma/SQLite store them as plain
// strings — see prisma/schema.prisma note on SQLite enum support).
// =============================================================================

// ---- Merchant -----------------------------------------------------------
export const MERCHANT_CATEGORIES = [
  "ecommerce",
  "subscription",
  "travel",
  "utilities",
  "marketplace",
] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];

export interface Merchant {
  id: string;
  name: string;
  category: MerchantCategory;
  createdAt: Date;
  simulationRunId: string;
}

// ---- Customer -------------------------------------------------------------
export const RISK_PROFILES = ["low", "medium", "high"] as const;
export type RiskProfile = (typeof RISK_PROFILES)[number];

export interface Customer {
  id: string;
  name: string;
  email: string;
  riskProfile: RiskProfile;
  createdAt: Date;
  merchantId: string;
  simulationRunId: string;
}

// ---- Payment ----------------------------------------------------------------
export const PAYMENT_STATUSES = [
  "created",
  "failed",
  "retrying",
  "recovered",
  "failed_final",
  "escalated",
  "stopped",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FAILURE_CATEGORIES = [
  "temporary_bank_failure",
  "insufficient_funds",
  "authentication_failure",
  "invalid_instrument",
  "repeated_failure",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface Payment {
  id: string;
  amount: number; // minor units (paise)
  currency: string;
  status: PaymentStatus;
  failureCategory: FailureCategory | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  merchantId: string;
  customerId: string;
  simulationRunId: string;
}

// ---- RecoveryCase -----------------------------------------------------------
export const RECOVERY_CASE_STATUSES = [
  "open",
  "in_progress",
  "recovered",
  "failed",
  "escalated",
  "stopped",
] as const;
export type RecoveryCaseStatus = (typeof RECOVERY_CASE_STATUSES)[number];

export interface RecoveryCase {
  id: string;
  status: RecoveryCaseStatus;
  openedAt: Date;
  closedAt: Date | null;
  recoveryWindowEndsAt: Date;
  paymentId: string;
  simulationRunId: string;
}

// ---- RecoveryAttempt ----------------------------------------------------------
export const RECOVERY_ATTEMPT_OUTCOMES = [
  "pending",
  "success",
  "failure",
  "blocked",
] as const;
export type RecoveryAttemptOutcome = (typeof RECOVERY_ATTEMPT_OUTCOMES)[number];

export interface RecoveryAttempt {
  id: string;
  attemptNumber: number;
  strategy: string;
  /** Sep 1: which concrete RecoveryAction this attempt represents. Null
   * for Aug 29 baseline-generated attempts (predates this field). */
  action?: string | null;
  /** Sep 1: idempotency key used by the recovery executor. Null for
   * Aug 29 baseline-generated attempts. */
  idempotencyKey?: string | null;
  scheduledAt: Date;
  executedAt: Date | null;
  outcome: RecoveryAttemptOutcome;
  amountRecovered: number | null;
  recoveryCaseId: string;
  simulationRunId: string;
}

// ---- RecoveryPolicy -----------------------------------------------------------
export interface RecoveryPolicy {
  id: string;
  name: string;
  maxRetries: number;
  retryIntervalHours: number[];
  recoveryWindowDays: number;
  createdAt: Date;
}

// ---- Event model --------------------------------------------------------------
export const EVENT_TYPES = [
  "payment_created",
  "payment_failed",
  "recovery_started",
  "recovery_decision",
  "action_requested",
  "action_blocked",
  "action_executed",
  "payment_recovered",
  "recovery_failed",
  "escalation",
  "stopped",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const AUDIT_ENTITY_TYPES = [
  "Payment",
  "RecoveryCase",
  "RecoveryAttempt",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export interface AuditEvent {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
  paymentId: string | null;
  simulationRunId: string;
}

// ---- Hidden ground truth (EVALUATION-ONLY — never agent-facing) ---------------
export const BEST_ACTIONS = [
  "retry_immediate",
  "retry_delayed",
  "prompt_instrument_update",
  "escalate_to_human",
  "no_action",
] as const;
export type BestAction = (typeof BEST_ACTIONS)[number];

export interface GroundTruth {
  id: string;
  paymentId: string;
  recoverable: boolean;
  recoveryProbability: number; // 0..1
  bestAction: BestAction;
  recoveredAmount: number; // minor units
  simulationRunId: string;
}

// ---- Simulation metadata / versioning ------------------------------------------
export interface SimulationRun {
  id: string;
  seed: string;
  generatorVersion: string;
  datasetVersion: string;
  createdAt: Date;
}
