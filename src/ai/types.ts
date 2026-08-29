// =============================================================================
// AI Decision Agent — types (Aug 31)
// =============================================================================
// The AI layer is an ADVISOR ONLY. Nothing in src/ai/ ever calls the
// repository, never imports src/simulation/groundTruth.ts, and never
// executes an action. See src/ai/decisionAgent.ts and
// src/policy/policyEngine.ts headers for the full authority model.
// =============================================================================

import type { AgentPaymentContext } from "../domain/schemas.js";

// ---- Recovery action vocabulary (Aug 31) -----------------------------------
// This is a NEW, more concrete action vocabulary than Day 2's abstract
// candidate categories (retry_immediate, retry_delayed, ...). It represents
// the actual tactics a recovery system could take. See
// src/ai/candidateTranslation.ts for how Day 2's candidates map into this
// vocabulary — Day 2's files themselves are unmodified.
export const RECOVERY_ACTIONS = [
  "RETRY_NOW",
  "RETRY_LATER",
  "SEND_PAYMENT_LINK",
  "SEND_REMINDER",
  "OFFER_INCENTIVE",
  "ESCALATE",
  "STOP",
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface CandidateActionForAI {
  action: RecoveryAction;
  rationale: string;
  /** 1 = most recommended. Lower is higher priority. */
  priority: number;
}

export interface MerchantPolicy {
  maxRetries: number;
  recoveryWindowDays: number;
  /** Maximum incentive percentage a merchant allows without escalation. */
  maxIncentivePercent: number;
  /** Payment amount (minor units) at/above which incentive offers require
   * human escalation, regardless of the incentive size. */
  highValueThresholdMinor: number;
}

export interface AssessmentSummary {
  score: number;
  scoreBand: "low" | "medium" | "high";
}

export interface RecoveryHistorySummary {
  attemptsMade: number;
  priorFailureCount: number;
  priorSuccessCount: number;
  priorBlockedCount: number;
}

/**
 * Everything the AI is allowed to see, and nothing more. Structurally
 * cannot carry ground truth: `context` is Day 1's AgentPaymentContext
 * (already isolated), and every other field here is either a plain
 * summary number/string or drawn from Day 2's already-isolated
 * RecoveryFeatures / CandidateAction.
 */
export interface AgentDecisionRequest {
  paymentId: string;
  context: AgentPaymentContext;
  assessmentSummary: AssessmentSummary;
  candidateActions: CandidateActionForAI[];
  merchantPolicy: MerchantPolicy;
  recoveryHistory: RecoveryHistorySummary;
}

/** What a provider (mock or, later, real) returns. */
export interface AgentDecision {
  action: RecoveryAction;
  /** 0..1 */
  confidence: number;
  reasoning: string;
  /** Required when action === "RETRY_LATER". */
  delayHours?: number;
  /** Required when action === "OFFER_INCENTIVE". 0..100. */
  incentivePercent?: number;
}

/** The result of running the decision agent: either the provider's
 * validated decision, or a safe deterministic fallback if anything about
 * the provider's output couldn't be trusted. */
export interface AgentDecisionResult {
  paymentId: string;
  decision: AgentDecision;
  source: "provider" | "fallback" | "deterministic";
  /** Present when source === "fallback". */
  fallbackReason?: string;
}
