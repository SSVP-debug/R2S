// =============================================================================
// Orchestration types (Sep 1)
// =============================================================================
// These types describe the ORCHESTRATOR's own procedural pipeline
// (OrchestrationStage) and its structured output (RecoveryRunResult) — a
// different axis entirely from the domain entity statuses already defined
// in src/domain/types.ts (PaymentStatus, RecoveryCaseStatus). This is not
// a "parallel state definition" for Payment/RecoveryCase: no value here
// overlaps with, replaces, or is compared against PaymentStatus/
// RecoveryCaseStatus. Those remain the sole source of truth for entity
// state, updated only through src/simulation/stateMachine.ts's existing
// transition functions (see src/orchestration/lifecycle.ts).
// =============================================================================

import type {
  AuditEvent,
  PaymentStatus,
  RecoveryCaseStatus,
} from "../domain/types.js";
import type { RecoveryAssessment } from "../assessment/schemas.js";
import type { AgentDecision } from "../ai/types.js";
import type { PolicyResult } from "../policy/types.js";
import type { RecoveryExecutionResult } from "../execution/recoveryExecutor.js";
import type { AttemptOutcome } from "../outcome/simulateOutcome.js";

/** The orchestrator's own procedural progress through a single run. Not a
 * persisted entity status — see file header. */
export const ORCHESTRATION_STAGES = [
  "recovery_pending",
  "decision_made",
  "policy_evaluated",
  "action_executed",
  "outcome_evaluated",
  "completed",
] as const;
export type OrchestrationStage = (typeof ORCHESTRATION_STAGES)[number];

/** Where the accepted AI decision actually came from. "BASELINE" = the
 * cost-control deterministic path (single unambiguous candidate, no AI
 * call made — see src/ai/decisionAgent.ts::shouldCallAI). "AI" = a real
 * (mock, today) provider call whose output passed validation. "FALLBACK"
 * = the provider was unavailable, invalid, or violated the candidate
 * constraint, and a safe deterministic fallback was used instead. */
export type DecisionSource = "BASELINE" | "AI" | "FALLBACK";

export interface RecoveryRunResult {
  paymentId: string;
  assessment: RecoveryAssessment;
  decisionSource: DecisionSource;
  aiDecision: AgentDecision;
  policyResult: PolicyResult;
  /** Null when policy BLOCK/ESCALATE meant the executor was never called. */
  execution: RecoveryExecutionResult | null;
  /** Null unless execution.status === "executed" — see
   * src/outcome/simulateOutcome.ts. ACTION EXECUTED ≠ PAYMENT RECOVERED:
   * this is a separate, later determination. */
  outcome: AttemptOutcome | null;
  finalState: {
    paymentStatus: PaymentStatus;
    recoveryCaseStatus: RecoveryCaseStatus | null;
  };
  stage: OrchestrationStage;
  events: AuditEvent[];
}
